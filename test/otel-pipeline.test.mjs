/**
 * End to end: realistic events → buildTraces / buildMetrics → sendOtlp → a
 * local fake OTLP server. Asserts what a backend would actually receive.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { gunzipSync } from "node:zlib";

process.env.TARGET_SERVER_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-otel-")), "t.db");
const { buildMetrics, buildTraces, rootSpanId, traceIdFor } = await import("../otel.mjs");
const { sendOtlp } = await import("../otel-client.mjs");

const RULES = [{ id: 1, agent: "claude", model: "*", inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75, effectiveFrom: "" }];
const WF = "wf-pipeline";
const SESSION = "sess-pipeline";
const SECRETS = ["SECRET-DESC", "SECRET-CRITERIA", "SECRET-ERROR", "SECRET-CONVERSATION", "SECRET-PROMPT"];
const AUTH = "Basic c2VjcmV0OnNlY3JldA==";

const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
let seq = 0;
const ev = (kind, sec, data, session = null) => ({ id: `ev${++seq}`, kind, workflow_id: WF, session_id: session, created_at: iso(sec), received_at: iso(sec), data });
const usage = (uncached, creation, read, output) => ({
	input_tokens: uncached + creation + read,
	input_tokens_uncached: uncached,
	cache_creation: creation,
	cache_read: read,
	output_tokens: output,
	context_tokens: 5000,
	context_window: 200000,
	model: "claude-sonnet-4-5",
	turns: 4,
	cost_usd: null,
	conversation: { snapshot: "SECRET-CONVERSATION" },
});

/** Step 1 done and judged; step 2 fails once, is retried and then done; the workflow completes. */
const EVENTS = [
	ev("workflow.created", 0, { name: "Pipeline Workflow", agent_name: "a", agent: "claude", sandbox: "host", step_count: 2 }),
	ev("workflow.status_changed", 1, { from: "draft", to: "running", manual: true }),
	ev("workflow.plan", 1, { plan: "SECRET-DESC" }),
	ev("step.started", 2, { step_id: "a", order_index: 0, phase: "exec", attempt: 0, max_retries: 2, description: "SECRET-DESC", prompt: "SECRET-PROMPT" }),
	ev("heartbeat", 3, {}),
	ev("step.done", 12, { step_id: "a", order_index: 0, duration_ms: 10000, retry_count: 0 }),
	ev("step.judged", 13, { step_id: "a", order_index: 0, ok: true, acceptance_criteria: "SECRET-CRITERIA" }),
	ev("usage.snapshot", 14, usage(100_000, 200_000, 1_000_000, 10_000), SESSION),
	ev("step.started", 15, { step_id: "b", order_index: 1, phase: "exec", attempt: 0, max_retries: 2 }),
	ev("step.failed", 20, {
		step_id: "b",
		order_index: 1,
		phase: "exec",
		duration_ms: 5000,
		retry_count: 0,
		max_retries: 2,
		error: { kind: "timeout", message: "SECRET-ERROR", retryable: true },
	}),
	ev("step.started", 21, { step_id: "b", order_index: 1, phase: "exec", attempt: 1, max_retries: 2 }),
	ev("usage.snapshot", 30, usage(150_000, 250_000, 4_000_000, 40_000), SESSION),
	ev("step.done", 40, { step_id: "b", order_index: 1, duration_ms: 19000, retry_count: 1 }),
	ev("usage.snapshot", 41, usage(200_000, 300_000, 10_000_000, 100_000), SESSION),
	ev("workflow.status_changed", 42, { from: "running", to: "completed", manual: false, error: "SECRET-ERROR" }),
];

/** Fake OTLP backend: records what arrives, answers like a clean accept. */
const received = [];
const server = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		let raw = Buffer.concat(chunks);
		if (req.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
		received.push({ url: req.url, headers: req.headers, text: raw.toString(), json: JSON.parse(raw.toString()) });
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"partialSuccess":{}}');
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const attrOf = (item, key) => item.attributes.find((a) => a.key === key)?.value;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

test("traces: built, sent with gzip and received well-formed", async () => {
	const body = buildTraces({ events: EVENTS, orgId: "acme", serviceVersion: "0.1.0", options: { rules: RULES } });
	const sent = await sendOtlp({ endpoint, signal: "traces", body, gzip: true, headers: { Authorization: AUTH } });
	assert.deepEqual(sent, { ok: true, status: 200, attempts: 1, partialSuccess: null, error: null });

	const got = received.at(-1);
	assert.equal(got.url, "/v1/traces");
	assert.equal(got.headers.authorization, AUTH);
	assert.deepEqual(got.json, body);
	const resource = got.json.resourceSpans[0].resource;
	assert.equal(attrOf(resource, "service.name").stringValue, "target-server");
	assert.equal(attrOf(resource, "target.org").stringValue, "acme");

	const spans = got.json.resourceSpans[0].scopeSpans[0].spans;
	const root = spans.find((s) => !s.parentSpanId);
	assert.equal(root.spanId, rootSpanId(WF));
	assert.equal(root.name, "invoke_workflow");
	assert.deepEqual(root.status, { code: 1 });
	// root + 3 step attempts (a, b failed, b done) + 1 session
	assert.equal(spans.length, 5);
	for (const s of spans) {
		assert.equal(s.traceId, traceIdFor(WF));
		assert.match(s.traceId, HEX32);
		assert.match(s.spanId, HEX16);
		if (s !== root) assert.equal(s.parentSpanId, root.spanId);
		assert.equal(typeof s.startTimeUnixNano, "string");
		assert.equal(typeof s.endTimeUnixNano, "string");
		assert.ok(BigInt(s.startTimeUnixNano) <= BigInt(s.endTimeUnixNano));
		assert.equal(s.kind, 1);
	}
	assert.equal(new Set(spans.map((s) => s.spanId)).size, spans.length);

	const steps = spans.filter((s) => /^step \d+$/.test(s.name));
	assert.deepEqual(steps.map((s) => s.name), ["step 1", "step 2", "step 2"]);
	assert.deepEqual(steps.map((s) => s.status.code), [1, 2, 1]);
	assert.equal(attrOf(steps[1], "target.error.kind").stringValue, "timeout");
	assert.equal(steps[0].events[0].name, "step.judged");
	for (const s of steps) assert.ok(!s.attributes.some((a) => /usage|cost|token/.test(a.key)));

	const sessions = spans.filter((s) => s.attributes.some((a) => a.key.startsWith("gen_ai.usage.")));
	assert.equal(sessions.length, 1);
	assert.equal(attrOf(sessions[0], "gen_ai.usage.output_tokens").intValue, "100000");
	assert.equal(attrOf(sessions[0], "target.cost.source").stringValue, "pricing");
});

test("metrics: delta sums and histogram arrive well-formed, usage counted once", async () => {
	const { request, state } = buildMetrics({ events: EVENTS, orgId: "acme", serviceVersion: "0.1.0", rules: RULES });
	const sent = await sendOtlp({ endpoint: `${endpoint}/`, signal: "metrics", body: request, headers: { Authorization: AUTH } });
	assert.equal(sent.ok, true);

	const got = received.at(-1);
	assert.equal(got.url, "/v1/metrics");
	assert.deepEqual(got.json, request);
	const metrics = got.json.resourceMetrics[0].scopeMetrics[0].metrics;
	const byName = Object.fromEntries(metrics.map((m) => [m.name, m]));
	assert.deepEqual(Object.keys(byName).sort(), [
		"target.cost.usd",
		"target.step.duration",
		"target.step.retries",
		"target.tokens",
		"target.workflow.completed",
	]);
	for (const m of metrics) {
		const body = m.sum ?? m.histogram;
		assert.equal(body.aggregationTemporality, 1);
		for (const p of body.dataPoints) {
			assert.equal(typeof p.startTimeUnixNano, "string");
			assert.equal(typeof p.timeUnixNano, "string");
			for (const a of p.attributes) assert.ok(["target.org", "target.runner", "gen_ai.request.model", "token.type"].includes(a.key), a.key);
		}
	}
	const tokens = Object.fromEntries(byName["target.tokens"].sum.dataPoints.map((p) => [attrOf(p, "token.type").stringValue, p.asInt]));
	assert.deepEqual(tokens, { input: "200000", output: "100000", cache_read: "10000000", cache_creation: "300000" });
	// (200k*3 + 300k*3.75 + 10M*0.3 + 100k*15) / 1M
	assert.ok(Math.abs(byName["target.cost.usd"].sum.dataPoints[0].asDouble - (0.6 + 1.125 + 3 + 1.5)) < 1e-9);
	const hist = byName["target.step.duration"].histogram.dataPoints[0];
	assert.equal(hist.count, "3");
	assert.equal(hist.bucketCounts.length, hist.explicitBounds.length + 1);
	assert.equal(hist.sum, 10 + 5 + 19);
	assert.equal(byName["target.step.retries"].sum.dataPoints[0].asInt, "1");
	assert.equal(byName["target.workflow.completed"].sum.dataPoints[0].asInt, "1");

	// Feeding the same events and the returned state back exports no usage twice
	// (step and workflow counters are per event; the caller delivers those once).
	const replay = buildMetrics({ events: EVENTS, orgId: "acme", rules: RULES, stateBySession: state });
	const replayed = replay.request.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name);
	assert.ok(!replayed.includes("target.tokens") && !replayed.includes("target.cost.usd"));
});

test("nothing forbidden reaches the backend", () => {
	assert.ok(received.length >= 2);
	for (const r of received) {
		for (const word of SECRETS) assert.ok(!r.text.includes(word), `${word} reached ${r.url}`);
		assert.ok(!r.text.includes("Pipeline Workflow"), "workflow name is content, off by default");
		assert.ok(!r.text.includes("c2VjcmV0"), "auth header value must not be in the body");
		assert.ok(!r.text.includes("wf-pipeline") || r.url === "/v1/traces", "workflow id only on traces");
	}
});
