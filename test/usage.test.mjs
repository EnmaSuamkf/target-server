/**
 * `usage.snapshot` normalisation: the dashboard must report the same input
 * total the operator's own client reports.
 *
 * Two payload shapes are in play and only one of them can be trusted whole:
 *
 *  - OLD (still sitting in every database): `input_tokens` is the UNCACHED
 *    input only, with `cache_read`/`cache_creation` beside it. Read literally
 *    it says 416 where the client says "in 16.0M".
 *  - NEW: `input_tokens` is already the full total, with the parts kept as
 *    `input_tokens_uncached` / `cache_creation` / `cache_read`.
 *
 * So history is corrected on read (old → sum the parts) and new payloads are
 * passed through untouched (summing them again would count ~16M twice). Both
 * the JS normaliser and the SQL the aggregates use are exercised here, since
 * the fix only works if the two agree.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { once } from "node:events";
import { login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-usage-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";

const { server } = await import("../server.mjs");
const { normalizeUsageSnapshot, isNewUsageShape } = await import("../db.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = "";
after(() => server.close());

before(async () => {
	cookie = await login(base);
});

/** The real session behind this fix, both ways it has been reported. */
const OLD_SHAPE = {
	input_tokens: 416,
	output_tokens: 98599,
	cache_read: 14409380,
	cache_creation: 1605396,
	cost_usd: null,
	compacted: false,
	turns: 143,
};
const NEW_SHAPE = {
	input_tokens: 16015192,
	output_tokens: 98599,
	input_tokens_uncached: 416,
	cache_creation: 1605396,
	cache_read: 14409380,
	context_tokens: 202014,
	context_window: 1000000,
	context_pct: 20.2,
	model: "claude-opus-5",
	turns: 143,
	includes_subagents: true,
	compacted: false,
	cost_usd: null,
};
const TRUE_INPUT = 16015192; // what the client prints as "in 16.0M"

function post(events, instanceId = "inst-usage") {
	return fetch(`${base}/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			batch_id: `b-${Math.random()}`,
			instance_id: instanceId,
			version: "0.2.0",
			schema_version: 1,
			sent_at: new Date().toISOString(),
			user: { display_name: "Ada" },
			events,
		}),
	});
}

const snapshot = (id, workflowId, sessionId, data) => ({
	id,
	kind: "usage.snapshot",
	workflow_id: workflowId,
	session_id: sessionId,
	created_at: new Date().toISOString(),
	data,
});

test("old-shape payloads: the cached input is added back", () => {
	const u = normalizeUsageSnapshot(OLD_SHAPE);
	assert.equal(isNewUsageShape(OLD_SHAPE), false);
	assert.equal(u.inputTokens, TRUE_INPUT);
	assert.equal(u.inputTokensUncached, 416);
	assert.equal(u.outputTokens, 98599);
	assert.equal(u.turns, 143);
	// Nothing the old shape never carried is invented.
	assert.equal(u.contextWindow, 0);
	assert.equal(u.model, null);
	assert.equal(u.includesSubagents, false);
});

test("new-shape payloads pass through — the total is not counted twice", () => {
	const u = normalizeUsageSnapshot(NEW_SHAPE);
	assert.equal(isNewUsageShape(NEW_SHAPE), true);
	assert.equal(u.inputTokens, TRUE_INPUT);
	assert.notEqual(u.inputTokens, TRUE_INPUT + 1605396 + 14409380);
	assert.equal(u.inputTokensUncached, 416);
	assert.equal(u.contextTokens, 202014);
	assert.equal(u.contextWindow, 1000000);
	assert.equal(u.contextPct, 20.2);
	assert.equal(u.model, "claude-opus-5");
	assert.equal(u.includesSubagents, true);
});

test("a payload with a context window but no uncached field is still new-shape", () => {
	// Defensive: `context_window` alone identifies the new hub.
	const u = normalizeUsageSnapshot({ input_tokens: 900, output_tokens: 5, cache_read: 800, context_window: 200000, context_tokens: 100000 });
	assert.equal(u.inputTokens, 900);
	assert.equal(u.contextPct, 50);
});

test("missing/garbage fields degrade to zeros instead of NaN", () => {
	const u = normalizeUsageSnapshot({});
	assert.equal(u.inputTokens, 0);
	assert.equal(u.outputTokens, 0);
	assert.equal(u.contextPct, 0);
	assert.equal(normalizeUsageSnapshot(null).inputTokens, 0);
	assert.equal(normalizeUsageSnapshot({ input_tokens: "lots", cache_read: null }).inputTokens, 0);
});

test("the aggregates apply the same rule in SQL: old rows read 16.0M, not 416", async () => {
	await post([snapshot("u-old-1", "wf-old", "sess-old", OLD_SHAPE)]);
	const s = await (await fetch(`${base}/api/stats?workflow=wf-old`, { headers: { cookie } })).json();
	assert.equal(s.usage.inputTokens, TRUE_INPUT);
	assert.equal(s.usage.outputTokens, 98599);

	const list = await (await fetch(`${base}/api/workflows`, { headers: { cookie } })).json();
	const wf = list.workflows.find((w) => w.workflowId === "wf-old");
	assert.deepEqual(wf.tokens, { input: TRUE_INPUT, output: 98599 });
});

test("new-shape rows are summed as-is, and carry the client's readout to the detail", async () => {
	await post([snapshot("u-new-1", "wf-new", "sess-new", NEW_SHAPE)]);
	const s = await (await fetch(`${base}/api/stats?workflow=wf-new`, { headers: { cookie } })).json();
	assert.equal(s.usage.inputTokens, TRUE_INPUT); // not 16M + the parts again

	const detail = await (await fetch(`${base}/api/workflows/wf-new`, { headers: { cookie } })).json();
	assert.equal(detail.usage.inputTokens, TRUE_INPUT);
	assert.equal(detail.usage.sessions.length, 1);
	const [u] = detail.usage.sessions;
	assert.equal(u.sessionId, "sess-new");
	assert.equal(u.turns, 143);
	assert.equal(u.contextTokens, 202014);
	assert.equal(u.contextWindow, 1000000);
	assert.equal(u.model, "claude-opus-5");
	assert.equal(u.includesSubagents, true);
});

test("snapshots are cumulative: the LAST one per session wins, they are not summed", async () => {
	// Three rising snapshots of one session, exactly how the hub re-reads a
	// transcript. Summing them would report 3.1M where 2M was spent.
	await post([
		snapshot("c-1", "wf-cum", "sess-cum", { input_tokens: 100, output_tokens: 10, cache_read: 499900, turns: 1 }),
		snapshot("c-2", "wf-cum", "sess-cum", { input_tokens: 200, output_tokens: 20, cache_read: 999800, turns: 2 }),
		snapshot("c-3", "wf-cum", "sess-cum", { input_tokens: 300, output_tokens: 30, cache_read: 1999700, turns: 3 }),
	]);
	const s = await (await fetch(`${base}/api/stats?workflow=wf-cum`, { headers: { cookie } })).json();
	assert.equal(s.usage.inputTokens, 2000000);
	assert.equal(s.usage.outputTokens, 30);

	const detail = await (await fetch(`${base}/api/workflows/wf-cum`, { headers: { cookie } })).json();
	assert.equal(detail.usage.sessions.length, 1);
	assert.equal(detail.usage.sessions[0].turns, 3);
	assert.equal(detail.usage.inputTokens, 2000000);
});

test("separate sessions of one workflow ARE summed, newest session first", async () => {
	await post([
		snapshot("m-1", "wf-multi", "sess-a", { input_tokens: 1, output_tokens: 2, cache_read: 999, turns: 5 }),
		snapshot("m-2", "wf-multi", "sess-b", NEW_SHAPE),
	]);
	const detail = await (await fetch(`${base}/api/workflows/wf-multi`, { headers: { cookie } })).json();
	assert.equal(detail.usage.sessions.length, 2);
	assert.equal(detail.usage.inputTokens, 1000 + TRUE_INPUT);
	assert.equal(detail.usage.outputTokens, 2 + 98599);
	const s = await (await fetch(`${base}/api/stats?workflow=wf-multi`, { headers: { cookie } })).json();
	assert.equal(s.usage.inputTokens, detail.usage.inputTokens);
});

test("a workflow with no snapshots reports an empty usage block, not a crash", async () => {
	await post([{ id: "n-1", kind: "workflow.created", workflow_id: "wf-none", created_at: new Date().toISOString(), data: { name: "quiet" } }]);
	const detail = await (await fetch(`${base}/api/workflows/wf-none`, { headers: { cookie } })).json();
	assert.deepEqual(detail.usage, { inputTokens: 0, outputTokens: 0, sessions: [] });
});
