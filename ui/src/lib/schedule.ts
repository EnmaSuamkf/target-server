/**
 * Client-side schedule math for the schedule editor: validation and the
 * "next 3 runs" preview.
 *
 * This mirrors hub/schedule.ts (and the Joi rules in blueprint.mjs) on purpose.
 * The hub is the one that actually fires a run, so a preview that disagreed
 * with it would promise times the hub never uses. Everything is built on Intl,
 * one primitive — "what does the wall clock read in <zone> at instant t" — and
 * inverted where needed (resolveLocal).
 *
 * DST (D6): a NON-EXISTENT local time resolves to the transition instant (the
 * run still happens that day); an AMBIGUOUS one resolves to its first
 * occurrence, so a repeated hour never produces a second run.
 */

export type ScheduleKind = "once" | "daily" | "weekly";

export type ScheduleSpec =
	| { kind: "once"; at: string } // local "YYYY-MM-DDTHH:mm"
	| { kind: "daily"; time: string } // local "HH:mm"
	| { kind: "weekly"; days: number[]; time: string }; // 0 = Sunday … 6 = Saturday

export interface ScheduleFieldError {
	field: "kind" | "at" | "time" | "days" | "timezone";
	message: string;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const AT_RE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

let supportedZones: Set<string> | null = null;

/** Same rule as the hub and the server: in Intl's canonical list, or accepted and reported back verbatim. */
export function isValidTimeZone(tz: unknown): tz is string {
	if (typeof tz !== "string" || !tz) return false;
	supportedZones ??= new Set(Intl.supportedValuesOf("timeZone"));
	if (supportedZones.has(tz)) return true;
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone === tz;
	} catch {
		return false;
	}
}

/** The browser's zone, or UTC when it cannot be determined or is not one the server accepts. */
export function browserTimeZone(): string {
	try {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return isValidTimeZone(tz) ? tz : "UTC";
	} catch {
		return "UTC";
	}
}

/** Zones for the picker: Intl's list, plus `current` when it is valid but missing from it. */
export function timeZoneOptions(current: string): string[] {
	const zones = Intl.supportedValuesOf("timeZone");
	return current && !zones.includes(current) && isValidTimeZone(current) ? [current, ...zones] : zones;
}

/** Field errors for a schedule; empty means valid. Whether a `once` is in the past is nextOccurrence's call. */
export function validateSchedule(spec: ScheduleSpec, timezone: string): ScheduleFieldError[] {
	const errors: ScheduleFieldError[] = [];
	if (!isValidTimeZone(timezone)) {
		errors.push({ field: "timezone", message: "Pick a valid IANA time zone (e.g. Europe/Madrid)" });
	}
	if (spec.kind === "once") {
		if (!parseLocalDateTime(spec.at)) errors.push({ field: "at", message: "Pick a valid date and time" });
	} else {
		if (!TIME_RE.test(spec.time)) errors.push({ field: "time", message: "Time must be HH:mm (00:00–23:59)" });
		if (spec.kind === "weekly" && spec.days.length === 0) {
			errors.push({ field: "days", message: "Pick at least one day of the week" });
		}
	}
	return errors;
}

/** The first run strictly AFTER `after`, or null (a `once` that is not in the future). */
export function nextOccurrence(spec: ScheduleSpec, timezone: string, after: Date): Date | null {
	const afterMs = after.getTime();
	if (spec.kind === "once") {
		const p = parseLocalDateTime(spec.at);
		if (!p) return null;
		const t = resolveLocal(timezone, p.y, p.m, p.d, p.hh, p.mm);
		return t > afterMs ? new Date(t) : null;
	}
	const [hh, mm] = spec.time.split(":").map(Number) as [number, number];
	const days = spec.kind === "weekly" ? new Set(spec.days) : null;
	if (days && days.size === 0) return null;
	const start = wallClock(timezone, afterMs);
	// Eight local dates cover a full week plus today's run having already passed.
	for (let i = 0; i <= 8; i++) {
		const date = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
		if (days && !days.has(date.getUTCDay())) continue;
		const t = resolveLocal(timezone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hh, mm);
		if (t > afterMs) return new Date(t);
	}
	return null;
}

/** Up to `count` upcoming runs, soonest first; an invalid schedule previews nothing. */
export function previewRuns(spec: ScheduleSpec, timezone: string, now: Date, count = 3): Date[] {
	if (validateSchedule(spec, timezone).length) return [];
	const out: Date[] = [];
	let next = nextOccurrence(spec, timezone, now);
	while (next && out.length < count) {
		out.push(next);
		next = nextOccurrence(spec, timezone, next);
	}
	return out;
}

/** "YYYY-MM-DD HH:mm" as the wall clock in `timezone` reads at `date`. */
export function formatInZone(date: Date, timezone: string): string {
	const w = wallClock(timezone, date.getTime());
	return `${w.y}-${pad(w.m)}-${pad(w.d)} ${pad(w.hh)}:${pad(w.mm)}`;
}

/** One-line description of a spec for lists and confirmations. */
export function describeSchedule(spec: ScheduleSpec, timezone: string): string {
	if (spec.kind === "once") return `Once at ${spec.at.replace("T", " ")} (${timezone})`;
	if (spec.kind === "daily") return `Every day at ${spec.time} (${timezone})`;
	const days = [...spec.days].sort((a, b) => a - b).map((d) => WEEKDAYS[d]);
	return `Every ${days.join(", ")} at ${spec.time} (${timezone})`;
}

// ---------------------------------------------------------------------------

interface Wall {
	y: number;
	m: number;
	d: number;
	hh: number;
	mm: number;
	ss: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
	let f = formatters.get(timezone);
	if (!f) {
		// h23, not hour12:false: the latter renders midnight as "24" in some ICU builds.
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timezone, f);
	}
	return f;
}

function wallClock(timezone: string, t: number): Wall {
	const parts: Record<string, number> = {};
	for (const p of formatter(timezone).formatToParts(new Date(t))) {
		if (p.type !== "literal") parts[p.type] = Number(p.value);
	}
	return { y: parts.year!, m: parts.month!, d: parts.day!, hh: parts.hour!, mm: parts.minute!, ss: parts.second! };
}

/** The wall clock reading as if it were UTC, so wall times compare as plain numbers. */
function wallMs(w: Wall): number {
	return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
}

function offsetAt(timezone: string, t: number): number {
	const whole = t - (((t % 1000) + 1000) % 1000);
	return wallMs(wallClock(timezone, whole)) - whole;
}

/**
 * The instant at which the wall clock in `timezone` reads the given local time.
 * No zone offset exceeds ±14h and transitions are months apart, so the offsets
 * in effect a day and a half either side are the only candidates; each is
 * checked by reading the wall clock back.
 */
function resolveLocal(timezone: string, y: number, m: number, d: number, hh: number, mm: number): number {
	const local = Date.UTC(y, m - 1, d, hh, mm);
	const offsets = [
		...new Set([
			offsetAt(timezone, local - 1.5 * DAY),
			offsetAt(timezone, local),
			offsetAt(timezone, local + 1.5 * DAY),
		]),
	];
	const hits = offsets.map((o) => local - o).filter((t) => wallMs(wallClock(timezone, t)) === local);
	if (hits.length) return Math.min(...hits); // ambiguous → first occurrence
	// Gap: bisect for the first minute whose wall clock has reached the skipped time — the transition.
	let lo = local - Math.max(...offsets);
	let hi = local - Math.min(...offsets);
	while (hi - lo > MINUTE) {
		const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
		if (wallMs(wallClock(timezone, mid)) >= local) hi = mid;
		else lo = mid;
	}
	return hi;
}

function parseLocalDateTime(at: string): { y: number; m: number; d: number; hh: number; mm: number } | null {
	const match = AT_RE.exec(at);
	if (!match) return null;
	const [y, m, d, hh, mm] = match.slice(1).map(Number) as [number, number, number, number, number];
	// Reject dates that do not exist (2026-02-30), which Date.UTC would roll into March.
	const check = new Date(Date.UTC(y, m - 1, d));
	if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
	return { y, m, d, hh, mm };
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

// --- Editor draft ----------------------------------------------------------

/** What the editor holds while the operator types: every kind's fields stay, only `kind` picks which are sent. */
export interface ScheduleDraft {
	enabled: boolean;
	kind: ScheduleKind;
	at: string;
	time: string;
	days: number[];
	timezone: string;
	includePrevious: boolean;
}

export function emptyScheduleDraft(timezone = browserTimeZone()): ScheduleDraft {
	return { enabled: false, kind: "daily", at: "", time: "09:00", days: [1, 2, 3, 4, 5], timezone, includePrevious: true };
}

export function draftSpec(draft: ScheduleDraft): ScheduleSpec {
	if (draft.kind === "once") return { kind: "once", at: draft.at };
	if (draft.kind === "daily") return { kind: "daily", time: draft.time };
	return { kind: "weekly", days: [...draft.days].sort((a, b) => a - b), time: draft.time };
}

/** The request body for a draft; null while it is invalid. */
export function draftToBody(draft: ScheduleDraft): { spec: ScheduleSpec; timezone: string; include_previous: boolean } | null {
	const spec = draftSpec(draft);
	if (validateSchedule(spec, draft.timezone).length) return null;
	return { spec, timezone: draft.timezone, include_previous: draft.includePrevious };
}

export function draftFromSeries(series: {
	spec: ScheduleSpec;
	timezone: string;
	include_previous: boolean;
}): ScheduleDraft {
	const draft = emptyScheduleDraft(series.timezone);
	draft.enabled = true;
	draft.kind = series.spec.kind;
	draft.includePrevious = series.include_previous;
	if (series.spec.kind === "once") draft.at = series.spec.at;
	else draft.time = series.spec.time;
	if (series.spec.kind === "weekly") draft.days = [...series.spec.days];
	return draft;
}
