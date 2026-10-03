/**
 * Trace builder: events → OTLP/JSON spans. Fixtures follow the real event
 * shapes (workflow.created, step.*, usage.snapshot). Pure functions, no server.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// otel.mjs reuses db.mjs helpers; keep any database it might open out of the repo.
process.env.TARGET_SERVER_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-otel-")), "t.db");
const { buildTraces, rootSpanId, stepSpanId, sessionSpanId, traceIdFor } = await import("../otel.mjs");

const RULES = [
	{
		id: "r1",
		agent: "claude",
		model: "*",
		inputPerMtok: 3,
		outputPerMtok: 15,
		cacheReadPerMtok: 0.3,
		cacheWritePerMtok: 3.75,
		effectiveFrom: "",
	},
];
const WF = "wf-1";
const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();

let seq = 0;
function ev(kind, sec, data, session = null, workflow = WF) {
	return { id: `e${++seq}`, kind, workflow_id: workflow, session_id: session, created_at: iso(sec), received_at: iso(sec), data };
}
const created = (sec = 0, extra = {}) =>
	ev("workflow.created", sec, { name: "Secret Workflow Name", agent_name: "a", agent: "claude", sandbox: "host", step_count: 2, ...extra });
const status = (sec, to, extra = {}) => ev("workflow.status_changed", sec, { from: "running", to, manual: false, ...extra });
const started = (sec, i, attempt = 0, phase = "exec") =>
	ev("step.started", sec, { step_id: `s${i}`, order_index: i, phase, attempt, max_retries: 2 });
const done = (sec, i, ms = 5000, retry = 0) => ev("step.done", sec, { step_id: `s${i}`, order_index: i, duration_ms: ms, retry_count: retry });
const snap = (sec, session, extra = {}) =>
	ev(
		"usage.snapshot",
		sec,
		{
			input_tokens: 1_000_000,
			output_tokens: 100_000,
			input_tokens_uncached: 200_000,
			cache_creation: 300_000,
			cache_read: 500_000,
			context_tokens: 1000,
			context_window: 200000,
			model: "claude-sonnet-4-5",
			turns: 3,
			cost_usd: null,
			...extra,
		},
		session,
	);

const build = (events, options = {}) => buildTraces({ events, orgId: "demo", serviceVersion: "0.1.0", options: { rules: RULES, ...options } });
const spansOf = (payload) => payload.resourceSpans[0].scopeSpans[0].spans;
const attrOf = (span, key) => span.attributes.find((a) => a.key === key)?.value;
const hasKey = (span, re) => span.attributes.some((a) => re.test(a.key));

function successful() {
	return [
		created(0),
		started(1, 0),
		done(11, 0, 10000),
		ev("step.judged", 12, { step_id: "s0", order_index: 0, ok: true, acceptance_criteria: "SECRET CRITERIA" }),
		started(12, 1),
		done(22, 1, 10000),
		snap(5, "sess-1"),
		snap(20, "sess-1", { output_tokens: 200_000 }),
		status(30, "completed"),
	];
}

test("full successful workflow: root, step and session spans", () => {
	const payload = build(successful());
	const spans = spansOf(payload);
	assert.equal(spans.length, 4);
	const root = spans.find((s) => !s.parentSpanId);
	assert.equal(root.spanId, rootSpanId(WF));
	assert.equal(root.traceId, traceIdFor(WF));
	assert.equal(root.name, "invoke_workflow");
	assert.equal(root.kind, 1);
	assert.deepEqual(root.status, { code: 1 });
	assert.equal(root.startTimeUnixNano, `${T0}000000`);
	assert.equal(root.endTimeUnixNano, `${T0 + 30000}000000`);
	assert.equal(attrOf(root, "target.runner").stringValue, "claude");
	assert.equal(attrOf(root, "target.workflow.status").stringValue, "completed");

	const step = spans.find((s) => s.name === "step 1");
	assert.equal(step.spanId, stepSpanId(WF, "s0", 0));
	assert.equal(step.endTimeUnixNano, `${T0 + 11000}000000`);
	assert.equal(step.startTimeUnixNano, `${T0 + 1000}000000`);
	assert.equal(attrOf(step, "target.step.id").stringValue, "s0");
	assert.equal(attrOf(step, "target.step.index").intValue, "0");
	assert.equal(attrOf(step, "target.step.phase").stringValue, "exec");
	assert.equal(attrOf(step, "target.step.retry_count").intValue, "0");
	assert.equal(attrOf(step, "target.step.status").stringValue, "done");
	assert.deepEqual(step.status, { code: 1 });
	assert.ok(spans.some((s) => s.name === "step 2"));

	const session = spans.find((s) => s.name === "invoke_agent claude");
	assert.equal(session.spanId, sessionSpanId(WF, "sess-1"));
	assert.equal(attrOf(session, "gen_ai.operation.name").stringValue, "invoke_agent");
	assert.equal(attrOf(session, "gen_ai.provider.name").stringValue, "claude");
	assert.equal(attrOf(session, "gen_ai.conversation.id").stringValue, "sess-1");
	assert.equal(attrOf(session, "gen_ai.request.model").stringValue, "claude-sonnet-4-5");
	// The LAST snapshot only: output 200k, never 100k + 200k.
	assert.equal(attrOf(session, "gen_ai.usage.output_tokens").intValue, "200000");
	assert.equal(attrOf(session, "gen_ai.usage.input_tokens").intValue, "1000000");
	assert.equal(attrOf(session, "gen_ai.usage.cache_read.input_tokens").intValue, "500000");
	assert.equal(attrOf(session, "gen_ai.usage.cache_write.input_tokens").intValue, "300000");
	// (200k*3 + 300k*3.75 + 500k*0.3 + 200k*15) / 1M
	assert.ok(Math.abs(attrOf(session, "target.cost.usd").doubleValue - 4.875) < 1e-9);
	assert.equal(attrOf(session, "target.cost.partial").boolValue, false);
	assert.equal(attrOf(session, "target.cost.source").stringValue, "pricing");
	assert.ok(Math.abs(attrOf(root, "target.cost.usd").doubleValue - 4.875) < 1e-9);
	assert.equal(attrOf(root, "target.usage.output_tokens").intValue, "200000");
	assert.equal(session.startTimeUnixNano, `${T0 + 5000}000000`);
	assert.equal(session.endTimeUnixNano, `${T0 + 20000}000000`);
});

test("step.judged becomes a span event on the step span", () => {
	const step = spansOf(build(successful())).find((s) => s.name === "step 1");
	assert.equal(step.events.length, 1);
	assert.equal(step.events[0].name, "step.judged");
	assert.deepEqual(step.events[0].attributes, [{ key: "target.step.judge.ok", value: { boolValue: true } }]);
	assert.equal(typeof step.events[0].timeUnixNano, "string");
});

test("failed workflow with a failed step has ERROR status and only the error kind", () => {
	const events = [
		created(0),
		started(1, 0),
		ev("step.failed", 9, {
			step_id: "s0",
			order_index: 0,
			phase: "exec",
			duration_ms: 8000,
			retry_count: 2,
			max_retries: 2,
			error: { kind: "agent_error", message: "SECRET ERROR MESSAGE", retryable: false },
		}),
		status(10, "failed", { error: "SECRET WORKFLOW ERROR" }),
	];
	const spans = spansOf(build(events));
	const root = spans.find((s) => !s.parentSpanId);
	assert.deepEqual(root.status, { code: 2 });
	const step = spans.find((s) => s.name === "step 1");
	assert.deepEqual(step.status, { code: 2 });
	assert.equal(attrOf(step, "target.error.kind").stringValue, "agent_error");
	assert.equal(attrOf(step, "target.step.status").stringValue, "failed");
	assert.equal(attrOf(step, "target.step.retry_count").intValue, "2");
	assert.equal(step.status.message, undefined);
	assert.equal(root.status.message, undefined);
});

test("no terminal status: no root span, children still attach to the root id", () => {
	const events = [created(0), started(1, 0), done(5, 0, 4000), snap(4, "sess-1")];
	const spans = spansOf(build(events));
	assert.equal(spans.length, 2);
	assert.ok(spans.every((s) => s.parentSpanId === rootSpanId(WF)));
	assert.ok(!spans.some((s) => s.spanId === rootSpanId(WF)));
});

test("nothing to export gives null", () => {
	assert.equal(build([]), null);
	assert.equal(build([created(0), started(1, 0)]), null);
	assert.equal(build([ev("heartbeat", 1, {}), ev("workflow.plan", 2, {})]), null);
});

test("20 steps sharing one session: one session span with usage, none on steps", () => {
	const events = [created(0, { step_count: 20 })];
	for (let i = 0; i < 20; i++) events.push(started(i * 10 + 1, i), done(i * 10 + 9, i, 8000));
	events.push(snap(50, "sess-1"), snap(150, "sess-1", { output_tokens: 150_000 }), status(205, "completed"));
	const spans = spansOf(build(events));
	const root = spans.find((s) => !s.parentSpanId);
	const steps = spans.filter((s) => /^step \d+$/.test(s.name));
	const sessions = spans.filter((s) => hasKey(s, /^gen_ai\.usage\./));
	assert.equal(steps.length, 20);
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].name, "invoke_agent claude");
	assert.equal(spans.length, 22);
	for (const s of spans) if (s !== root) assert.equal(s.parentSpanId, root.spanId);
	for (const s of steps) {
		assert.ok(!hasKey(s, /usage|cost|token/), `step ${s.name} must not carry usage or cost`);
	}
	assert.equal(new Set(spans.map((s) => s.spanId)).size, spans.length);
});

test("unpriced usage: tokens exported, no cost, partial=true", () => {
	const events = [created(0, { agent: "cursor" }), snap(5, "s", { model: null }), status(9, "completed")];
	const spans = spansOf(build(events));
	const session = spans.find((s) => hasKey(s, /^gen_ai\.usage\./));
	assert.equal(session.name, "invoke_agent cursor");
	assert.equal(attrOf(session, "target.cost.usd"), undefined);
	assert.equal(attrOf(session, "target.cost.partial").boolValue, true);
	assert.equal(attrOf(session, "target.cost.source").stringValue, "unpriced");
	assert.equal(attrOf(session, "gen_ai.request.model"), undefined);
	assert.equal(attrOf(session, "gen_ai.usage.output_tokens").intValue, "100000");
	const root = spans.find((s) => !s.parentSpanId);
	assert.equal(attrOf(root, "target.cost.usd"), undefined);
	assert.equal(attrOf(root, "target.cost.partial").boolValue, true);
});

test("hub cost wins and is exported as a double even when whole", () => {
	const events = [created(0), snap(5, "s", { cost_usd: 2 }), status(9, "completed")];
	const session = spansOf(build(events)).find((s) => hasKey(s, /^gen_ai\.usage\./));
	assert.deepEqual(attrOf(session, "target.cost.usd"), { doubleValue: 2 });
	assert.equal(attrOf(session, "target.cost.source").stringValue, "hub");
});

test("runner falls back to runnerByWorkflow when the events do not name one", () => {
	const events = [ev("workflow.created", 0, { name: "n", step_count: 1 }), snap(5, "s"), status(9, "completed")];
	const payload = buildTraces({ events, orgId: "o", runnerByWorkflow: { [WF]: "claude" }, options: { rules: RULES } });
	const session = spansOf(payload).find((s) => hasKey(s, /^gen_ai\.usage\./));
	assert.equal(attrOf(session, "gen_ai.provider.name").stringValue, "claude");
	assert.equal(attrOf(session, "target.cost.source").stringValue, "pricing");
});

test("retried step: two attempts give two distinct span ids", () => {
	const events = [
		created(0),
		started(1, 0, 0),
		ev("step.failed", 5, {
			step_id: "s0",
			order_index: 0,
			phase: "exec",
			duration_ms: 4000,
			retry_count: 0,
			max_retries: 2,
			error: { kind: "timeout", message: "x", retryable: true },
		}),
		started(6, 0, 1),
		done(12, 0, 6000, 1),
		status(13, "completed"),
	];
	const steps = spansOf(build(events)).filter((s) => s.name === "step 1");
	assert.equal(steps.length, 2);
	assert.notEqual(steps[0].spanId, steps[1].spanId);
	assert.equal(steps[0].spanId, stepSpanId(WF, "s0", 0));
	assert.equal(steps[1].spanId, stepSpanId(WF, "s0", 1));
	assert.equal(attrOf(steps[0], "target.step.status").stringValue, "failed");
	assert.equal(attrOf(steps[1], "target.step.status").stringValue, "done");
});

test("rebuilding from the same events is idempotent and order independent", () => {
	const events = successful();
	const a = JSON.stringify(build(events));
	const b = JSON.stringify(build([...events].reverse()));
	assert.equal(a, b);
});

test("two sessions in one workflow give two session spans", () => {
	const events = [created(0), snap(5, "a"), snap(6, "b"), status(9, "completed")];
	const spans = spansOf(build(events)).filter((s) => hasKey(s, /^gen_ai\.usage\./));
	assert.equal(spans.length, 2);
	assert.notEqual(spans[0].spanId, spans[1].spanId);
});

test("langfuse option adds the langfuse.* attributes and a chat session span", () => {
	const spans = spansOf(build(successful(), { langfuse: true, userId: "alice@example.com" }));
	const root = spans.find((s) => !s.parentSpanId);
	assert.equal(attrOf(root, "langfuse.user.id").stringValue, "alice@example.com");
	assert.equal(attrOf(root, "langfuse.session.id").stringValue, WF);
	assert.equal(attrOf(root, "langfuse.trace.name").stringValue, root.name);
	const session = spans.find((s) => hasKey(s, /^gen_ai\.usage\./));
	assert.equal(attrOf(session, "gen_ai.operation.name").stringValue, "chat");
	assert.equal(attrOf(session, "langfuse.observation.type").stringValue, "generation");
	assert.deepEqual(JSON.parse(attrOf(session, "langfuse.observation.usage_details").stringValue), {
		input: 1000000,
		output: 200000,
		cache_read_input_tokens: 500000,
		cache_creation_input_tokens: 300000,
	});
	assert.ok(Math.abs(JSON.parse(attrOf(session, "langfuse.observation.cost_details").stringValue).total - 4.875) < 1e-9);
	for (const s of spans.filter((x) => /^step \d+$/.test(x.name))) assert.ok(!hasKey(s, /^langfuse\./));
	// Without the option there is no langfuse attribute anywhere.
	assert.ok(!JSON.stringify(build(successful())).includes("langfuse"));
});

test("privacy: no step text, criteria, error messages or conversation content", () => {
	const forbidden = ["SECRET DESCRIPTION", "SECRET CRITERIA", "SECRET ERROR MESSAGE", "SECRET WORKFLOW ERROR", "SECRET CONVERSATION", "SECRET PROMPT"];
	const events = [
		created(0),
		ev("step.started", 1, { step_id: "s0", order_index: 0, phase: "exec", attempt: 0, max_retries: 1, description: "SECRET DESCRIPTION", prompt: "SECRET PROMPT" }),
		ev("step.failed", 5, {
			step_id: "s0",
			order_index: 0,
			phase: "exec",
			duration_ms: 3000,
			retry_count: 0,
			max_retries: 1,
			description: "SECRET DESCRIPTION",
			error: { kind: "agent_error", message: "SECRET ERROR MESSAGE", retryable: false },
		}),
		ev("step.judged", 6, { step_id: "s0", order_index: 0, ok: false, acceptance_criteria: "SECRET CRITERIA" }),
		snap(4, "sess-1", { conversation: { snapshot: "SECRET CONVERSATION" } }),
		status(10, "failed", { error: "SECRET WORKFLOW ERROR" }),
	];
	for (const options of [{}, { sendContent: false }, { langfuse: true, userId: "u" }, { sendContent: true }]) {
		const text = JSON.stringify(build(events, options));
		for (const word of forbidden) assert.ok(!text.includes(word), `${word} leaked with ${JSON.stringify(options)}`);
	}
	// The workflow name is the only content sendContent unlocks.
	assert.ok(!JSON.stringify(build(events)).includes("Secret Workflow Name"));
	assert.ok(JSON.stringify(build(events, { sendContent: true })).includes("Secret Workflow Name"));
});

test("payload has only hex ids and string timestamps", () => {
	const payload = build(successful(), { langfuse: true, userId: "u" });
	const text = JSON.stringify(payload);
	for (const span of spansOf(payload)) {
		assert.match(span.traceId, /^[0-9a-f]{32}$/);
		assert.match(span.spanId, /^[0-9a-f]{16}$/);
		if (span.parentSpanId) assert.match(span.parentSpanId, /^[0-9a-f]{16}$/);
		assert.equal(typeof span.startTimeUnixNano, "string");
		assert.equal(typeof span.endTimeUnixNano, "string");
		assert.equal(typeof span.kind, "number");
		for (const e of span.events ?? []) assert.equal(typeof e.timeUnixNano, "string");
	}
	assert.ok(!/"(startTimeUnixNano|endTimeUnixNano|timeUnixNano)":\d/.test(text));
	assert.ok(!/"intValue":\d/.test(text));
	assert.deepEqual(payload.resourceSpans[0].resource.attributes.map((a) => a.key), ["service.name", "service.version", "target.org"]);
});

test("target.org.name is on the resource only when sendContent is on, and falls back to the id", () => {
	const resKeys = (payload) => Object.fromEntries(payload.resourceSpans[0].resource.attributes.map((a) => [a.key, a.value.stringValue]));
	const on = build(successful(), { sendContent: true, orgName: "Acme Corp" });
	assert.equal(resKeys(on)["target.org.name"], "Acme Corp");
	assert.equal(resKeys(on)["target.org"], "demo");
	assert.equal(resKeys(build(successful(), { sendContent: true }))["target.org.name"], "demo", "no name given: the id");
	const off = build(successful(), { sendContent: false, orgName: "Acme Corp" });
	assert.ok(!("target.org.name" in resKeys(off)));
	assert.ok(!JSON.stringify(off).includes("Acme Corp"));
	// With the flag off the payload is exactly what it is without any org name.
	assert.deepEqual(off, build(successful(), { sendContent: false }));
});
