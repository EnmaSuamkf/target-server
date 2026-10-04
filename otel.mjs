/**
 * OTLP/JSON mapping core: pure functions, no storage and no I/O.
 *
 * Encoding rules, deterministic ids and the trace builder; the contract is
 * docs/observability/otel-mapping.md. Encoding follows the OTLP JSON mapping and
 * what docs/observability/phase0-findings.md verified: hex ids, integer enums,
 * lowerCamelCase keys, and every nanosecond timestamp or 64-bit integer as a
 * decimal STRING (a ns epoch exceeds 2^53 and would lose precision as a number).
 */
import { createHash } from "node:crypto";
import { normalizeUsageSnapshot } from "./db.mjs";
import { priceSession } from "./pricing.mjs";

export const SPAN_KIND_INTERNAL = 1;
export const STATUS_UNSET = 0;
export const STATUS_OK = 1;
export const STATUS_ERROR = 2;
export const TEMPORALITY_DELTA = 1;
export const TEMPORALITY_CUMULATIVE = 2;

export const SERVICE_NAME = "target-server";
export const SCOPE_NAME = "target-server.otel";

const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

/** One workflow = one trace: first 16 bytes of sha256, as 32 lowercase hex chars. */
export function traceIdFor(workflowId) {
	return sha256Hex(`target:trace:${workflowId}`).slice(0, 32);
}

/**
 * First 8 bytes of sha256 as 16 lowercase hex chars. `key` is the workflow id
 * (root), `workflow:step:attempt` (step) or `workflow:session` (session), so a
 * re-send gets the same id and spans may arrive in any order.
 */
export function spanIdFor(key) {
	const id = sha256Hex(`target:span:${key}`).slice(0, 16);
	// An all-zero span id is invalid in OTLP; practically unreachable.
	return id === "0000000000000000" ? "0000000000000001" : id;
}

export const rootSpanId = (workflowId) => spanIdFor(workflowId);
export const stepSpanId = (workflowId, stepId, attempt) => spanIdFor(`${workflowId}:${stepId}:${attempt}`);
export const sessionSpanId = (workflowId, sessionId) => spanIdFor(`${workflowId}:${sessionId ?? ""}`);

/**
 * ISO string, Date or epoch ms → unixNano as a decimal string, or null when it
 * cannot be parsed. Millisecond precision is kept; BigInt avoids the 2^53 limit.
 */
export function toUnixNano(instant) {
	const ms = instant instanceof Date ? instant.getTime() : typeof instant === "number" ? instant : Date.parse(instant);
	if (!Number.isFinite(ms)) return null;
	return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

/**
 * One OTLP AnyValue, or null for values that are not exported (null,
 * undefined, NaN, Infinity, objects). Integers become `intValue` strings.
 */
export function anyValue(value) {
	switch (typeof value) {
		case "string":
			return { stringValue: value };
		case "boolean":
			return { boolValue: value };
		case "bigint":
			return { intValue: value.toString() };
		case "number":
			if (!Number.isFinite(value)) return null;
			return Number.isInteger(value) ? { intValue: BigInt(value).toString() } : { doubleValue: value };
		default:
			return null;
	}
}

/** `{key, value}` for one attribute, or null when the value is skipped. */
export function attr(key, value) {
	const v = anyValue(value);
	return v ? { key, value: v } : null;
}

/** Plain object → OTLP attribute list, skipping null/undefined values. */
export function attrs(object) {
	const list = [];
	for (const [key, value] of Object.entries(object ?? {})) {
		const a = attr(key, value);
		if (a) list.push(a);
	}
	return list;
}

/** The resource block shared by traces and metrics. */
export function resourceBlock({ org, orgName, serviceVersion } = {}) {
	return { attributes: attrs({ "service.name": SERVICE_NAME, "service.version": serviceVersion, "target.org": org, "target.org.name": orgName }) };
}

/** The instrumentation scope block. */
export function scopeBlock({ serviceVersion } = {}) {
	const scope = { name: SCOPE_NAME };
	if (serviceVersion) scope.version = serviceVersion;
	return scope;
}

// ---------------------------------------------------------------- traces

/** A double attribute; `attr` would turn a whole number like 1 into an intValue. */
const dbl = (key, value) => (typeof value === "number" && Number.isFinite(value) ? { key, value: { doubleValue: value } } : null);

const compact = (list) => list.filter(Boolean);

/** `data` arrives as an object, or as the raw JSON column. */
function dataOf(row) {
	const d = row.data;
	if (d && typeof d === "object") return d;
	if (typeof d === "string") {
		try {
			const parsed = JSON.parse(d);
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}
	return {};
}

/** The event's own time wins over the time the server received it. */
const eventNano = (row) => toUnixNano(row.created_at ?? row.received_at);

const byReceived = (a, b) => {
	const x = String(a.received_at ?? a.created_at ?? "");
	const y = String(b.received_at ?? b.created_at ?? "");
	return x < y ? -1 : x > y ? 1 : String(a.id ?? "") < String(b.id ?? "") ? -1 : 1;
};

const bigMin = (a, b) => (BigInt(a) <= BigInt(b) ? a : b);

/**
 * The only vendor-specific attributes (options.langfuse). Langfuse reads
 * model, usage and cost from the observation attributes, not from gen_ai.*,
 * and only maps them on a "generation" span.
 */
export function langfuseAttributes(kind, ctx) {
	const list = [];
	if (kind === "root" || kind === "session") {
		list.push(attr("langfuse.user.id", ctx.userId), attr("langfuse.session.id", ctx.workflowId));
	}
	if (kind === "root") list.push(attr("langfuse.trace.name", ctx.name));
	if (kind === "session") {
		const u = ctx.usage;
		list.push(
			attr("langfuse.observation.type", "generation"),
			attr(
				"langfuse.observation.usage_details",
				JSON.stringify({
					input: u.inputTokens,
					output: u.outputTokens,
					cache_read_input_tokens: u.cacheRead,
					cache_creation_input_tokens: u.cacheCreation,
				}),
			),
			typeof ctx.costUsd === "number" ? attr("langfuse.observation.cost_details", JSON.stringify({ total: ctx.costUsd })) : null,
		);
	}
	return compact(list);
}

/** Step spans and their `step.judged` events for one workflow. */
function buildStepSpans(workflowId, events, traceId, parentSpanId) {
	const attemptOf = new Map(); // step_id → attempt of the latest step.started
	const phaseOf = new Map();
	const startedAt = new Map();
	const spans = new Map(); // spanId → span; a repeated (step, attempt) keeps the later one
	const byStep = new Map(); // step_id → spans, to attach judgements

	for (const row of events) {
		const d = dataOf(row);
		if (row.kind === "step.started") {
			attemptOf.set(d.step_id, Number.isInteger(d.attempt) ? d.attempt : 0);
			phaseOf.set(d.step_id, d.phase);
			startedAt.set(d.step_id, eventNano(row));
			continue;
		}
		if (row.kind !== "step.done" && row.kind !== "step.failed") continue;
		const end = eventNano(row);
		if (end === null || d.step_id == null) continue;
		const failed = row.kind === "step.failed";
		const attempt = attemptOf.get(d.step_id) ?? 0;
		const duration = typeof d.duration_ms === "number" && d.duration_ms >= 0 ? BigInt(Math.trunc(d.duration_ms)) * 1_000_000n : null;
		const start = duration !== null ? (BigInt(end) - duration).toString() : (startedAt.get(d.step_id) ?? end);
		const index = Number.isInteger(d.order_index) ? d.order_index : 0;
		const span = {
			traceId,
			spanId: stepSpanId(workflowId, d.step_id, attempt),
			parentSpanId,
			name: `step ${index + 1}`,
			kind: SPAN_KIND_INTERNAL,
			startTimeUnixNano: start,
			endTimeUnixNano: end,
			attributes: attrs({
				"target.workflow.id": workflowId,
				"target.step.id": d.step_id,
				"target.step.index": index,
				"target.step.phase": d.phase ?? phaseOf.get(d.step_id),
				"target.step.attempt": attempt,
				"target.step.retry_count": Number.isInteger(d.retry_count) ? d.retry_count : 0,
				"target.step.status": failed ? "failed" : "done",
				// Only the error kind: messages are free text and never leave the server.
				"target.error.kind": failed ? d.error?.kind : undefined,
			}),
			status: { code: failed ? STATUS_ERROR : STATUS_OK },
		};
		spans.set(span.spanId, span);
		const list = byStep.get(d.step_id) ?? [];
		list.push({ span, attempt, index });
		byStep.set(d.step_id, list);
	}

	for (const row of events) {
		if (row.kind !== "step.judged") continue;
		const d = dataOf(row);
		const time = eventNano(row);
		const candidates = byStep.get(d.step_id);
		if (!candidates || time === null || typeof d.ok !== "boolean") continue;
		const target = candidates.reduce((a, b) => (b.attempt >= a.attempt ? b : a));
		(target.span.events ??= []).push({ timeUnixNano: time, name: "step.judged", attributes: attrs({ "target.step.judge.ok": d.ok }) });
	}

	const list = [...spans.values()];
	for (const span of list) span.events?.sort((a, b) => (BigInt(a.timeUnixNano) < BigInt(b.timeUnixNano) ? -1 : 1));
	const order = (s) => [s.attributes.find((a) => a.key === "target.step.index").value.intValue, s.attributes.find((a) => a.key === "target.step.attempt").value.intValue];
	return list.sort((a, b) => Number(order(a)[0]) - Number(order(b)[0]) || Number(order(a)[1]) - Number(order(b)[1]));
}

/** One span per session, from its first and last usage.snapshot. */
function buildSessionSpans(workflowId, events, traceId, parentSpanId, ctx) {
	const sessions = new Map();
	for (const row of events) {
		if (row.kind !== "usage.snapshot") continue;
		const key = row.session_id ?? "";
		const time = eventNano(row);
		if (time === null) continue;
		const s = sessions.get(key);
		if (!s) sessions.set(key, { sessionId: row.session_id ?? null, first: time, lastTime: time, last: row });
		else {
			s.first = bigMin(s.first, time);
			if (BigInt(time) >= BigInt(s.lastTime)) {
				s.lastTime = time;
				s.last = row;
			}
		}
	}

	const out = [];
	for (const s of sessions.values()) {
		const data = dataOf(s.last);
		// A snapshot is a running total: only the LAST one of a session counts.
		const usage = normalizeUsageSnapshot(data);
		const runner = (typeof data.agent === "string" && data.agent) || ctx.runner || null;
		const priced = priceSession(ctx.rules, { agent: runner, at: s.last.received_at ?? s.last.created_at, usage });
		const model = usage.model;
		const langfuse = ctx.langfuse
			? langfuseAttributes("session", { userId: ctx.userId, workflowId, usage, costUsd: priced.costUsd })
			: [];
		out.push({
			usage,
			priced,
			span: {
				traceId,
				spanId: sessionSpanId(workflowId, s.sessionId),
				parentSpanId,
				// Langfuse drops model/usage/cost on invoke_agent spans, so it gets "chat".
				name: ctx.langfuse ? `chat ${model ?? runner ?? "agent"}` : `invoke_agent${runner ? ` ${runner}` : ""}`,
				kind: SPAN_KIND_INTERNAL,
				startTimeUnixNano: s.first,
				endTimeUnixNano: s.lastTime,
				attributes: [
					...attrs({
						"gen_ai.operation.name": ctx.langfuse ? "chat" : "invoke_agent",
						"gen_ai.provider.name": runner ?? "unknown",
						"gen_ai.conversation.id": s.sessionId,
						"gen_ai.request.model": model,
						"gen_ai.usage.input_tokens": usage.inputTokens,
						"gen_ai.usage.output_tokens": usage.outputTokens,
						"gen_ai.usage.cache_read.input_tokens": usage.cacheRead,
						"gen_ai.usage.cache_write.input_tokens": usage.cacheCreation,
						"target.runner": runner,
						"target.workflow.id": workflowId,
					}),
					...compact([dbl("target.cost.usd", priced.costUsd)]),
					...attrs({ "target.cost.partial": priced.costUsd === null, "target.cost.source": priced.source }),
					...langfuse,
				],
				status: { code: STATUS_UNSET },
			},
		});
	}
	return out.sort((a, b) => (BigInt(a.span.startTimeUnixNano) < BigInt(b.span.startTimeUnixNano) ? -1 : 1));
}

/** The root span, or null while the workflow has no terminal status event. */
function buildRootSpan(workflowId, events, traceId, sessions, ctx) {
	let created = null;
	let firstStart = null;
	let terminal = null;
	for (const row of events) {
		const d = dataOf(row);
		if (row.kind === "workflow.created" && !created) created = row;
		else if (row.kind === "step.started" && !firstStart) firstStart = row;
		else if (row.kind === "workflow.status_changed" && (d.to === "completed" || d.to === "failed")) terminal = row;
	}
	if (!terminal) return null;
	const end = eventNano(terminal);
	const start = eventNano(created ?? firstStart ?? terminal);
	if (end === null || start === null) return null;
	const status = dataOf(terminal).to;
	const createdData = created ? dataOf(created) : {};
	const name = ctx.sendContent ? `invoke_workflow ${createdData.name ?? "workflow"}` : "invoke_workflow";

	const priced = sessions.filter((s) => typeof s.priced.costUsd === "number");
	const sum = (field) => sessions.reduce((n, s) => n + s.usage[field], 0);
	return {
		traceId,
		spanId: rootSpanId(workflowId),
		name,
		kind: SPAN_KIND_INTERNAL,
		startTimeUnixNano: bigMin(start, end),
		endTimeUnixNano: end,
		attributes: [
			...attrs({
				"gen_ai.operation.name": "invoke_workflow",
				"target.workflow.id": workflowId,
				"target.workflow.name": ctx.sendContent ? createdData.name : undefined,
				"target.runner": ctx.runner,
				"target.workflow.status": status,
				"target.workflow.step_count": Number.isInteger(createdData.step_count) ? createdData.step_count : undefined,
			}),
			...(priced.length ? compact([dbl("target.cost.usd", priced.reduce((n, s) => n + s.priced.costUsd, 0))]) : []),
			...(sessions.length
				? attrs({
						"target.cost.partial": priced.length < sessions.length,
						"target.usage.input_tokens": sum("inputTokens"),
						"target.usage.output_tokens": sum("outputTokens"),
						"target.usage.cache_read_tokens": sum("cacheRead"),
						"target.usage.cache_creation_tokens": sum("cacheCreation"),
					})
				: []),
			...(ctx.langfuse ? langfuseAttributes("root", { userId: ctx.userId, workflowId, name }) : []),
		],
		status: { code: status === "failed" ? STATUS_ERROR : STATUS_OK },
	};
}

/**
 * Event rows → an ExportTraceServiceRequest body, or null when there is
 * nothing to send. `options`: `{rules, sendContent, langfuse, userId, orgName}`;
 * `orgName` is exported as target.org.name only when `sendContent` is true.
 * `runnerByWorkflow` is the fallback runner when an event does not name one.
 */
export function buildTraces({ events, orgId, serviceVersion, runnerByWorkflow = {}, options = {} } = {}) {
	const { rules = [], sendContent = false, langfuse = false, userId = null, orgName = null } = options;
	const perWorkflow = new Map();
	for (const row of [...(events ?? [])].sort(byReceived)) {
		if (!row.workflow_id) continue;
		const list = perWorkflow.get(row.workflow_id) ?? [];
		list.push(row);
		perWorkflow.set(row.workflow_id, list);
	}

	const spans = [];
	for (const [workflowId, rows] of perWorkflow) {
		const traceId = traceIdFor(workflowId);
		const rootId = rootSpanId(workflowId);
		const created = rows.find((r) => r.kind === "workflow.created");
		const runner = (created && dataOf(created).agent) || runnerByWorkflow[workflowId] || null;
		const ctx = { runner, rules, sendContent, langfuse, userId };
		const sessions = buildSessionSpans(workflowId, rows, traceId, rootId, ctx);
		const root = buildRootSpan(workflowId, rows, traceId, sessions, ctx);
		if (root) spans.push(root);
		spans.push(...buildStepSpans(workflowId, rows, traceId, rootId));
		spans.push(...sessions.map((s) => s.span));
	}
	if (spans.length === 0) return null;
	return {
		resourceSpans: [
			{
				resource: resourceBlock({ org: orgId, orgName: sendContent ? (orgName ?? orgId) : undefined, serviceVersion }),
				scopeSpans: [{ scope: scopeBlock({ serviceVersion }), spans }],
			},
		],
	};
}

// ---------------------------------------------------------------- usage and metrics

/** Token buckets, as `token.type` values. They are disjoint, so they never double count. */
const TOKEN_TYPES = ["input", "output", "cache_read", "cache_creation"];

/** Explicit histogram bounds for target.step.duration, in seconds. */
export const STEP_DURATION_BOUNDS = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];

const zeroState = () => ({ tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, costUsd: 0 });

/**
 * What one `usage.snapshot` adds on top of what was already exported for its
 * session. A snapshot is a running TOTAL, so the cost is priced once on that
 * cumulative total and the delta is "cumulative cost - cost already exported";
 * snapshots are never priced one by one and never summed.
 *
 * `previousState` is the `nextState` of the last call for this session (null
 * the first time). A total that went DOWN (context compaction, a reset
 * session) gives a delta of 0, never a negative one, and becomes the new state.
 * Unpriced: tokens still count, no cost delta, `partial` is true and the
 * exported cost stays put, so a later rule covers everything not yet exported.
 */
export function computeUsageDelta({ previousState = null, snapshot, rules = [], agent = null, at = null } = {}) {
	const prev = { ...zeroState(), ...previousState, tokens: { ...zeroState().tokens, ...previousState?.tokens } };
	const usage = normalizeUsageSnapshot(snapshot);
	const current = {
		input: usage.inputTokensUncached,
		output: usage.outputTokens,
		cache_read: usage.cacheRead,
		cache_creation: usage.cacheCreation,
	};
	const tokens = {};
	for (const type of TOKEN_TYPES) tokens[type] = Math.max(0, current[type] - prev.tokens[type]);

	const priced = priceSession(rules, { agent, at, usage });
	const known = typeof priced.costUsd === "number";
	return {
		tokens,
		costDeltaUsd: known ? Math.max(0, priced.costUsd - prev.costUsd) : null,
		costSource: priced.source,
		partial: !known,
		model: usage.model,
		nextState: { tokens: current, costUsd: known ? priced.costUsd : prev.costUsd },
	};
}

const HISTOGRAM_BUCKETS = STEP_DURATION_BOUNDS.length + 1;

/** Delta accumulator: one data point per (metric, attribute set). */
function createAccumulator() {
	const sums = new Map();
	const histograms = new Map();
	const slot = (map, name, attributes, make) => {
		const key = `${name}|${JSON.stringify(attributes)}`;
		if (!map.has(key)) map.set(key, { name, attributes, ...make() });
		return map.get(key);
	};
	return {
		sums,
		histograms,
		add(name, attributes, value) {
			if (value > 0) slot(sums, name, attributes, () => ({ value: 0 })).value += value;
		},
		observe(name, attributes, seconds) {
			const h = slot(histograms, name, attributes, () => ({ count: 0, sum: 0, min: seconds, max: seconds, buckets: new Array(HISTOGRAM_BUCKETS).fill(0) }));
			const i = STEP_DURATION_BOUNDS.findIndex((bound) => seconds <= bound);
			h.buckets[i === -1 ? HISTOGRAM_BUCKETS - 1 : i] += 1;
			h.count += 1;
			h.sum += seconds;
			h.min = Math.min(h.min, seconds);
			h.max = Math.max(h.max, seconds);
		},
	};
}

const SUM_METRICS = {
	"target.tokens": { unit: "{token}", description: "Tokens consumed by agent sessions", double: false },
	"target.cost.usd": { unit: "USD", description: "Cost of agent sessions, priced with the organization's rules", double: true },
	"target.step.retries": { unit: "{retry}", description: "Step retries", double: false },
	"target.workflow.completed": { unit: "{workflow}", description: "Workflows that completed", double: false },
	"target.workflow.failed": { unit: "{workflow}", description: "Workflows that failed", double: false },
};

/**
 * Fold this batch's deltas into the persisted running totals (cumulative mode).
 * Returns the full updated series map (`seriesByKey` is not mutated) and the
 * keys this batch touched. A series' start time is fixed when it is first seen,
 * so the destination never mistakes a later batch for a counter reset.
 */
function mergeSeries(seriesByKey, acc, startTimeUnixNano) {
	const series = { ...seriesByKey };
	const changed = [];
	const key = (item) => `${item.name}|${JSON.stringify(item.attributes)}`;
	for (const item of acc.sums.values()) {
		const k = key(item);
		const prev = series[k];
		series[k] = { key: k, kind: "sum", name: item.name, attributes: item.attributes, value: (prev?.value ?? 0) + item.value, startTimeUnixNano: prev?.startTimeUnixNano ?? startTimeUnixNano };
		changed.push(k);
	}
	for (const item of acc.histograms.values()) {
		const k = key(item);
		const prev = series[k];
		series[k] = {
			key: k,
			kind: "histogram",
			name: item.name,
			attributes: item.attributes,
			count: (prev?.count ?? 0) + item.count,
			sum: (prev?.sum ?? 0) + item.sum,
			min: prev ? Math.min(prev.min, item.min) : item.min,
			max: prev ? Math.max(prev.max, item.max) : item.max,
			buckets: item.buckets.map((n, i) => n + (prev?.buckets?.[i] ?? 0)),
			startTimeUnixNano: prev?.startTimeUnixNano ?? startTimeUnixNano,
		};
		changed.push(k);
	}
	return { series, changed };
}

/**
 * Event rows → an ExportMetricsServiceRequest with sums and one histogram,
 * plus the updated usage state.
 *
 * `temporality` "delta" (default) emits this batch's deltas as they are
 * (aggregationTemporality 1) and touches no series. "cumulative" adds them onto
 * the persisted running totals in `seriesByKey` and emits the totals
 * (aggregationTemporality 2) with the series' own start time; the caller
 * persists `series`/`changedSeries` together with the usage state, only after
 * the destination accepted the request.
 *
 * Only the LAST usage.snapshot of each session in the batch is read (it is a
 * running total), and it is diffed against `stateBySession`, so replaying the
 * same events with the returned state exports nothing twice. Step and workflow
 * counters are per event: the caller must deliver each event once.
 *
 * Data point attributes are ONLY target.org, target.org.name (only when
 * `options.sendContent`; 1:1 with the id), target.runner and
 * gen_ai.request.model (plus token.type on target.tokens): workflow, session,
 * user and step ids would explode the cardinality, and live on traces.
 *
 * Returns `{request, state, series, changedSeries}`; `request` is null when there
 * is nothing to send. `series` is `seriesByKey` plus this batch (unchanged in delta mode).
 */
export function buildMetrics({ events, orgId, serviceVersion, stateBySession = {}, rules = [], runnerByWorkflow = {}, options = {}, temporality = "delta", seriesByKey = {} } = {}) {
	const cumulative = temporality === "cumulative";
	const { sendContent = false, orgName = null } = options;
	const exportedOrgName = sendContent ? (orgName ?? orgId) : undefined;
	const state = { ...stateBySession };
	const acc = createAccumulator();
	const rows = [...(events ?? [])].sort(byReceived);

	const runners = new Map();
	for (const row of rows) {
		if (row.kind === "workflow.created" && row.workflow_id && typeof dataOf(row).agent === "string") runners.set(row.workflow_id, dataOf(row).agent);
	}
	const runnerOf = (workflowId) => runners.get(workflowId) ?? runnerByWorkflow[workflowId] ?? null;
	const dims = (workflowId, model = null, runner = runnerOf(workflowId)) =>
		attrs({ "target.org": orgId, "target.org.name": exportedOrgName, "target.runner": runner, "gen_ai.request.model": model });

	let first = null;
	let last = null;
	const touch = (row) => {
		const t = eventNano(row);
		if (t === null) return false;
		if (first === null || BigInt(t) < BigInt(first)) first = t;
		if (last === null || BigInt(t) > BigInt(last)) last = t;
		return true;
	};

	const lastSnapshot = new Map();
	for (const row of rows) {
		if (!row.workflow_id || !touch(row)) continue;
		const d = dataOf(row);
		if (row.kind === "usage.snapshot") {
			lastSnapshot.set(`${row.workflow_id}:${row.session_id ?? ""}`, row);
		} else if (row.kind === "step.done" || row.kind === "step.failed") {
			const attributes = dims(row.workflow_id);
			if (typeof d.duration_ms === "number" && d.duration_ms >= 0) acc.observe("target.step.duration", attributes, d.duration_ms / 1000);
			// A failure that will be retried is followed by the attempt that carries the count.
			const terminal = row.kind === "step.done" || !(d.retry_count < d.max_retries);
			if (terminal && Number.isInteger(d.retry_count)) acc.add("target.step.retries", attributes, d.retry_count);
		} else if (row.kind === "workflow.status_changed") {
			if (d.to === "completed") acc.add("target.workflow.completed", dims(row.workflow_id), 1);
			else if (d.to === "failed") acc.add("target.workflow.failed", dims(row.workflow_id), 1);
		}
	}

	for (const [key, row] of lastSnapshot) {
		const runner = (typeof dataOf(row).agent === "string" && dataOf(row).agent) || runnerOf(row.workflow_id);
		const delta = computeUsageDelta({ previousState: state[key], snapshot: dataOf(row), rules, agent: runner, at: row.received_at ?? row.created_at });
		state[key] = delta.nextState;
		const base = { model: delta.model, runner };
		for (const type of TOKEN_TYPES) {
			acc.add("target.tokens", [...dims(row.workflow_id, base.model, base.runner), attr("token.type", type)], delta.tokens[type]);
		}
		if (delta.costDeltaUsd !== null) acc.add("target.cost.usd", dims(row.workflow_id, base.model, base.runner), delta.costDeltaUsd);
	}

	const timeUnixNano = last;
	let sums = [...acc.sums.values()];
	let histograms = [...acc.histograms.values()];
	let series = seriesByKey;
	let changedSeries = [];
	if (cumulative) {
		const merged = mergeSeries(seriesByKey, acc, first);
		series = merged.series;
		changedSeries = merged.changed;
		// Every touched series is exported with its running total; untouched ones are not re-sent.
		sums = changedSeries.map((k) => series[k]).filter((x) => x.kind === "sum");
		histograms = changedSeries.map((k) => series[k]).filter((x) => x.kind === "histogram");
	}
	const aggregationTemporality = cumulative ? TEMPORALITY_CUMULATIVE : TEMPORALITY_DELTA;
	const startOf = (p) => (cumulative ? p.startTimeUnixNano : first);
	const metrics = [];
	const byName = new Map();
	for (const s of sums) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
	for (const [name, points] of byName) {
		const def = SUM_METRICS[name];
		metrics.push({
			name,
			description: def.description,
			unit: def.unit,
			sum: {
				aggregationTemporality,
				isMonotonic: true,
				dataPoints: points.map((p) => ({
					attributes: p.attributes,
					startTimeUnixNano: startOf(p),
					timeUnixNano,
					...(def.double ? { asDouble: p.value } : { asInt: BigInt(Math.round(p.value)).toString() }),
				})),
			},
		});
	}
	if (histograms.length) {
		metrics.push({
			name: "target.step.duration",
			description: "Duration of workflow step attempts",
			unit: "s",
			histogram: {
				aggregationTemporality,
				dataPoints: histograms.map((h) => ({
					attributes: h.attributes,
					startTimeUnixNano: startOf(h),
					timeUnixNano,
					count: String(h.count),
					sum: h.sum,
					min: h.min,
					max: h.max,
					bucketCounts: h.buckets.map(String),
					explicitBounds: STEP_DURATION_BOUNDS,
				})),
			},
		});
	}

	if (metrics.length === 0) return { request: null, state, series, changedSeries: [] };
	return {
		request: {
			resourceMetrics: [{ resource: resourceBlock({ org: orgId, orgName: exportedOrgName, serviceVersion }), scopeMetrics: [{ scope: scopeBlock({ serviceVersion }), metrics }] }],
		},
		state,
		series,
		changedSeries,
	};
}
