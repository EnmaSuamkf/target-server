/**
 * Background exporter: drains each organization's outbox to its OTLP backend.
 *
 * One `runOnce()` pass visits every active organization. An organization whose
 * exporter is off costs one single-row read and nothing else. For an enabled
 * one it prunes old rows, claims due rows in batches, loads the events, builds
 * traces and metrics (otel.mjs) with the org's pricing rules and export state,
 * sends them (otel-client.mjs, one attempt per pass; retries are rescheduled
 * through `next_attempt_at`), and on success marks the rows sent and writes the
 * new export state in ONE transaction (db.markOtelSent).
 *
 * Delivery is at-least-once. Traces carry deterministic ids, so a re-send is
 * harmless. Metrics are DELTA sums with no idempotency key in OTLP: if the
 * process dies after the destination accepted a request but before the commit,
 * the next pass re-sends that same batch (same deltas, computed from the
 * unchanged state, never doubled) and the destination counts it twice. The
 * export state itself is never advanced without the rows being marked sent.
 * A down destination only delays this worker; /ingest never waits for it.
 */
import { listOrganizations } from "./control-plane.mjs";
import {
	DEFAULT_ORG_ID,
	claimOtelOutboxBatch,
	currentOrganization,
	getOtelConfig,
	getOtelExportState,
	listPricingRules,
	loadOtelEvents,
	markOtelDead,
	markOtelRetry,
	markOtelSent,
	otelRunnersByWorkflow,
	pruneOtelOutbox,
	recordOtelResult,
	runWithOrg,
} from "./db.mjs";
import { buildMetrics, buildTraces } from "./otel.mjs";
import { sendOtlp } from "./otel-client.mjs";
import { noRedirectFetch, validateOtelEndpoint } from "./otel-endpoint.mjs";

/** The event kinds the exporter uses; everything else is never enqueued. */
export const OTEL_EXPORT_KINDS = Object.freeze(
	new Set(["workflow.created", "workflow.status_changed", "step.started", "step.done", "step.failed", "step.judged", "usage.snapshot"]),
);

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const BACKOFF_BASE_S = 10;
const BACKOFF_MAX_S = 300;

const positive = (value, fallback) => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Interval in ms from TARGET_OTEL_INTERVAL_SECONDS (default 10); "0" disables the timer. */
export function otelIntervalMs(env = process.env) {
	if (env.TARGET_OTEL_INTERVAL_SECONDS === "0") return 0;
	return positive(env.TARGET_OTEL_INTERVAL_SECONDS, 10) * 1000;
}

export const otelMaxAgeDays = (env = process.env) => positive(env.TARGET_OTEL_OUTBOX_MAX_AGE_DAYS, 7);

/** Failed attempt number `attempts` (0-based) → seconds to wait: 10, 20, 40 … capped at 5 min. */
export const backoffSeconds = (attempts) => Math.min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2 ** Math.min(attempts, 10));

function activeOrgIds() {
	const ids = listOrganizations()
		.filter((o) => o.status === "active")
		.map((o) => o.id);
	return ids.length ? ids : [DEFAULT_ORG_ID];
}

export function createOtelWorker({
	fetchImpl = noRedirectFetch,
	now = () => new Date(),
	intervalMs = otelIntervalMs(),
	batchSize = 200,
	maxBatchesPerOrg = 5,
	serviceVersion = null,
	log = () => {},
	/** Test hook: runs after a successful send and before the rows are marked sent. */
	beforeCommit = null,
	listOrgIds = activeOrgIds,
} = {}) {
	let timer = null;
	let running = null;

	/** Send one signal; returns null on success or `{error, retryable}`. */
	async function deliver(config, endpoint, signal, body) {
		const sent = await sendOtlp({
			endpoint,
			signal,
			body,
			headers: config.headers,
			maxAttempts: 1,
			fetchImpl,
		});
		if (sent.partialSuccess) {
			log(`otel: ${signal} partially rejected (${sent.partialSuccess.rejectedSpans} spans, ${sent.partialSuccess.rejectedDataPoints} data points)`);
		}
		if (sent.ok) return null;
		return { error: `${signal}: ${sent.error}`, retryable: sent.status === null || RETRYABLE_STATUSES.has(sent.status) };
	}

	async function processOrg() {
		const config = getOtelConfig({ includeSecrets: true });
		if (!config?.enabled) return { orgSkipped: true };
		const clock = () => now().toISOString();
		pruneOtelOutbox(otelMaxAgeDays(), now());

		const stored = getOtelConfig();
		if (Object.keys(config.headers).length < stored.headers.length) {
			recordOtelResult({ ok: false, error: "stored headers cannot be decrypted with the configured key", at: clock() });
			return { sent: 0, failed: 0, blocked: true };
		}
		const check = await validateOtelEndpoint(config.endpoint);
		if (!check.ok) {
			recordOtelResult({ ok: false, error: check.code, at: clock() });
			return { sent: 0, failed: 0, blocked: true };
		}

		const totals = { sent: 0, failed: 0 };
		for (let batchNo = 0; batchNo < maxBatchesPerOrg; batchNo++) {
			const rows = claimOtelOutboxBatch(batchSize, clock());
			if (rows.length === 0) break;
			const ids = rows.map((r) => r.id);
			const events = loadOtelEvents(rows.map((r) => r.eventId)).filter((e) => !config.enabledAt || String(e.received_at) >= config.enabledAt);
			const { id: orgId, name: orgName } = currentOrganization();
			const runners = otelRunnersByWorkflow(events.map((e) => e.workflow_id));
			const rules = listPricingRules();

			let traces = null;
			if (config.signals.includes("traces")) {
				const options = { rules, sendContent: config.sendContent, langfuse: config.langfuseAttrs, orgName };
				if (config.langfuseAttrs) {
					// langfuse.user.id is per sender, so build one request per instance and merge the spans.
					const byInstance = new Map();
					for (const e of events) byInstance.set(e.instance_id, [...(byInstance.get(e.instance_id) ?? []), e]);
					const spans = [];
					let template = null;
					for (const group of byInstance.values()) {
						const body = buildTraces({ events: group, orgId, serviceVersion, runnerByWorkflow: runners, options: { ...options, userId: group[0].user_name ?? null } });
						if (!body) continue;
						template ??= body;
						spans.push(...body.resourceSpans[0].scopeSpans[0].spans);
					}
					if (template) {
						template.resourceSpans[0].scopeSpans[0].spans = spans;
						traces = template;
					}
				} else {
					traces = buildTraces({ events, orgId, serviceVersion, runnerByWorkflow: runners, options });
				}
			}

			let metrics = null;
			let states = [];
			if (config.signals.includes("metrics")) {
				const snapshots = events.filter((e) => e.kind === "usage.snapshot" && e.workflow_id);
				const stateBySession = {};
				for (const e of snapshots) {
					const key = `${e.workflow_id}:${e.session_id ?? ""}`;
					const state = getOtelExportState(e.workflow_id, e.session_id ?? null);
					if (state) stateBySession[key] = state;
				}
				const built = buildMetrics({ events, orgId, serviceVersion, stateBySession, rules, runnerByWorkflow: runners, options: { sendContent: config.sendContent, orgName } });
				metrics = built.request;
				const seen = new Set();
				for (const e of snapshots) {
					const key = `${e.workflow_id}:${e.session_id ?? ""}`;
					if (seen.has(key) || !built.state[key]) continue;
					seen.add(key);
					states.push({ workflowId: e.workflow_id, sessionId: e.session_id ?? null, state: built.state[key] });
				}
			}

			let failure = null;
			if (traces) failure = await deliver(config, check.url, "traces", traces);
			if (!failure && metrics) failure = await deliver(config, check.url, "metrics", metrics);

			if (failure) {
				totals.failed += ids.length;
				if (failure.retryable) {
					const wait = backoffSeconds(Math.max(...rows.map((r) => r.attempts)));
					markOtelRetry(ids, new Date(now().getTime() + wait * 1000).toISOString());
				} else {
					markOtelDead(ids);
				}
				recordOtelResult({ ok: false, error: failure.error, at: clock() });
				log(`otel: delivery failed (${failure.error}), ${failure.retryable ? "will retry" : "rows marked dead"}`);
				break;
			}
			if (beforeCommit) await beforeCommit({ rows, traces, metrics });
			markOtelSent(ids, states);
			totals.sent += ids.length;
			if (traces || metrics) recordOtelResult({ ok: true, at: clock() });
		}
		return totals;
	}

	/** One pass over every organization. Errors in one organization never stop the others. */
	async function runOnce() {
		if (running) return running;
		running = (async () => {
			const summary = { orgs: 0, sent: 0, failed: 0 };
			for (const orgId of listOrgIds()) {
				try {
					const r = await runWithOrg(orgId, processOrg);
					if (r.orgSkipped) continue;
					summary.orgs++;
					summary.sent += r.sent ?? 0;
					summary.failed += r.failed ?? 0;
				} catch (err) {
					log(`otel: worker error for organization ${orgId}: ${err?.code ?? err?.name ?? "error"}`);
				}
			}
			return summary;
		})().finally(() => {
			running = null;
		});
		return running;
	}

	function start() {
		if (timer || intervalMs <= 0) return false;
		timer = setInterval(() => {
			runOnce().catch(() => {});
		}, intervalMs);
		timer.unref?.();
		return true;
	}

	async function stop() {
		if (timer) clearInterval(timer);
		timer = null;
		await running?.catch(() => {});
	}

	return { runOnce, start, stop, get started() { return timer !== null; } };
}
