/**
 * Pre-run cost estimates: percentiles over completed, priced history, the
 * template -> agent_model -> agent fallback, and the exclusions.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { percentile, stepCostDeltas } from "../estimates.mjs";
import { login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-estimate-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
const db = await import("../db.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = "";
after(() => server.close());

const json = (method, body, c) => ({
	method,
	headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
	body: JSON.stringify(body),
});

let seq = 0;
const ev = (kind, workflowId, sessionId, data) => ({
	id: `est-${++seq}`,
	kind,
	workflow_id: workflowId,
	session_id: sessionId,
	created_at: new Date().toISOString(),
	data,
});
async function ingest(events) {
	const res = await fetch(`${base}/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			batch_id: `b-${Math.random()}`,
			instance_id: "inst-est",
			version: "0.2.0",
			schema_version: 1,
			sent_at: new Date().toISOString(),
			user: { display_name: "Ada" },
			events,
		}),
	});
	assert.equal(res.status, 200);
}

/**
 * One workflow whose cumulative cost after each snapshot is `costs` — priced
 * at $1 per million output tokens, so `10` means 10M output tokens.
 */
async function seed(id, { agent, model = null, costs, status = "completed", steps = 2, templateId = null }) {
	const events = [ev("workflow.created", id, null, { name: id, agent })];
	for (let i = 0; i < steps; i++) events.push(ev("step.added", id, null, { step_id: `${id}-s${i}`, order_index: i, description: "x" }));
	for (const c of costs) {
		events.push(ev("usage.snapshot", id, `sess-${id}`, { input_tokens: 0, output_tokens: c * 1e6, cache_read: 0, cache_creation: 0, model, cost_usd: null }));
	}
	events.push(ev("workflow.status_changed", id, null, { to: status }));
	await ingest(events);
	if (templateId) {
		const r = db.createRemoteWorkflow({ clientId: "c1", name: id, templateId });
		db.updateRemoteWorkflowLocalId({ remoteId: r.id, clientId: "c1", localId: id });
	}
}

const estimateOf = async (query, c = cookie) => {
	const res = await fetch(`${base}/api/pricing/estimate?${new URLSearchParams(query)}`, { headers: c ? { cookie: c } : {} });
	return { status: res.status, body: await res.json() };
};

before(async () => {
	cookie = await login(base);
	db.importPricingRules([{ agent: "claude", model: "*", inputPerMtok: 1, outputPerMtok: 1 }, { agent: "cursor", model: "*", inputPerMtok: 1, outputPerMtok: 1 }], "replace");
	await seed("w1", { agent: "claude", model: "m-a", costs: [10], templateId: "tpl-T" });
	await seed("w2", { agent: "claude", model: "m-a", costs: [20], templateId: "tpl-T" });
	await seed("w3", { agent: "claude", model: "m-a", costs: [30], templateId: "tpl-T" });
	// 30 → 12 is a compaction: the cumulative figure fell, the run still ends at 40.
	await seed("w4", { agent: "claude", model: "m-b", costs: [30, 12, 40] });
	await seed("w-run", { agent: "claude", model: "m-a", costs: [1000], status: "running", templateId: "tpl-T" });
	await seed("w-free", { agent: "free-code", costs: [500] }); // no rule for free-code: unpriced
	await seed("c1", { agent: "cursor", costs: [5] });
	await seed("c2", { agent: "cursor", costs: [7] });
});

test("percentile interpolates linearly between closest ranks", () => {
	assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
	assert.equal(percentile([10, 20, 30], 0.9), 28);
	assert.equal(percentile([30, 10, 20], 0.5), 20);
	assert.equal(percentile([7], 0.9), 7);
	assert.equal(percentile([], 0.5), null);
});

test("stepCostDeltas clamps a compaction drop at zero", () => {
	assert.deepEqual(stepCostDeltas([30, 12, 40]), [30, 0, 28]);
	assert.deepEqual(stepCostDeltas([5, 9]), [5, 4]);
});

test("template basis: exact p50/p90 over the runs created from the template", async () => {
	const { status, body } = await estimateOf({ templateId: "tpl-T", agent: "claude" });
	assert.equal(status, 200);
	assert.equal(body.basis, "template");
	assert.equal(body.sampleSize, 3); // the running w-run is not history
	assert.equal(body.p50, 20);
	assert.equal(body.p90, 28);
	assert.equal(body.scaledBy, null);
});

test("agent_model basis when there is no template", async () => {
	const { body } = await estimateOf({ agent: "claude", model: "m-a" });
	assert.equal(body.basis, "agent_model");
	assert.equal(body.sampleSize, 3);
	assert.equal(body.p50, 20);
	assert.equal(body.p90, 28);
	assert.deepEqual(body.perStep, { p50: 20, p90: 28 });
});

test("falls back to the next broader basis when the narrower one has < 3 samples", async () => {
	// Model m-b has one run: agent_model is too thin, so the agent basis answers.
	const modelFallback = (await estimateOf({ agent: "claude", model: "m-b" })).body;
	assert.equal(modelFallback.basis, "agent");
	assert.equal(modelFallback.sampleSize, 4);
	assert.equal(modelFallback.p50, 25); // [10, 20, 30, 40]
	assert.equal(modelFallback.p90, 37);
	// An unknown template falls through the same way.
	const tplFallback = (await estimateOf({ templateId: "tpl-unknown", agent: "claude", model: "m-a" })).body;
	assert.equal(tplFallback.basis, "agent_model");
	const tplToAgent = (await estimateOf({ templateId: "tpl-unknown", agent: "claude" })).body;
	assert.equal(tplToAgent.basis, "agent");
	assert.equal(tplToAgent.sampleSize, 4);
});

test("insufficient_data below 3 samples, even on the broadest basis", async () => {
	assert.deepEqual((await estimateOf({ agent: "cursor" })).body, { status: "insufficient_data", sampleSize: 2 });
	assert.deepEqual((await estimateOf({ templateId: "tpl-unknown" })).body, { status: "insufficient_data", sampleSize: 0 });
});

test("unfinished and fully unpriced workflows are excluded", async () => {
	// w-run ($1000, running) would push claude to 5 samples and p90 well above 37.
	assert.equal((await estimateOf({ agent: "claude" })).body.sampleSize, 4);
	assert.equal((await estimateOf({ agent: "claude" })).body.p90, 37);
	// w-free is completed but has no price rule: nothing to learn from.
	assert.deepEqual((await estimateOf({ agent: "free-code" })).body, { status: "insufficient_data", sampleSize: 0 });
});

test("per-step costs clamp a compaction drop at 0", async () => {
	// Steps: [10] [20] [30] and w4's [30, 0, 28]. Unclamped, w4 would add -18.
	const { body } = await estimateOf({ agent: "claude" });
	assert.deepEqual(body.perStep, { p50: 24, p90: 30 });
});

test("steps scales by steps / median historical steps, only when both are known", async () => {
	const scaled = (await estimateOf({ agent: "claude", model: "m-a", steps: "4" })).body; // history: 2 steps
	assert.equal(scaled.scaledBy, 2);
	assert.equal(scaled.p50, 40);
	assert.equal(scaled.p90, 56);
	assert.equal((await estimateOf({ agent: "claude", model: "m-a" })).body.scaledBy, null);
});

test("query validation: 422 without a grouping key, or model without agent", async () => {
	assert.equal((await estimateOf({ steps: "3" })).status, 422);
	assert.equal((await estimateOf({ model: "m-a" })).status, 422);
	assert.equal((await estimateOf({ agent: "claude", steps: "0" })).status, 422);
});

test("401 without a session, 403 without pricing.read", async () => {
	assert.equal((await estimateOf({ agent: "claude" }, "")).status, 401);
	const roleRes = await fetch(`${base}/api/auth/roles`, json("POST", { name: "edit-only", permissions: ["pricing.edit"] }, cookie));
	const role = (await roleRes.json()).role;
	const inviteRes = await fetch(`${base}/api/auth/users`, json("POST", { email: "edit-only@example.com", role_id: role.id }, cookie));
	const token = new URL((await inviteRes.json()).invite.setupUrl).searchParams.get("token");
	const setup = await fetch(`${base}/api/auth/setup`, json("POST", { token, password: "correct-horse-battery" }));
	const limited = setup.headers.get("set-cookie").split(";")[0];
	assert.equal((await estimateOf({ agent: "claude" }, limited)).status, 403);
});
