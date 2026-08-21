/**
 * Event payloads, read as prose instead of JSON.
 *
 * Every event arrives as a free-form `data` object (§7 of the wire contract).
 * Dumping it verbatim is honest but unreadable — a `workflow.plan` payload is a
 * whole plan on one line — so this module folds each known kind into the three
 * things a human actually reads: a one-line headline ("Step 2 finished in 17s"),
 * the free text the event carries (a description, an acceptance criterion, an
 * error message), and the remaining scalars as labelled facts.
 *
 * Nothing is hidden: whatever this file does not lift into the summary is still
 * in the raw payload the feed keeps one click away. Unknown (newer) kinds fall
 * through to the generic path — headline-less, but with every scalar labelled —
 * so a kind this dashboard has never seen still reads better than JSON.
 */

import { compactNumber, formatDuration, shortId } from "./format.ts";

/** Tone for the headline, borrowed from the badge palette. */
export type EventTone = "info" | "success" | "warn" | "danger" | null;

/** One labelled scalar from the payload. */
export interface EventFact {
	label: string;
	value: string;
	/** Machine identifiers (ids, models) are printed in mono, like everywhere else. */
	mono?: boolean;
}

/** One step of a `workflow.plan` snapshot, as the feed lists it. */
export interface PlanStepLine {
	key: string;
	/** "Context" for the hub-owned context step, else "1", "2"… */
	num: string;
	status: string;
	description: string;
	/** Short trailing annotation: "reviewed", "manual run"… */
	note: string | null;
}

export interface PlanBlock {
	/** Collapsed line: "6 steps · 3 done · 1 running · 2 pending". */
	summary: string;
	steps: PlanStepLine[];
}

export interface EventSummary {
	headline: string | null;
	tone: EventTone;
	/** The event's own words: a step description, a criterion, an error message. */
	text: string | null;
	facts: EventFact[];
	plan: PlanBlock | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asStr = (v: unknown): string | null => {
	if (typeof v === "string" && v.trim()) return v.trim();
	return null;
};

/** Field name → the label a human would give it. */
const LABELS: Record<string, string> = {
	acceptance_criteria: "Acceptance criteria",
	agent: "Runner",
	agent_name: "Agent name",
	attempt: "Attempt",
	cache_creation: "Cache written",
	cache_read: "Cache read",
	compacted: "Conversation compacted",
	context_pct: "Context used",
	context_tokens: "Context tokens",
	context_window: "Context window",
	cost_usd: "Cost",
	duration_ms: "Duration",
	has_acceptance_criteria: "Has acceptance criteria",
	image: "Docker image",
	includes_subagents: "Includes subagents",
	input_tokens: "Input tokens",
	input_tokens_uncached: "Input tokens (uncached)",
	manual: "Set by hand",
	manual_review: "Manual review",
	manual_run: "Manual run",
	max_retries: "Max retries",
	mode: "Mode",
	model: "Model",
	name: "Name",
	order_index: "Position",
	os: "OS",
	output_tokens: "Output tokens",
	phase: "Phase",
	queue_pending: "Queued jobs",
	retry_count: "Retries",
	retryable: "Retryable",
	selected: "Selected",
	session_id: "Session",
	status_manual: "Status set by hand",
	step_id: "Step id",
	turns: "Turns",
	uptime_ms: "Uptime",
	use_subagent: "Runs in a subagent",
	version: "Version",
	workflows_total: "Workflows tracked",
};

function labelFor(key: string): string {
	const known = LABELS[key];
	if (known) return known;
	const words = key.replace(/_/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Ids are mono and shortened; so is anything that looks like one. */
const MONO_KEYS = new Set(["step_id", "session_id", "workflow_id", "instance_id", "model", "agent_name", "image", "os", "version"]);

/**
 * One payload value, printed the way its name says it should be: `*_ms` is a
 * duration, token counters use the client's own abbreviation, `*_at` is a
 * clock time, booleans are yes/no.
 */
function formatValue(key: string, value: unknown): string | null {
	if (value == null || value === "") return null;
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return null;
		if (key.endsWith("_ms")) return formatDuration(value);
		if (key === "context_pct") return `${value}%`;
		if (key === "cost_usd") return `$${value.toFixed(2)}`;
		if (key.includes("tokens") || key.startsWith("cache_") || key === "context_window") return compactNumber(value);
		return String(value);
	}
	if (typeof value === "string") {
		// The filter bar and the sandbox badge both call `host` "local"; the feed
		// should not be the one place that says something else.
		if (key === "sandbox" && value === "host") return "local (host)";
		if (key.endsWith("_at")) {
			const ms = Date.parse(value);
			if (Number.isFinite(ms)) return new Date(ms).toLocaleString();
		}
		if (MONO_KEYS.has(key) && /^[0-9a-f-]{16,}$/i.test(value)) return shortId(value);
		return value;
	}
	return null;
}

/**
 * Counters whose zero is the default, not news: "Retries 0 · Max retries 0" on
 * every step event is noise you learn to skip, which is how a reader starts
 * skipping the line that mattered.
 */
const ZERO_NOISE = new Set(["retry_count", "max_retries", "queue_pending", "cache_creation", "cache_read", "attempt"]);

/**
 * Every scalar left over after the per-kind headline took what it needed.
 * Nested values (a plan's steps, an error object) are handled by their kind or
 * left to the raw payload; `false` booleans are dropped as noise — "manual run:
 * no" tells a reader nothing the default does not already say.
 */
function restFacts(data: Record<string, unknown>, used: Set<string>): EventFact[] {
	const facts: EventFact[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (used.has(key)) continue;
		if (value === false) continue;
		if (value === 0 && ZERO_NOISE.has(key)) continue;
		if (isRecord(value) || Array.isArray(value)) continue;
		const text = formatValue(key, value);
		if (text == null) continue;
		facts.push({ label: labelFor(key), value: text, mono: MONO_KEYS.has(key) });
	}
	return facts;
}

/** `order_index` → how the hub numbers that step out loud. */
function stepName(data: Record<string, unknown>): string {
	const i = asNum(data.order_index);
	if (i == null) return "Step";
	if (i < 0) return "Context step";
	return `Step ${i + 1}`;
}

const STATUS_TONES: Record<string, EventTone> = {
	completed: "success",
	done: "success",
	failed: "danger",
	cancelled: "warn",
	running: "info",
	draft: null,
	pending: null,
};

/** The plan snapshot's `steps[]`, counted and listed. */
function planBlock(raw: unknown): PlanBlock | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const counts = new Map<string, number>();
	const steps: PlanStepLine[] = [];
	raw.forEach((entry, index) => {
		if (!isRecord(entry)) return;
		const status = asStr(entry.status) ?? "pending";
		counts.set(status, (counts.get(status) ?? 0) + 1);
		const order = asNum(entry.order_index);
		const notes: string[] = [];
		if (entry.manual_review === true) notes.push("reviewed");
		if (entry.manual_run === true) notes.push("manual run");
		if (entry.use_subagent === true) notes.push("subagent");
		const retries = asNum(entry.retry_count);
		if (retries && retries > 0) notes.push(`${retries} ${retries === 1 ? "retry" : "retries"}`);
		steps.push({
			key: asStr(entry.step_id) ?? `step-${index}`,
			num: order == null ? "-" : order < 0 ? "Context" : String(order + 1),
			status,
			description: asStr(entry.description) ?? "(no description)",
			note: notes.length > 0 ? notes.join(" · ") : null,
		});
	});
	if (steps.length === 0) return null;
	const order = ["done", "running", "failed", "pending"];
	const parts = [...counts.entries()]
		.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
		.map(([status, n]) => `${n} ${status}`);
	const summary = `${steps.length} ${steps.length === 1 ? "step" : "steps"}${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`;
	return { summary, steps };
}

/** A payload with nothing in it at all. */
const EMPTY: EventSummary = { headline: null, tone: null, text: null, facts: [], plan: null };

/** Fold one event's payload into the headline / text / facts a human reads. */
export function summarizeEvent(kind: string, data: Record<string, unknown> | null | undefined): EventSummary {
	if (!data || Object.keys(data).length === 0) return EMPTY;
	const used = new Set<string>();
	const take = (...keys: string[]) => {
		for (const key of keys) used.add(key);
	};
	let headline: string | null = null;
	let tone: EventTone = null;
	let text: string | null = null;
	let plan: PlanBlock | null = null;
	/** Facts lifted out of nested values, which `restFacts` deliberately skips. */
	const extra: EventFact[] = [];

	const step = stepName(data);
	const name = asStr(data.name);
	// Every `step.*` headline already says which step this is ("Step 1"), so the
	// raw `order_index` behind it would only repeat itself off by one.
	if (kind.startsWith("step.")) take("order_index");

	switch (kind) {
		case "heartbeat": {
			const uptime = asNum(data.uptime_ms);
			const total = asNum(data.workflows_total);
			const queued = asNum(data.queue_pending);
			const bits = [uptime != null ? `up ${formatDuration(uptime)}` : null, total != null ? `${total} workflows tracked` : null, queued ? `${queued} queued` : null].filter(
				Boolean,
			);
			headline = bits.length > 0 ? `Instance alive · ${bits.join(" · ")}` : "Instance alive";
			take("uptime_ms", "workflows_total", "queue_pending");
			break;
		}
		case "workflow.created":
		case "workflow.updated":
		case "workflow.removed": {
			const verb = kind === "workflow.created" ? "Created" : kind === "workflow.removed" ? "Removed" : "Updated";
			headline = name ? `${verb} "${name}"` : verb;
			tone = kind === "workflow.removed" ? "warn" : "info";
			take("name");
			break;
		}
		case "workflow.status_changed": {
			const from = asStr(data.from);
			const to = asStr(data.to);
			headline = to ? `${from ?? "unknown"} → ${to}${data.manual === true ? " (set by hand)" : ""}` : "Status changed";
			tone = to ? (STATUS_TONES[to] ?? "info") : "info";
			take("from", "to", "manual");
			break;
		}
		case "workflow.plan": {
			plan = planBlock(data.steps);
			const status = asStr(data.status);
			// The step count lives on the plan block's own summary line; repeating it
			// here would just make the headline longer than the thing it heads.
			const bits = [name ? `"${name}"` : null, status].filter(Boolean);
			headline = `Plan snapshot${bits.length > 0 ? ` · ${bits.join(" · ")}` : ""}`;
			tone = status ? (STATUS_TONES[status] ?? "info") : "info";
			take("name", "status", "steps");
			break;
		}
		case "step.added": {
			headline = `${step} added to the plan`;
			text = asStr(data.description);
			take("description");
			break;
		}
		case "step.started": {
			const attempt = asNum(data.attempt);
			const max = asNum(data.max_retries);
			const retry = attempt && attempt > 1 ? ` · attempt ${attempt}${max ? ` of ${max + 1}` : ""}` : "";
			headline = `${step} started${data.phase === "judge" ? " (review)" : ""}${retry}`;
			tone = "info";
			take("phase", "attempt", "max_retries");
			break;
		}
		case "step.done": {
			const ms = asNum(data.duration_ms);
			headline = `${step} finished${ms != null ? ` in ${formatDuration(ms)}` : ""}`;
			tone = "success";
			take("duration_ms");
			break;
		}
		case "step.failed": {
			const ms = asNum(data.duration_ms);
			const aborted = data.aborted === true;
			headline = `${step} ${aborted ? "aborted" : "failed"}${ms != null ? ` after ${formatDuration(ms)}` : ""}`;
			tone = "danger";
			take("duration_ms", "aborted", "error", "phase");
			if (isRecord(data.error)) {
				// The error object is nested, so `restFacts` never sees it: lift the
				// message into the event's own words and the rest into facts.
				text = asStr(data.error.message);
				const errKind = asStr(data.error.kind);
				if (errKind) extra.push({ label: "Error kind", value: errKind });
				if (data.error.retryable === true) extra.push({ label: "Retryable", value: "yes" });
			}
			break;
		}
		case "step.judged": {
			const ok = data.ok === true;
			headline = `${step} ${ok ? "passed review" : "failed review"}`;
			tone = ok ? "success" : "danger";
			text = asStr(data.acceptance_criteria);
			take("ok", "acceptance_criteria");
			break;
		}
		case "step.waiting": {
			headline = `${step} waiting${data.manual_run === true ? " for you to run it" : " to start"}`;
			tone = "warn";
			take("manual_run");
			break;
		}
		case "usage.snapshot": {
			const input = asNum(data.input_tokens) ?? 0;
			const output = asNum(data.output_tokens) ?? 0;
			const pct = asNum(data.context_pct);
			const window = asNum(data.context_window);
			const model = asStr(data.model);
			const bits = [
				`in ${compactNumber(input)}`,
				`out ${compactNumber(output)}`,
				pct != null && window ? `${pct}% of ${compactNumber(window)} context` : null,
				model,
			].filter(Boolean);
			headline = bits.join(" · ");
			tone = pct != null && pct >= 80 ? "danger" : pct != null && pct >= 50 ? "warn" : "info";
			take("input_tokens", "output_tokens", "context_pct", "context_window", "model", "context_tokens");
			break;
		}
		case "conversation.snapshot": {
			const turns = asNum(data.turns);
			const mode = asStr(data.mode);
			headline = `${turns ?? 0} ${turns === 1 ? "turn" : "turns"}${mode ? ` · ${mode} mode` : ""} · no message content is ever sent`;
			take("turns", "mode");
			break;
		}
		default:
			break;
	}

	return { headline, tone, text, facts: [...extra, ...restFacts(data, used)], plan };
}
