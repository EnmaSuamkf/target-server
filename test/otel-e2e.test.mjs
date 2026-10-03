/**
 * End to end: events POSTed to /ingest, a real server with the exporter
 * switched on through the settings API, a worker pass, and a fake OTLP HTTP
 * destination that records what arrives.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-otel-e2e-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_SECRETS_KEY = randomBytes(32).toString("hex");
process.env.TARGET_OTEL_ALLOW_PRIVATE = "1";
process.env.TARGET_OTEL_INTERVAL_SECONDS = "0"; // the test drives passes itself

const { server, otelWorker } = await import("../server.mjs");
const db = await import("../db.mjs");
const { createOtelWorker } = await import("../otel-worker.mjs");
const { priceSession } = await import("../pricing.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

/** The destination: records requests and replies from a script (last reply repeats). */
const received = [];
let script = [200];
let hit = 0;
const destination = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
		res.writeHead(script[Math.min(hit++, script.length - 1)], { "content-type": "application/json" });
		res.end("{}");
	});
});
await new Promise((r) => destination.listen(0, "127.0.0.1", r));
after(() => destination.close());
const endpoint = `http://127.0.0.1:${destination.address().port}`;
const resetDestination = (replies = [200]) => {
	received.length = 0;
	script = replies;
	hit = 0;
};

let cookie;
const jsonReq = (method, body) => ({
	method,
	headers: { "content-type": "application/json", cookie },
	body: body === undefined ? undefined : JSON.stringify(body),
});
const enable = async () => assert.equal((await otel("PUT", { enabled: true, endpoint })).status, 200);
const otel = (method, body) => fetch(`${base}/api/settings/otel`, jsonReq(method, body)).then(async (r) => ({ status: r.status, body: await r.json() }));

let seq = 0;
const ev = (kind, wf, session, data) => ({ id: `e2e-${++seq}-${randomBytes(2).toString("hex")}`, kind, workflow_id: wf, session_id: session, created_at: new Date().toISOString(), data });
const usage = (uncached, cacheRead, out) => ({ input_tokens: uncached, cache_read: cacheRead, cache_creation: 0, output_tokens: out, model: "claude-opus-4", cost_usd: null });
async function ingest(events, instance = "inst-e2e") {
	const res = await fetch(`${base}/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ batch_id: `b-${seq}`, instance_id: instance, version: "0.2.0", schema_version: 1, sent_at: new Date().toISOString(), user: { display_name: "Ada" }, events }),
	});
	return { status: res.status, body: await res.json() };
}
const outboxRows = () => {
	const raw = new DatabaseSync(tmpDb, { readOnly: true });
	try {
		return raw.prepare("SELECT event_id, status FROM otel_outbox ORDER BY id").all();
	} finally {
		raw.close();
	}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inDefault = (fn) => db.runWithOrg(db.DEFAULT_ORG_ID, fn);
const metricSum = (name) =>
	received
		.flatMap((r) => r.body.resourceMetrics?.[0].scopeMetrics[0].metrics ?? [])
		.filter((m) => m.name === name)
		.flatMap((m) => m.sum.dataPoints.map((p) => Number(p.asDouble ?? p.asInt)))
		.reduce((a, b) => a + b, 0);
const spanNames = () => received.flatMap((r) => r.body.resourceSpans?.[0].scopeSpans[0].spans.map((s) => s.name) ?? []);

const finished = (wf) => [
	ev("workflow.created", wf, null, { name: "Report", agent: "claude" }),
	ev("step.started", wf, null, { step_id: "s1", attempt: 1 }),
	ev("step.done", wf, null, { step_id: "s1", duration_ms: 2000, retry_count: 0 }),
	ev("usage.snapshot", wf, "sess", usage(1_000, 40_000, 300)),
	ev("workflow.status_changed", wf, null, { from: "running", to: "completed" }),
];

test("setup: pricing rule and a disabled exporter", async () => {
	cookie = await login(base);
	const rule = await fetch(`${base}/api/settings/pricing`, jsonReq("POST", { agent: "claude", model: "*", inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3 }));
	assert.equal(rule.status, 201);
});

test("with the exporter disabled there is no outbox write and a pass does nothing", async () => {
	const res = await ingest(finished("wf-before"));
	assert.equal(res.status, 200);
	assert.equal(res.body.accepted.length, 5);
	assert.deepEqual(outboxRows(), []);
	resetDestination();
	const summary = await otelWorker.runOnce();
	assert.deepEqual(summary, { orgs: 0, sent: 0, failed: 0 });
	assert.equal(received.length, 0);
});

test("events ingested after enabling arrive as spans and metrics; earlier ones never do", async () => {
	await sleep(5);
	const put = await otel("PUT", { enabled: true, endpoint, sendContent: false, headers: { Authorization: "Bearer e2e-token-9999" } });
	assert.equal(put.status, 200, JSON.stringify(put.body));
	await sleep(5);

	const wf = "wf-after";
	const events = finished(wf);
	events.push(ev("heartbeat", wf, null, {}), ev("workflow.plan", wf, null, { steps: [] }));
	const res = await ingest(events);
	assert.equal(res.status, 200);
	assert.equal(res.body.accepted.length, 7);
	// Only the kinds the exporter uses are queued.
	assert.deepEqual(outboxRows().map((r) => r.event_id).sort(), events.slice(0, 5).map((e) => e.id).sort());

	resetDestination();
	const worker = createOtelWorker({});
	const summary = await worker.runOnce();
	assert.deepEqual(summary, { orgs: 1, sent: 5, failed: 0 });
	assert.deepEqual(received.map((r) => r.url), ["/v1/traces", "/v1/metrics"]);
	assert.ok(received.every((r) => r.auth === "Bearer e2e-token-9999"));
	assert.ok(spanNames().includes("invoke_workflow"));
	assert.ok(!JSON.stringify(received).includes("wf-before"));
	assert.ok(outboxRows().every((r) => r.status === "sent"));

	// Exported cost equals what the dashboard computes with the same function.
	const rules = inDefault(() => db.listPricingRules());
	const expected = priceSession(rules, { agent: "claude", usage: db.normalizeUsageSnapshot(usage(1_000, 40_000, 300)) }).costUsd;
	assert.ok(expected > 0);
	assert.ok(Math.abs(metricSum("target.cost.usd") - expected) < 1e-12, `${metricSum("target.cost.usd")} vs ${expected}`);
	assert.equal(metricSum("target.tokens"), 1_000 + 40_000 + 300);

	// GET status reflects the delivery.
	const status = (await otel("GET")).body.status;
	assert.ok(status.lastOkAt);
	assert.equal(status.lastError, null);
	assert.equal(status.outbox.sent, 5);
});

test("a 503 then 200 destination is retried and exported exactly once", async () => {
	const wf = "wf-retry";
	await ingest([ev("usage.snapshot", wf, "s", usage(2_000, 0, 100))]);
	resetDestination([503, 200]);
	let t = Date.now() + 5000;
	const worker = createOtelWorker({ now: () => new Date(t) });
	const first = await worker.runOnce();
	assert.equal(first.failed, 1);
	assert.equal(received.length, 1, "traces got the 503, so metrics were not even attempted");
	assert.match((await otel("GET")).body.status.lastError, /HTTP 503/);
	t += 15_000;
	const second = await worker.runOnce();
	assert.equal(second.sent, 1);
	assert.deepEqual(received.map((r) => r.url), ["/v1/traces", "/v1/traces", "/v1/metrics"]);
	assert.equal(metricSum("target.tokens"), 2_100, "the delta is counted once");
	t += 3_600_000;
	await worker.runOnce();
	assert.equal(received.length, 3);
	assert.equal((await otel("GET")).body.status.lastError, null);
});

test("a destination that always fails never changes /ingest responses or latency", async () => {
	const timed = async (n) => {
		const times = [];
		for (let i = 0; i < n; i++) {
			const events = [ev("workflow.created", `wf-lat-${seq}`, null, { name: "x", agent: "claude" }), ev("usage.snapshot", `wf-lat-${seq}`, "s", usage(10, 0, 1))];
			const t0 = performance.now();
			const res = await ingest(events);
			times.push(performance.now() - t0);
			assert.equal(res.status, 200);
			assert.deepEqual(Object.keys(res.body).sort(), ["accepted", "rejected"]);
			assert.equal(res.body.accepted.length, 2);
			assert.deepEqual(res.body.rejected, []);
		}
		return times.sort((a, b) => a - b)[Math.floor(n / 2)];
	};
	await otel("PUT", { enabled: false });
	await timed(5); // warm-up
	const baseline = await timed(25);

	resetDestination([500]);
	await enable();
	await sleep(5);
	const withDown = await timed(25);
	assert.ok(outboxRows().length > 0, "events were queued");
	// The hook is a couple of indexed writes; a hung/failing destination is invisible to /ingest.
	assert.ok(withDown < baseline * 5 + 25, `median ${withDown.toFixed(1)}ms vs baseline ${baseline.toFixed(1)}ms`);

	const worker = createOtelWorker({});
	const t0 = performance.now();
	const pass = await worker.runOnce();
	assert.ok(pass.failed > 0 && pass.sent === 0, JSON.stringify(pass));
	assert.ok(performance.now() - t0 < 5000);
	const res = await ingest([ev("workflow.created", "wf-lat-final", null, { name: "x", agent: "claude" })]);
	assert.equal(res.status, 200);
	// A permanent failure kills rows, not ingest.
	resetDestination([400]);
	await createOtelWorker({ now: () => new Date(Date.now() + 3_600_000) }).runOnce();
	assert.equal((await ingest([ev("workflow.created", "wf-lat-after", null, { name: "x", agent: "claude" })])).status, 200);
	assert.ok(outboxRows().some((r) => r.status === "dead"));
});

test("a failing enqueue is logged and the ingest response is unchanged", async () => {
	await enable();
	await sleep(5);
	// Break the outbox table for this org, ingest, then restore it.
	const raw = new DatabaseSync(tmpDb);
	raw.exec("ALTER TABLE otel_outbox RENAME TO otel_outbox_hold");
	try {
		const res = await ingest([ev("workflow.created", "wf-broken", null, { name: "x", agent: "claude" })]);
		assert.equal(res.status, 200);
		assert.equal(res.body.accepted.length, 1);
		assert.deepEqual(res.body.rejected, []);
		assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM events WHERE workflow_id = 'wf-broken'").get().n, 1, "the event itself was stored");
	} finally {
		raw.exec("ALTER TABLE otel_outbox_hold RENAME TO otel_outbox");
		raw.close();
	}
});

test("target.org.name reaches the destination only with sendContent on", async () => {
	const orgAttrs = (r) => (r.body.resourceSpans ?? r.body.resourceMetrics)[0].resource.attributes.filter((a) => a.key.startsWith("target.org"));
	const dataPointOrgNames = () =>
		received.flatMap((r) => r.body.resourceMetrics?.[0].scopeMetrics[0].metrics ?? []).flatMap((m) => (m.sum ?? m.histogram).dataPoints).map((p) => p.attributes.find((a) => a.key === "target.org.name")?.value.stringValue);
	for (const sendContent of [true, false]) {
		assert.equal((await otel("PUT", { enabled: true, endpoint, sendContent })).status, 200);
		await sleep(5);
		await ingest(finished(`wf-name-${sendContent}`));
		resetDestination();
		await createOtelWorker({ now: () => new Date(Date.now() + 3_600_000) }).runOnce();
		assert.ok(received.some((r) => r.body.resourceSpans) && received.some((r) => r.body.resourceMetrics));
		const points = dataPointOrgNames();
		assert.ok(points.length > 0);
		if (sendContent) {
			assert.equal((await otel("GET")).body.organization.name, "Default");
			for (const r of received) assert.deepEqual(orgAttrs(r).map((a) => [a.key, a.value.stringValue]), [["target.org", "default"], ["target.org.name", "Default"]]);
			assert.ok(points.every((n) => n === "Default"));
		} else {
			for (const r of received) assert.deepEqual(orgAttrs(r).map((a) => a.key), ["target.org"]);
			assert.ok(points.every((n) => n === undefined));
			assert.ok(!JSON.stringify(received).includes("target.org.name"));
		}
	}
});

test("disabling stops queuing; the server's own worker is stoppable", async () => {
	await otel("PUT", { enabled: false });
	const before = outboxRows().length;
	await ingest([ev("workflow.created", "wf-off-again", null, { name: "x", agent: "claude" })]);
	assert.equal(outboxRows().length, before);
	assert.equal(otelWorker.started, false, "TARGET_OTEL_INTERVAL_SECONDS=0 keeps the timer off");
	await otelWorker.stop();
});
