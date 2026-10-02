/**
 * Pure pricing maths and rule resolution (no server, no DB).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCost, priceSession, resolveRule, sumCosts } from "../pricing.mjs";

const rule = (o) => ({
	id: 1,
	agent: "*",
	model: "*",
	inputPerMtok: 3,
	outputPerMtok: 15,
	cacheReadPerMtok: null,
	cacheWritePerMtok: null,
	effectiveFrom: "",
	...o,
});
const usage = (o) => ({
	inputTokens: 0,
	inputTokensUncached: 0,
	cacheCreation: 0,
	cacheRead: 0,
	outputTokens: 0,
	model: null,
	costUsd: null,
	...o,
});
const NOW = "2026-06-01T00:00:00Z";

test("computeCost prices the four buckets separately", () => {
	const r = rule({ inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75 });
	const u = usage({ inputTokensUncached: 1e6, cacheCreation: 2e6, cacheRead: 10e6, outputTokens: 1e6 });
	assert.ok(Math.abs(computeCost(r, u) - (3 + 7.5 + 3 + 15)) < 1e-9);
});

test("cache_read is NOT billed at the input rate", () => {
	const r = rule({ inputPerMtok: 15, outputPerMtok: 75, cacheReadPerMtok: 1.5 });
	const u = usage({ inputTokens: 59e6, inputTokensUncached: 2e6, cacheRead: 57e6 });
	const naive = (59e6 * 15) / 1e6;
	const cost = computeCost(r, u);
	assert.ok(Math.abs(cost - (2 * 15 + 57 * 1.5)) < 1e-9);
	assert.ok(naive / cost > 7);
});

test("null cache rates fall back to the input rate", () => {
	const r = rule({ inputPerMtok: 4, outputPerMtok: 0 });
	const u = usage({ inputTokensUncached: 1e6, cacheCreation: 1e6, cacheRead: 1e6 });
	assert.equal(computeCost(r, u), 12);
});

test("model specificity: exact > longest glob > *", () => {
	const rules = [
		rule({ id: 1, model: "*" }),
		rule({ id: 2, model: "claude-*" }),
		rule({ id: 3, model: "claude-opus-*" }),
		rule({ id: 4, model: "claude-opus-4" }),
	];
	const pick = (model) => resolveRule(rules, { agent: "claude", model, at: NOW })?.id;
	assert.equal(pick("claude-opus-4"), 4);
	assert.equal(pick("claude-opus-5"), 3);
	assert.equal(pick("claude-sonnet-5"), 2);
	assert.equal(pick("gpt-x"), 1);
});

test("model specificity outranks agent specificity; agent exact beats *", () => {
	const rules = [
		rule({ id: 1, agent: "claude", model: "*" }),
		rule({ id: 2, agent: "*", model: "m1" }),
		rule({ id: 3, agent: "*", model: "m2" }),
		rule({ id: 4, agent: "cursor", model: "m2" }),
	];
	assert.equal(resolveRule(rules, { agent: "claude", model: "m1", at: NOW }).id, 2);
	assert.equal(resolveRule(rules, { agent: "cursor", model: "m2", at: NOW }).id, 4);
	assert.equal(resolveRule(rules, { agent: "claude", model: "m2", at: NOW }).id, 3);
	assert.equal(resolveRule(rules, { agent: "claude", model: null, at: NOW }).id, 1);
});

test("a rule for another agent never matches", () => {
	assert.equal(resolveRule([rule({ agent: "cursor" })], { agent: "claude", model: "m", at: NOW }), null);
	assert.equal(resolveRule([rule({ agent: "cursor" })], { agent: null, model: "m", at: NOW }), null);
});

test("effectiveFrom gates rules and the newest eligible one wins ties", () => {
	const rules = [
		rule({ id: 1, effectiveFrom: "" }),
		rule({ id: 2, effectiveFrom: "2026-01-01T00:00:00Z" }),
		rule({ id: 3, effectiveFrom: "2026-09-01T00:00:00Z" }),
	];
	const at = (t) => resolveRule(rules, { agent: "claude", model: "m", at: t }).id;
	assert.equal(at("2025-12-31T00:00:00Z"), 1);
	assert.equal(at("2026-02-01T00:00:00Z"), 2);
	assert.equal(at("2026-09-01T00:00:00Z"), 3);
	assert.equal(resolveRule([rules[2]], { agent: "claude", model: "m", at: "2026-02-01T00:00:00Z" }), null);
});

test("a more specific old rule still beats a newer generic one", () => {
	const rules = [
		rule({ id: 1, model: "m", effectiveFrom: "2020-01-01T00:00:00Z" }),
		rule({ id: 2, model: "*", effectiveFrom: "2026-01-01T00:00:00Z" }),
	];
	assert.equal(resolveRule(rules, { agent: "claude", model: "m", at: NOW }).id, 1);
});

test("null model matches only model '*'", () => {
	const specific = [rule({ model: "claude-*" }), rule({ id: 2, model: "claude-opus-4" })];
	assert.equal(resolveRule(specific, { agent: "claude", model: null, at: NOW }), null);
	const any = [...specific, rule({ id: 3, model: "*" })];
	assert.equal(resolveRule(any, { agent: "claude", model: null, at: NOW }).id, 3);
});

test("hub cost_usd wins over a matching rule", () => {
	const p = priceSession([rule()], { agent: "claude", at: NOW, usage: usage({ costUsd: 1.25, outputTokens: 1e6 }) });
	assert.deepEqual(p, { costUsd: 1.25, source: "hub" });
	assert.equal(priceSession([], { agent: "claude", at: NOW, usage: usage({ costUsd: 0 }) }).source, "hub");
});

test("rule pricing is used when the hub sent no cost", () => {
	const p = priceSession([rule()], { agent: "claude", at: NOW, usage: usage({ outputTokens: 1e6 }) });
	assert.deepEqual(p, { costUsd: 15, source: "pricing" });
});

test("no rule is null/unpriced, distinct from a genuine zero", () => {
	const none = priceSession([], { agent: "claude", at: NOW, usage: usage({ outputTokens: 1e6 }) });
	assert.deepEqual(none, { costUsd: null, source: "unpriced" });
	const zero = priceSession([rule()], { agent: "claude", at: NOW, usage: usage() });
	assert.equal(zero.costUsd, 0);
	assert.equal(zero.source, "pricing");
});

test("sumCosts: null when nothing priced, partial counts unpriced", () => {
	assert.deepEqual(sumCosts([]), { costUsd: null, unpricedSessions: 0 });
	assert.deepEqual(sumCosts([{ costUsd: null }, { costUsd: null }]), { costUsd: null, unpricedSessions: 2 });
	assert.deepEqual(sumCosts([{ costUsd: 1.5 }, { costUsd: null }, { costUsd: 0 }]), { costUsd: 1.5, unpricedSessions: 1 });
	assert.deepEqual(sumCosts([{ costUsd: 0 }]), { costUsd: 0, unpricedSessions: 0 });
});

test("docs/copilot-pricing-rules.json passes the import schema and prices copilot models", async () => {
	const { readFileSync } = await import("node:fs");
	const { validate } = await import("../blueprint.mjs");
	const file = JSON.parse(readFileSync(new URL("../docs/copilot-pricing-rules.json", import.meta.url), "utf8"));
	const v = validate("pricing.import", file);
	assert.equal(v.ok, true, JSON.stringify(v.errors));
	const rules = v.value.rules;
	assert.ok(rules.length > 0 && rules.every((r) => r.agent === "copilot"));

	const haiku = resolveRule(rules, { agent: "copilot", model: "claude-haiku-4.5" });
	assert.equal(haiku.inputPerMtok, 1);
	assert.equal(haiku.cacheReadPerMtok, 0.1);
	assert.equal(haiku.cacheWritePerMtok, 1.25);
	assert.equal(haiku.outputPerMtok, 5);

	const gpt = resolveRule(rules, { agent: "copilot", model: "gpt-5.4" });
	assert.deepEqual(
		[gpt.inputPerMtok, gpt.cacheReadPerMtok, gpt.cacheWritePerMtok, gpt.outputPerMtok],
		[2.5, 0.25, null, 15],
	);

	// unknown model, and another runner with the same model name: unpriced (null), not zero
	assert.equal(resolveRule(rules, { agent: "copilot", model: "some-future-model" }), null);
	assert.equal(resolveRule(rules, { agent: "claude", model: "claude-haiku-4.5" }), null);
});
