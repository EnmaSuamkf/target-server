/**
 * The outbox worker against the database directly: a fake `fetch` stands in
 * for the destination and the clock is injected, so retries need no sleeping.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-otel-worker-"));
process.env.TARGET_SERVER_DB = path.join(tmpDir, "default.db");
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");
process.env.TARGET_SECRETS_KEY = randomBytes(32).toString("hex");
delete process.env.TARGET_OTEL_ALLOW_PRIVATE;
mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);

const db = await import("../db.mjs");
const control = await import("../control-plane.mjs");
const { createOtelWorker, backoffSeconds, otelIntervalMs, OTEL_EXPORT_KINDS } = await import("../otel-worker.mjs");
const { priceSession } = await import("../pricing.mjs");
const { DEFAULT_ORG_ID, runWithOrg } = db;

const otherDb = path.join(tmpDir, "other.db");
control.createOrganization({ id: "org-other", slug: "other", name: "Other", dbPath: otherDb });
const inDefault = (fn) => runWithOrg(DEFAULT_ORG_ID, fn);
const inOther = (fn) => runWithOrg("org-other", fn, { dbPath: otherDb });
const BOTH = [DEFAULT_ORG_ID, "org-other"];

/** A scripted destination. `replies` are consumed per request (last repeats). */
function fakeDestination(replies = [200]) {
	const requests = [];
	let i = 0;
	const fetchImpl = async (url, init) => {
		const status = replies[Math.min(i++, replies.length - 1)];
		requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body), redirect: init.redirect });
		return new Response("{}", { status });
	};
	return { requests, fetchImpl, signals: () => requests.map((r) => r.url.split("/").pop()) };
}

/** A clock that only moves when told to. Starts ahead of the real clock so just-enqueued rows are due. */
function clock() {
	let t = Date.now() + 5000;
	return { now: () => new Date(t), advance: (s) => (t += s * 1000) };
}

let n = 0;
const uid = (p) => `${p}-${++n}-${randomBytes(3).toString("hex")}`;
const iso = () => new Date().toISOString();

function put(kind, workflowId, sessionId, data, createdAt = iso()) {
	const event = { id: uid("e"), kind, workflow_id: workflowId, session_id: sessionId, created_at: createdAt, data };
	assert.equal(db.insertEvent("inst-1", "0.1", event, iso()), "inserted");
	return event;
}
const enqueue = (e) => db.enqueueOtelEvent(e.id, e.kind);
const usage = (uncached, cacheRead, out) => ({ input_tokens: uncached, cache_read: cacheRead, cache_creation: 0, output_tokens: out, model: "claude-opus-4", cost_usd: null });

/** A finished workflow: enough for a root span, so a pass has something to send. */
function enqueueFinished(wf = uid("wf")) {
	enqueue(put("workflow.created", wf, null, { name: "n", agent: "claude" }));
	enqueue(put("workflow.status_changed", wf, null, { from: "running", to: "completed" }));
	return wf;
}

function configure(extra = {}) {
	return db.saveOtelConfig({ enabled: true, endpoint: "https://otlp.example.com", headers: { Authorization: "Bearer worker-secret-1234" }, sendContent: false, ...extra });
}
const metricValues = (body, name) =>
	(body.resourceMetrics?.[0].scopeMetrics[0].metrics ?? [])
		.filter((m) => m.name === name)
		.flatMap((m) => m.sum.dataPoints.map((p) => Number(p.asDouble ?? p.asInt)));
const sumMetric = (requests, name) =>
	requests.filter((r) => r.body.resourceMetrics).flatMap((r) => metricValues(r.body, name)).reduce((a, b) => a + b, 0);

test("helpers: backoff, interval, kinds", () => {
	assert.deepEqual([0, 1, 2, 3, 10, 50].map(backoffSeconds), [10, 20, 40, 80, 300, 300]);
	assert.equal(otelIntervalMs({}), 10_000);
	assert.equal(otelIntervalMs({ TARGET_OTEL_INTERVAL_SECONDS: "2" }), 2000);
	assert.equal(otelIntervalMs({ TARGET_OTEL_INTERVAL_SECONDS: "0" }), 0);
	assert.equal(otelIntervalMs({ TARGET_OTEL_INTERVAL_SECONDS: "abc" }), 10_000);
	assert.deepEqual([...OTEL_EXPORT_KINDS].sort(), ["step.done", "step.failed", "step.judged", "step.started", "usage.snapshot", "workflow.created", "workflow.status_changed"]);
});

test("a disabled organization costs no sends, no prune and leaves its outbox alone", async () => {
	const dest = fakeDestination();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		db.saveOtelConfig({ enabled: false, endpoint: "https://otlp.example.com" });
		const e = put("workflow.created", "wf-off", null, { name: "x", agent: "claude" });
		enqueue(e);
		const old = "2000-01-01T00:00:00.000Z";
		db.enqueueOtelEvent("ancient", "step.done", old);
		const summary = await worker.runOnce();
		assert.deepEqual(summary, { orgs: 0, sent: 0, failed: 0 });
		assert.equal(dest.requests.length, 0);
		assert.deepEqual(db.otelOutboxCounts(), { pending: 2, sent: 0, dead: 0 });
		db.deleteOtelConfig();
		assert.equal(await worker.runOnce().then((s) => s.orgs), 0);
	});
});

test("exports spans and metrics, then marks rows sent and stores the export state together", async () => {
	const dest = fakeDestination();
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		db.importPricingRules([{ agent: "claude", model: "*", inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3 }], "replace");
		configure();
		const wf = uid("wf");
		const events = [
			put("workflow.created", wf, null, { name: "secret name", agent: "claude" }),
			put("step.started", wf, null, { step_id: "s1", attempt: 1 }),
			put("step.done", wf, null, { step_id: "s1", duration_ms: 1500, retry_count: 0 }),
			put("usage.snapshot", wf, "sess", usage(1000, 50_000, 200)),
			put("workflow.status_changed", wf, null, { from: "running", to: "completed" }),
		];
		for (const e of events) enqueue(e);

		const summary = await worker.runOnce();
		assert.deepEqual(summary, { orgs: 1, sent: 5, failed: 0 });
		assert.deepEqual(dest.signals(), ["traces", "metrics"]);
		assert.ok(dest.requests.every((r) => r.redirect === undefined || r.redirect === "manual"));
		assert.equal(dest.requests[0].headers.Authorization, "Bearer worker-secret-1234");
		const spans = dest.requests[0].body.resourceSpans[0].scopeSpans[0].spans;
		assert.ok(spans.some((s) => s.name === "invoke_workflow"), "root span");
		assert.ok(!JSON.stringify(dest.requests).includes("secret name"), "workflow name is content, off by default");

		const rules = db.listPricingRules();
		const expected = priceSession(rules, { agent: "claude", usage: db.normalizeUsageSnapshot(usage(1000, 50_000, 200)) }).costUsd;
		assert.ok(expected > 0);
		assert.ok(Math.abs(sumMetric(dest.requests, "target.cost.usd") - expected) < 1e-12);
		assert.equal(sumMetric(dest.requests, "target.tokens"), 1000 + 50_000 + 200);

		assert.deepEqual(db.otelOutboxCounts(), { pending: 0, sent: 5, dead: 0 });
		assert.equal(db.getOtelExportState(wf, "sess").costUsd, expected);
		const cfg = db.getOtelConfig();
		assert.ok(cfg.lastOkAt);
		assert.equal(cfg.lastError, null);

		// Nothing left: a second pass sends nothing.
		await worker.runOnce();
		assert.equal(dest.requests.length, 2);
	});
});

test("a later cumulative snapshot exports only the difference", async () => {
	const dest = fakeDestination();
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		configure();
		const wf = uid("wf");
		enqueue(put("usage.snapshot", wf, "s", usage(100, 0, 10)));
		await worker.runOnce();
		enqueue(put("usage.snapshot", wf, "s", usage(300, 0, 40)));
		await worker.runOnce();
		const tokens = dest.requests.filter((r) => r.body.resourceMetrics).map((r) => metricValues(r.body, "target.tokens").reduce((a, b) => a + b, 0));
		assert.deepEqual(tokens, [110, 230]);
		const rules = db.listPricingRules();
		const total = priceSession(rules, { agent: null, usage: db.normalizeUsageSnapshot(usage(300, 0, 40)) }).costUsd;
		assert.ok(Math.abs(sumMetric(dest.requests, "target.cost.usd") - total) < 1e-12);
	});
});

test("503 then 200: rescheduled with backoff, retried, exported exactly once", async () => {
	const dest = fakeDestination([503, 200]);
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		db.deleteOtelConfig();
		configure({ signals: ["metrics"] });
		const wf = uid("wf");
		enqueue(put("usage.snapshot", wf, "s", usage(500, 0, 50)));

		const first = await worker.runOnce();
		assert.deepEqual(first, { orgs: 1, sent: 0, failed: 1 });
		assert.deepEqual(db.otelOutboxCounts(), { pending: 1, sent: 0, dead: 0 });
		assert.equal(db.getOtelConfig().lastError, "metrics: HTTP 503");
		assert.equal(db.getOtelExportState(wf, "s"), null, "state is not advanced by a failed send");

		await worker.runOnce(); // not due yet
		assert.equal(dest.requests.length, 1);
		c.advance(11);
		const again = await worker.runOnce();
		assert.equal(again.sent, 1);
		assert.equal(dest.requests.length, 2);
		assert.equal(sumMetric(dest.requests.slice(1), "target.tokens"), 550);
		assert.deepEqual(db.otelOutboxCounts(), { pending: 0, sent: 1, dead: 0 });
		assert.equal(db.getOtelConfig().lastError, null);
		c.advance(3600);
		await worker.runOnce();
		assert.equal(dest.requests.length, 2, "never exported again");
	});
});

test("backoff grows with attempts", async () => {
	const dest = fakeDestination([503]);
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		db.deleteOtelConfig();
		configure({ signals: ["metrics"] });
		enqueue(put("usage.snapshot", uid("wf"), "s", usage(1, 0, 1)));
		await worker.runOnce(); // attempts 0 -> wait 10s
		c.advance(9);
		await worker.runOnce();
		assert.equal(dest.requests.length, 1);
		c.advance(2);
		await worker.runOnce(); // attempts 1 -> wait 20s
		assert.equal(dest.requests.length, 2);
		c.advance(15);
		await worker.runOnce();
		assert.equal(dest.requests.length, 2);
		c.advance(6);
		await worker.runOnce();
		assert.equal(dest.requests.length, 3);
	});
});

test("a permanent failure (401) marks rows dead and records last_error", async () => {
	const dest = fakeDestination([401]);
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		db.deleteOtelConfig();
		configure();
		enqueueFinished();
		const r = await worker.runOnce();
		assert.equal(r.failed, 2);
		assert.deepEqual(db.otelOutboxCounts(), { pending: 0, sent: 0, dead: 2 });
		assert.match(db.getOtelConfig().lastError, /HTTP 401/);
		assert.ok(!db.getOtelConfig().lastError.includes("worker-secret"));
		c.advance(3600);
		await worker.runOnce();
		assert.equal(dest.requests.length, 1, "dead rows are not retried");
	});
});

test("the signals setting is respected, and metrics state stays put when metrics are off", async () => {
	const dest = fakeDestination();
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		db.deleteOtelConfig();
		configure({ signals: ["traces"] });
		const wf = uid("wf");
		enqueue(put("workflow.created", wf, null, { name: "n", agent: "claude" }));
		enqueue(put("usage.snapshot", wf, "s", usage(10, 0, 1)));
		enqueue(put("workflow.status_changed", wf, null, { to: "completed" }));
		await worker.runOnce();
		assert.deepEqual(dest.signals(), ["traces"]);
		assert.equal(db.getOtelExportState(wf, "s"), null);
		db.saveOtelConfig({ signals: ["metrics"] });
		enqueue(put("usage.snapshot", wf, "s", usage(20, 0, 2)));
		await worker.runOnce();
		assert.deepEqual(dest.signals(), ["traces", "metrics"]);
	});
});

test("send_content and langfuse_attrs flags reach the mapping", async () => {
	const dest = fakeDestination();
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		db.deleteOtelConfig();
		configure({ signals: ["traces"], sendContent: true, langfuseAttrs: true });
		const wf = uid("wf");
		enqueue(put("workflow.created", wf, null, { name: "Visible Name", agent: "claude" }));
		enqueue(put("workflow.status_changed", wf, null, { to: "completed" }));
		await worker.runOnce();
		const text = JSON.stringify(dest.requests[0].body);
		assert.ok(text.includes("Visible Name"));
		assert.ok(text.includes("langfuse.trace.name"));
	});
});

test("target.org.name follows send_content and the organization's own name", async () => {
	const dest = fakeDestination();
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => BOTH });
	const names = (r) => {
		const res = (r.body.resourceSpans ?? r.body.resourceMetrics)[0].resource.attributes;
		return { org: res.find((a) => a.key === "target.org")?.value.stringValue, name: res.find((a) => a.key === "target.org.name")?.value.stringValue };
	};
	for (const sendContent of [true, false]) {
		dest.requests.length = 0;
		for (const run of [inDefault, inOther]) {
			await run(async () => {
				db.deleteOtelConfig();
				configure({ sendContent });
				const wf = uid("wf");
				enqueue(put("workflow.created", wf, null, { name: "n", agent: "claude" }));
				enqueue(put("usage.snapshot", wf, "s", usage(10, 0, 1)));
				enqueue(put("workflow.status_changed", wf, null, { from: "running", to: "completed" }));
			});
		}
		await worker.runOnce();
		assert.ok(dest.requests.length >= 4);
		const got = dest.requests.map(names);
		if (sendContent) {
			assert.deepEqual(new Set(got.map((g) => `${g.org}=${g.name}`)), new Set(["default=Default", "org-other=Other"]));
		} else {
			assert.ok(got.every((g) => g.name === undefined));
			assert.ok(!JSON.stringify(dest.requests).includes("target.org.name"));
		}
	}
});

test("currentOrganization falls back to the id when the name is empty or unknown", async () => {
	assert.deepEqual(inDefault(() => db.currentOrganization()), { id: DEFAULT_ORG_ID, name: "Default" });
	assert.deepEqual(inOther(() => db.currentOrganization()), { id: "org-other", name: "Other" });
	assert.deepEqual(runWithOrg("ghost", () => db.currentOrganization(), { dbPath: otherDb }), { id: "ghost", name: "ghost" });
});

test("events received before enabled_at are never exported, even if queued", async () => {
	const dest = fakeDestination();
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		db.deleteOtelConfig();
		const wf = uid("wf");
		const early = { id: uid("e"), kind: "usage.snapshot", workflow_id: wf, session_id: "s", created_at: iso(), data: usage(9999, 0, 1) };
		db.insertEvent("inst-1", "0.1", early, "2001-01-01T00:00:00.000Z");
		enqueue(early); // a stale row, e.g. left from an earlier enabled period
		configure({ signals: ["metrics"] });
		enqueue(put("usage.snapshot", wf, "s", usage(5, 0, 1)));
		await worker.runOnce();
		assert.equal(sumMetric(dest.requests, "target.tokens"), 6);
		assert.deepEqual(db.otelOutboxCounts(), { pending: 0, sent: 2, dead: 0 });
	});
});

test("an unsafe or undecryptable destination is not contacted", async () => {
	const dest = fakeDestination();
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		db.deleteOtelConfig();
		configure();
		enqueueFinished();
		const lookup = dns.lookup;
		lookup.mock.mockImplementation(async () => [{ address: "10.0.0.9", family: 4 }]);
		await worker.runOnce();
		assert.equal(dest.requests.length, 0);
		assert.equal(db.getOtelConfig().lastError, "endpoint_private");
		assert.equal(db.otelOutboxCounts().pending, 2);
		lookup.mock.mockImplementation(async () => [{ address: "93.184.216.34", family: 4 }]);

		const key = process.env.TARGET_SECRETS_KEY;
		delete process.env.TARGET_SECRETS_KEY;
		try {
			await worker.runOnce();
			assert.equal(dest.requests.length, 0);
			assert.match(db.getOtelConfig().lastError, /cannot be decrypted/);
		} finally {
			process.env.TARGET_SECRETS_KEY = key;
		}
		c.advance(1);
		await worker.runOnce();
		assert.equal(dest.requests.length, 2, "traces and metrics once the destination is safe again");
	});
});

test("outbox rows older than the max age are pruned on a pass", async () => {
	const dest = fakeDestination();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		db.deleteOtelConfig();
		configure();
		db.enqueueOtelEvent("stale-1", "step.done", new Date(Date.now() - 8 * 86_400_000).toISOString());
		await worker.runOnce();
		assert.equal(db.otelOutboxCounts().pending, 0);
		assert.equal(db.claimOtelOutboxBatch(10, "2999-01-01T00:00:00.000Z").length, 0);
	});
	process.env.TARGET_OTEL_OUTBOX_MAX_AGE_DAYS = "30";
	try {
		await inDefault(async () => {
			db.enqueueOtelEvent("stale-2", "step.done", new Date(Date.now() - 8 * 86_400_000).toISOString());
			assert.equal(db.pruneOtelOutbox(30, new Date()), 0);
		});
	} finally {
		delete process.env.TARGET_OTEL_OUTBOX_MAX_AGE_DAYS;
	}
});

test("a crash between send and commit never advances state, and the re-send is not doubled", async () => {
	const dest = fakeDestination();
	const c = clock();
	let crash = true;
	const worker = createOtelWorker({
		fetchImpl: dest.fetchImpl,
		now: c.now,
		listOrgIds: () => [DEFAULT_ORG_ID],
		beforeCommit: () => {
			if (crash) throw new Error("simulated crash");
		},
	});
	await inDefault(async () => {
		db.deleteOtelConfig();
		configure({ signals: ["metrics"] });
		const wf = uid("wf");
		enqueue(put("usage.snapshot", wf, "s", usage(700, 0, 70)));
		await worker.runOnce();
		assert.equal(dest.requests.length, 1);
		assert.equal(db.getOtelExportState(wf, "s"), null, "state untouched by the crashed commit");
		assert.deepEqual(db.otelOutboxCounts(), { pending: 1, sent: 0, dead: 0 });

		crash = false;
		await worker.runOnce();
		assert.equal(dest.requests.length, 2);
		const perRequest = dest.requests.map((r) => metricValues(r.body, "target.tokens").reduce((a, b) => a + b, 0));
		assert.deepEqual(perRequest, [770, 770], "the retry carries the same delta, not 2x");
		assert.deepEqual(db.getOtelExportState(wf, "s").tokens, { input: 700, output: 70, cache_read: 0, cache_creation: 0 });
		await worker.runOnce();
		assert.equal(dest.requests.length, 2);
	});
});

test("organizations never see each other's data", async () => {
	const dest = fakeDestination();
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => BOTH });
	const wfA = uid("wf-a");
	const wfB = uid("wf-b");
	await inDefault(async () => {
		db.deleteOtelConfig();
		db.saveOtelConfig({ enabled: true, endpoint: "https://a.example.com", headers: { "X-Org": "token-for-org-A-1111" } });
		enqueue(put("usage.snapshot", wfA, "s", usage(111, 0, 1)));
		enqueueFinished(wfA);
	});
	await inOther(async () => {
		db.saveOtelConfig({ enabled: true, endpoint: "https://b.example.com", headers: { "X-Org": "token-for-org-B-2222" } });
		const e = { id: uid("e"), kind: "usage.snapshot", workflow_id: wfB, session_id: "s", created_at: iso(), data: usage(222, 0, 2) };
		db.insertEvent("inst-b", "0.1", e, iso());
		enqueue(e);
		enqueueFinished(wfB);
	});
	const summary = await worker.runOnce();
	assert.equal(summary.orgs, 2);
	const toA = dest.requests.filter((r) => r.url.startsWith("https://a.example.com"));
	const toB = dest.requests.filter((r) => r.url.startsWith("https://b.example.com"));
	assert.ok(toA.length && toB.length);
	assert.ok(toA.every((r) => r.headers["X-Org"] === "token-for-org-A-1111"));
	assert.ok(toB.every((r) => r.headers["X-Org"] === "token-for-org-B-2222"));
	assert.equal(sumMetric(toA, "target.tokens"), 112);
	assert.equal(sumMetric(toB, "target.tokens"), 224);
	assert.ok(!JSON.stringify(toA).includes(wfB) && !JSON.stringify(toB).includes(wfA));
	assert.ok(!JSON.stringify(toA).includes("org-B") && !JSON.stringify(toB).includes("org-A"));
	await inDefault(async () => assert.equal(db.getOtelExportState(wfB, "s"), null));
	await inOther(async () => assert.equal(db.getOtelExportState(wfA, "s"), null));
});

test("one organization failing does not stop the others", async () => {
	const dest = fakeDestination();
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => ["org-unknown", DEFAULT_ORG_ID] });
	await inDefault(async () => {
		db.deleteOtelConfig();
		configure();
		enqueueFinished();
	});
	const summary = await worker.runOnce();
	assert.equal(summary.sent, 2);
});

test("the timer starts once, honours the interval and stops cleanly", async () => {
	const dest = fakeDestination();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, intervalMs: 20, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		db.deleteOtelConfig();
		configure();
		enqueueFinished();
	});
	assert.equal(worker.start(), true);
	assert.equal(worker.start(), false);
	const deadline = Date.now() + 3000;
	while (dest.requests.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
	assert.ok(dest.requests.length >= 1, "the timer ran a pass");
	await worker.stop();
	assert.equal(worker.started, false);
	const seen = dest.requests.length;
	await inDefault(async () => enqueueFinished());
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(dest.requests.length, seen, "no work after stop");
	assert.equal(createOtelWorker({ intervalMs: 0 }).start(), false);
});
