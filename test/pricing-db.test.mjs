/**
 * Pricing storage and cost-at-read: the price table CRUD/import, and the
 * numbers the dashboard reads once a rule exists. Cost is never stored on
 * events, so these tests ingest first and price later.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-pricing-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";

const { server } = await import("../server.mjs");
const db = await import("../db.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = "";
after(() => server.close());
before(async () => {
	cookie = await login(base);
});

const rule = (o = {}) => ({ agent: "claude", model: "*", inputPerMtok: 3, outputPerMtok: 15, ...o });
const clearRules = () => db.importPricingRules([], "replace");

function post(events) {
	return fetch(`${base}/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			batch_id: `b-${Math.random()}`,
			instance_id: "inst-pricing",
			version: "0.2.0",
			schema_version: 1,
			sent_at: new Date().toISOString(),
			user: { display_name: "Ada" },
			events,
		}),
	});
}
let seq = 0;
const ev = (kind, workflowId, sessionId, data) => ({
	id: `pe-${++seq}`,
	kind,
	workflow_id: workflowId,
	session_id: sessionId,
	created_at: new Date().toISOString(),
	data,
});
const created = (wf, agent) => ev("workflow.created", wf, null, { name: wf, agent });
const snap = (wf, sess, data) => ev("usage.snapshot", wf, sess, data);
// Old-shape payload: input_tokens is the uncached part only.
const usageData = (uncached, cacheRead, output, extra = {}) => ({
	input_tokens: uncached,
	cache_read: cacheRead,
	cache_creation: 0,
	output_tokens: output,
	model: null,
	cost_usd: null,
	...extra,
});
const get = async (url) => (await fetch(`${base}${url}`, { headers: { cookie } })).json();
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);

test("the migration is idempotent: reopening an existing DB keeps the rules", () => {
	clearRules();
	const r = db.createPricingRule(rule({ model: "claude-opus-*" }));
	// Dropping the cached handle makes the next open() re-run every migration
	// against the file that already has the table.
	db.closeOrgDbByPath(tmpDb);
	assert.deepEqual(db.listPricingRules().map((x) => x.id), [r.id]);
});

test("CRUD round-trips camelCase fields and defaults", () => {
	clearRules();
	const r = db.createPricingRule({ inputPerMtok: 1, outputPerMtok: 2 });
	assert.equal(r.agent, "*");
	assert.equal(r.model, "*");
	assert.equal(r.effectiveFrom, "");
	assert.equal(r.cacheReadPerMtok, null);
	assert.equal(r.cacheWritePerMtok, null);
	const u = db.updatePricingRule(r.id, { ...r, cacheReadPerMtok: 0.1, cacheWritePerMtok: 1.25, inputPerMtok: 5 });
	assert.equal(u.inputPerMtok, 5);
	assert.equal(u.cacheReadPerMtok, 0.1);
	assert.equal(db.getPricingRule(r.id).cacheWritePerMtok, 1.25);
	assert.equal(db.updatePricingRule(99999, rule()), null);
	assert.equal(db.deletePricingRule(r.id), true);
	assert.equal(db.deletePricingRule(r.id), false);
	assert.equal(db.getPricingRule(r.id), null);
});

test("a duplicate (agent, model, effectiveFrom) is a 409 duplicate_rule", () => {
	clearRules();
	db.createPricingRule(rule());
	assert.throws(() => db.createPricingRule(rule()), (e) => e.statusCode === 409 && e.code === "duplicate_rule");
	const other = db.createPricingRule(rule({ model: "x" }));
	assert.throws(() => db.updatePricingRule(other.id, rule()), (e) => e.statusCode === 409 && e.code === "duplicate_rule");
	// Same key at a different effective date is a different rule.
	db.createPricingRule(rule({ effectiveFrom: "2026-01-01T00:00:00Z" }));
});

test("import replace swaps the table; a bad row rolls the whole thing back", () => {
	clearRules();
	db.createPricingRule(rule({ model: "keep" }));
	assert.equal(db.importPricingRules([rule({ model: "a" }), rule({ model: "b" })], "replace"), 2);
	assert.deepEqual(db.listPricingRules().map((r) => r.model), ["a", "b"]);
	// The second row violates NOT NULL after the DELETE and the first insert ran.
	assert.throws(() => db.importPricingRules([rule({ model: "z" }), rule({ model: "bad", inputPerMtok: null })], "replace"));
	assert.deepEqual(db.listPricingRules().map((r) => r.model), ["a", "b"]);
});

test("import merge upserts on the unique key and leaves other rules alone", () => {
	clearRules();
	db.createPricingRule(rule({ model: "a", inputPerMtok: 1 }));
	db.createPricingRule(rule({ model: "b", inputPerMtok: 2 }));
	db.importPricingRules([rule({ model: "a", inputPerMtok: 9 }), rule({ model: "c", inputPerMtok: 3 })], "merge");
	const byModel = Object.fromEntries(db.listPricingRules().map((r) => [r.model, r.inputPerMtok]));
	assert.deepEqual(byModel, { a: 9, b: 2, c: 3 });
});

test("unpriced first: costUsd is null (not 0) and the unpriced session is counted", async () => {
	clearRules();
	await post([created("wf-unp", "claude"), snap("wf-unp", "s1", usageData(2e6, 57e6, 3e5))]);
	const detail = await get("/api/workflows/wf-unp");
	assert.equal(detail.usage.costUsd, null);
	assert.equal(detail.usage.unpricedSessions, 1);
	assert.equal(detail.usage.sessions[0].costUsd, null);
	assert.equal(detail.usage.sessions[0].costSource, "unpriced");
	const row = (await get("/api/workflows")).workflows.find((w) => w.workflowId === "wf-unp");
	assert.equal(row.costUsd, null);
	assert.equal(row.costPartial, false);
	const s = await get("/api/stats?workflow=wf-unp");
	assert.equal(s.usage.costUsd, null);
	assert.equal(s.usage.unpricedSessions, 1);
});

test("unpricedUsage lists the (agent, model) pair that matches no rule", async () => {
	clearRules();
	await post([created("wf-pair", "cursor"), snap("wf-pair", "sp", usageData(100, 900, 50, { model: "gpt-9" }))]);
	const pair = db.unpricedUsage().find((p) => p.agent === "cursor" && p.model === "gpt-9");
	assert.ok(pair);
	assert.equal(pair.sessions, 1);
	assert.equal(pair.inputTokens, 1000);
	assert.equal(pair.outputTokens, 50);
	// The claude/null sessions from the earlier test are listed under their own pair.
	assert.ok(db.unpricedUsage().some((p) => p.agent === "claude" && p.model === null));
	db.createPricingRule(rule({ agent: "cursor", model: "gpt-*" }));
	assert.equal(db.unpricedUsage().some((p) => p.agent === "cursor" && p.model === "gpt-9"), false);
});

test("adding a rule prices history: 2M uncached / 57M cache_read / 300k out", async () => {
	clearRules();
	db.createPricingRule(rule({ inputPerMtok: 15, outputPerMtok: 75, cacheReadPerMtok: 1.5 }));
	const detail = await get("/api/workflows/wf-unp");
	const expected = 2 * 15 + 57 * 1.5 + 0.3 * 75;
	near(detail.usage.costUsd, expected);
	assert.equal(detail.usage.unpricedSessions, 0);
	assert.equal(detail.usage.sessions[0].costSource, "pricing");
	// Not the naive all-input-at-input-rate figure.
	assert.ok(Math.abs(detail.usage.costUsd - (59 * 15 + 0.3 * 75)) > 100);
	const row = (await get("/api/workflows")).workflows.find((w) => w.workflowId === "wf-unp");
	near(row.costUsd, expected);
	assert.equal(row.costPartial, false);
	near((await get("/api/stats?workflow=wf-unp")).usage.costUsd, expected);
});

test("editing a rule reprices already-ingested events", async () => {
	clearRules();
	const r = db.createPricingRule(rule({ inputPerMtok: 10, outputPerMtok: 10, cacheReadPerMtok: 1 }));
	near((await get("/api/workflows/wf-unp")).usage.costUsd, 2 * 10 + 57 * 1 + 0.3 * 10);
	db.updatePricingRule(r.id, { ...r, inputPerMtok: 4, outputPerMtok: 20, cacheReadPerMtok: 0.5 });
	near((await get("/api/workflows/wf-unp")).usage.costUsd, 2 * 4 + 57 * 0.5 + 0.3 * 20);
});

test("cumulative snapshots of one session are not summed", async () => {
	clearRules();
	db.createPricingRule(rule({ inputPerMtok: 1, outputPerMtok: 1, cacheReadPerMtok: 1 }));
	await post([
		created("wf-cum2", "claude"),
		snap("wf-cum2", "sc", usageData(1e6, 0, 0)),
		snap("wf-cum2", "sc", usageData(2e6, 0, 0)),
		snap("wf-cum2", "sc", usageData(3e6, 0, 1e6)),
	]);
	const detail = await get("/api/workflows/wf-cum2");
	assert.equal(detail.usage.sessions.length, 1);
	near(detail.usage.costUsd, 3 + 1);
	near((await get("/api/stats?workflow=wf-cum2")).usage.costUsd, 4);
});

test("two sessions are summed; a half-priced workflow is a lower bound", async () => {
	clearRules();
	db.createPricingRule(rule({ agent: "claude", model: "m-known", inputPerMtok: 2, outputPerMtok: 2 }));
	await post([
		created("wf-two", "claude"),
		snap("wf-two", "a", usageData(1e6, 0, 0, { model: "m-known" })),
		snap("wf-two", "b", usageData(1e6, 0, 0, { model: "m-other" })),
	]);
	let detail = await get("/api/workflows/wf-two");
	near(detail.usage.costUsd, 2);
	assert.equal(detail.usage.unpricedSessions, 1);
	let row = (await get("/api/workflows")).workflows.find((w) => w.workflowId === "wf-two");
	near(row.costUsd, 2);
	assert.equal(row.costPartial, true);
	db.createPricingRule(rule({ agent: "claude", model: "*", inputPerMtok: 5, outputPerMtok: 5 }));
	detail = await get("/api/workflows/wf-two");
	near(detail.usage.costUsd, 2 + 5);
	assert.equal(detail.usage.unpricedSessions, 0);
	row = (await get("/api/workflows")).workflows.find((w) => w.workflowId === "wf-two");
	assert.equal(row.costPartial, false);
});

test("hub cost_usd wins over rules; an agent in the snapshot beats the workflow's", async () => {
	clearRules();
	db.createPricingRule(rule({ agent: "cursor", inputPerMtok: 100, outputPerMtok: 0 }));
	await post([
		created("wf-hub", "claude"),
		snap("wf-hub", "h", usageData(1e6, 0, 0, { cost_usd: 1.5 })),
		created("wf-agent", "claude"),
		snap("wf-agent", "g", usageData(1e6, 0, 0, { agent: "cursor" })),
	]);
	const hub = (await get("/api/workflows/wf-hub")).usage;
	near(hub.costUsd, 1.5);
	assert.equal(hub.sessions[0].costSource, "hub");
	// Workflow announced claude (no rule), the snapshot says cursor (priced).
	near((await get("/api/workflows/wf-agent")).usage.costUsd, 100);
});
