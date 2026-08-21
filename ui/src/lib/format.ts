/** Display helpers shared by the tables, the feed and the step canvas. */

export function timeAgo(iso: string | null | undefined): string {
	if (!iso) return "-";
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (s < 60) return `${Math.floor(s)}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

/** Token counts, compact: 15234 → "15k", 464 → "464". */
export function compactTokens(n: number | null | undefined): string {
	if (n == null) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return String(n);
}

/**
 * The operator's client's own abbreviation: `202014` → `202.0k`, `16015192` →
 * `16.0M`. Deliberately NOT `compactTokens` above, which drops a trailing `.0`
 * ("16M"): the usage readout exists to be compared with what the client prints,
 * so it has to agree character for character, one decimal and all. Same rule as
 * the hub's `compactNumber` (hub/ui/src/lib/format.ts).
 */
export function compactNumber(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n)) return "0";
	if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(Math.round(n));
}

/**
 * Durations: under a minute in seconds, then "2m 5s", then "3h 49m" — an
 * instance's uptime is hours long, and "229m 20s" is a number you have to do
 * arithmetic on before it means anything.
 */
export function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (h < 24) return `${h}h ${m}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** `datetime-local` values are local; the API compares ISO (UTC) strings. */
export function localToIso(value: string): string | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** First 8 chars of a uuid — how every id is shown in the tables. */
export function shortId(id: string): string {
	return id.slice(0, 8);
}
