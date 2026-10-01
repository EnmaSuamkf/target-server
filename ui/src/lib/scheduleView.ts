/**
 * How scheduled series and archived workflows show up in lists: which badges a
 * workflow gets, what the Scheduled / Scheduled runs / Archived filters keep,
 * and how a series' notices read. Pure so the rules can be tested without a DOM.
 */
import type { SyncRemoteWorkflowRow, SyncScheduleNotice, SyncScheduleSeriesRow } from "../api/types.ts";
import { formatInZone } from "./schedule.ts";

export type ScheduleFilter = "all" | "scheduled" | "runs" | "archived";

export const SCHEDULE_FILTERS: { id: ScheduleFilter; label: string; tip: string }[] = [
	{ id: "all", label: "All", tip: "Every workflow except archived ones." },
	{ id: "scheduled", label: "Scheduled", tip: "The armed instance of each series — the run that fires next." },
	{ id: "runs", label: "Scheduled runs", tip: "Runs a series has already fired (and missed or broken instances)." },
	{ id: "archived", label: "Archived", tip: "Only archived workflows; they are hidden everywhere else." },
];

/** What the filters default to: archived workflows stay out of sight. */
export const DEFAULT_SCHEDULE_FILTER: ScheduleFilter = "all";

export type ScheduleSeriesInfo = Pick<SyncScheduleSeriesRow, "id" | "name" | "timezone" | "state">;

export const isArchived = (w: Pick<SyncRemoteWorkflowRow, "archived_at">): boolean => Boolean(w.archived_at);

/** The instance that fires next: part of a series and still waiting for its time. */
export const isArmedInstance = (w: Pick<SyncRemoteWorkflowRow, "series_id" | "schedule_state">): boolean =>
	Boolean(w.series_id) && w.schedule_state === "armed";

/** A series instance that is not the armed one: already fired, missed, broken or cancelled. */
export const isScheduledRun = (w: Pick<SyncRemoteWorkflowRow, "series_id" | "schedule_state">): boolean =>
	Boolean(w.series_id) && !isArmedInstance(w);

export function matchesScheduleFilter(w: SyncRemoteWorkflowRow, filter: ScheduleFilter): boolean {
	if (filter === "archived") return isArchived(w);
	if (isArchived(w)) return false; // hidden unless asked for
	if (filter === "scheduled") return isArmedInstance(w);
	if (filter === "runs") return isScheduledRun(w);
	return true;
}

export function filterRemoteWorkflows(list: SyncRemoteWorkflowRow[], filter: ScheduleFilter): SyncRemoteWorkflowRow[] {
	return list.filter((w) => matchesScheduleFilter(w, filter));
}

export interface WorkflowBadge {
	kind: "scheduled" | "run" | "archived";
	label: string;
	tone: "info" | "neutral" | "warn" | "danger";
	title: string;
}

/** "2026-03-11 09:00" in the series zone, or the raw instant when the zone is unknown. */
function nextRunLabel(iso: string, timezone: string | null): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	try {
		return timezone ? formatInZone(date, timezone) : iso;
	} catch {
		return iso;
	}
}

/**
 * Badges for one workflow: "Scheduled · next …" on the armed instance,
 * "Run of <series>" on the others, "Archived" when archived.
 */
export function workflowBadges(
	w: SyncRemoteWorkflowRow,
	series: ScheduleSeriesInfo | null | undefined,
): WorkflowBadge[] {
	const badges: WorkflowBadge[] = [];
	if (w.series_id) {
		if (isArmedInstance(w)) {
			const tz = series?.timezone ?? null;
			const next = w.next_run_at ? nextRunLabel(w.next_run_at, tz) : null;
			badges.push({
				kind: "scheduled",
				label: next ? `Scheduled · next ${next}` : "Scheduled",
				tone: "info",
				title: next && tz ? `Fires ${next} (${tz})` : "Armed: waiting for its next run",
			});
		} else {
			const name = series?.name ?? w.name ?? w.series_id;
			badges.push({
				kind: "run",
				label: `Run of ${name}`,
				tone: w.schedule_state === "broken" || w.schedule_state === "missed" ? "warn" : "neutral",
				title: w.scheduled_for ? `Scheduled for ${w.scheduled_for}` : "An execution of a scheduled series",
			});
		}
	}
	if (isArchived(w)) {
		badges.push({ kind: "archived", label: "Archived", tone: "neutral", title: `Archived ${w.archived_at}` });
	}
	return badges;
}

// --- Notices ---------------------------------------------------------------

export type NoticeTone = "warn" | "danger";

export interface NoticeView {
	id: string;
	tone: NoticeTone;
	title: string;
	detail: string | null;
	at: string;
}

const SKIP_REASONS: Record<string, string> = {
	busy: "the previous run was still in progress",
	forbidden: "the hub owner's permissions did not allow scheduled runs",
	stale: "the hub's owner permissions were too old to trust",
};

/** One notice as a headline and detail line; times are shown in the series zone. */
export function describeNotice(notice: SyncScheduleNotice, timezone: string | null): NoticeView {
	const occurrences = notice.occurrences ?? [];
	const when = (iso: string) => nextRunLabel(iso, timezone);
	if (notice.kind === "missed") {
		const n = occurrences.length;
		return {
			id: notice.id,
			tone: "warn",
			title: n > 0 ? `${n} run${n === 1 ? "" : "s"} missed` : "Run missed",
			detail:
				(n > 0 ? `${occurrences.slice(0, 3).map(when).join(", ")}${n > 3 ? ` and ${n - 3} more` : ""} — ` : "") +
				"the hub was offline.",
			at: notice.created_at,
		};
	}
	if (notice.kind === "skipped") {
		const reason = notice.reason ? (SKIP_REASONS[notice.reason] ?? notice.reason) : null;
		return {
			id: notice.id,
			tone: "warn",
			title: occurrences[0] ? `Run skipped (${when(occurrences[0])})` : "Run skipped",
			detail: reason ? `Because ${reason}.` : null,
			at: notice.created_at,
		};
	}
	return { id: notice.id, tone: "danger", title: notice.kind, detail: notice.reason, at: notice.created_at };
}

/** A broken series has a critical problem the operator must fix by rescheduling. */
export function seriesProblem(series: Pick<SyncScheduleSeriesRow, "state">): string | null {
	return series.state === "broken"
		? "This series is broken: the hub could not create its next run. Reschedule it to arm a new run."
		: null;
}
