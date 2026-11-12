/**
 * The retry-wait countdown: how long until a failed step runs again, and the
 * words the step list and the canvas show for it.
 *
 * Pure on purpose: the clock is a parameter (`nowMs`), never read here, so the
 * same inputs give the same text in a test and in the browser.
 *
 * The same functions and text exist in the hub's UI (hub/ui/src/lib/format.ts).
 * They are copied, not imported across repositories: keep the two in step.
 */

export interface RetryCountdown {
	/** The time has come (or passed) and the attempt has not started yet. */
	overdue: boolean;
	/** Whole seconds left, rounded up. 0 when overdue. Never negative. */
	seconds: number;
}

/**
 * Remaining time until `retryAt`, measured at `nowMs`. A time that is not
 * reached yet is counted up to the next whole second; a time that is reached
 * (or cannot be read) is overdue, so no negative number is ever shown.
 */
export function retryCountdown(retryAt: string, nowMs: number): RetryCountdown {
	const remainingMs = Date.parse(retryAt) - nowMs;
	// `!(x > 0)` also catches NaN, so an unreadable time is shown as due rather than as a number.
	if (!(remainingMs > 0)) return { overdue: true, seconds: 0 };
	return { overdue: false, seconds: Math.ceil(remainingMs / 1000) };
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Under a minute: `45s`. A minute to under an hour: `2m 05s` (seconds padded
 * only in this form). An hour or more: `1h 02m`.
 */
export function formatCountdown(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
	return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`;
}

/** The step list badge: `retry in 45s`, or `retry due`. */
export function retryListLabel(retryAt: string, nowMs: number): string {
	const countdown = retryCountdown(retryAt, nowMs);
	return countdown.overdue ? "retry due" : `retry in ${formatCountdown(countdown.seconds)}`;
}

/** The canvas card state text: `retrying · 45s`, or `retrying · due`. */
export function retryCanvasLabel(retryAt: string, nowMs: number): string {
	const countdown = retryCountdown(retryAt, nowMs);
	return countdown.overdue ? "retrying · due" : `retrying · ${formatCountdown(countdown.seconds)}`;
}
