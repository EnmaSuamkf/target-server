/**
 * Token pricing: pure functions that turn a usage total into dollars.
 *
 * No storage and no I/O on purpose: the rules come in as plain objects and the
 * cost is computed at READ time, never stored on events. That is what lets an
 * edited rule reprice history, and `effectiveFrom` keep old sessions on the
 * tariff that applied when they ran.
 *
 * A rule is `{id, agent, model, inputPerMtok, outputPerMtok, cacheReadPerMtok,
 * cacheWritePerMtok, effectiveFrom}` (USD per million tokens). `agent` is the
 * RUNNER (claude | free-code | cursor | copilot), not the LLM, so the real key is
 * (agent, model) with `*` as "any". `usage` is what `normalizeUsageSnapshot`
 * in db.mjs returns.
 *
 * "No tariff" is `null`, never 0: a zero would read as "free" on the dashboard.
 */

const MTOK = 1_000_000;
const ANY = "*";

/** Instant → epoch ms; '' / null = "always" (-Infinity), unparseable = never eligible. */
function instant(value) {
	if (value == null || value === "") return Number.NEGATIVE_INFINITY;
	const t = Date.parse(value);
	return Number.isNaN(t) ? Number.NaN : t;
}

/**
 * How specifically a rule's model pattern matches, or -1 for no match:
 * exact beats a prefix glob (longer prefix wins) beats `*`. A null model has no
 * name to compare, so only `*` can match it.
 */
function modelScore(pattern, model) {
	if (pattern === ANY) return 0;
	if (typeof model !== "string" || model === "" || typeof pattern !== "string") return -1;
	if (pattern.endsWith("*")) {
		const prefix = pattern.slice(0, -1);
		return model.startsWith(prefix) ? 1 + prefix.length : -1;
	}
	return pattern === model ? Number.MAX_SAFE_INTEGER : -1;
}

function agentScore(pattern, agent) {
	if (pattern === ANY) return 0;
	return typeof agent === "string" && pattern === agent ? 1 : -1;
}

/**
 * The most specific eligible rule for (agent, model) at instant `at`, or null.
 * Order: model specificity, then agent specificity, then newest `effectiveFrom`.
 * A rule whose `effectiveFrom` is after `at` has not started yet.
 */
export function resolveRule(rules, { agent = null, model = null, at = null } = {}) {
	const atMs = at == null || at === "" ? Date.now() : Date.parse(at);
	let best = null;
	let bestKey = null;
	for (const rule of rules ?? []) {
		const from = instant(rule.effectiveFrom);
		if (Number.isNaN(from) || (!Number.isNaN(atMs) && from > atMs)) continue;
		const m = modelScore(rule.model, model);
		const a = agentScore(rule.agent, agent);
		if (m < 0 || a < 0) continue;
		const key = [m, a, from];
		if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))) {
			best = rule;
			bestKey = key;
		}
	}
	return best;
}

/**
 * Dollars for one usage total under one rule. Four buckets are priced apart:
 * uncached input, cache creation (write rate), cache read (read rate), output.
 * A null cache rate falls back to the plain input rate. Pricing all of
 * `inputTokens` at the input rate would overstate cost ~10x on cache-heavy
 * sessions, where most "input" is cache reads.
 */
export function computeCost(rule, usage) {
	const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	const input = rule.inputPerMtok;
	const write = rule.cacheWritePerMtok ?? input;
	const read = rule.cacheReadPerMtok ?? input;
	return (
		(n(usage.inputTokensUncached) * input +
			n(usage.cacheCreation) * write +
			n(usage.cacheRead) * read +
			n(usage.outputTokens) * rule.outputPerMtok) /
		MTOK
	);
}

/**
 * Cost of one session: the hub's own `costUsd` wins when it is a number, else
 * the matching rule, else unpriced (`costUsd: null`).
 */
export function priceSession(rules, { agent = null, at = null, usage }) {
	if (typeof usage?.costUsd === "number") return { costUsd: usage.costUsd, source: "hub" };
	const rule = resolveRule(rules, { agent, model: usage?.model ?? null, at });
	if (!rule) return { costUsd: null, source: "unpriced" };
	return { costUsd: computeCost(rule, usage), source: "pricing" };
}

/**
 * Total of priced sessions. `costUsd` is null when none was priced (not 0);
 * otherwise it sums the priced ones and `unpricedSessions` says how many were
 * left out, so a caller can mark the total as a lower bound.
 */
export function sumCosts(pricedList) {
	let total = 0;
	let priced = 0;
	let unpricedSessions = 0;
	for (const p of pricedList ?? []) {
		if (typeof p?.costUsd === "number") {
			total += p.costUsd;
			priced++;
		} else unpricedSessions++;
	}
	return { costUsd: priced ? total : null, unpricedSessions };
}
