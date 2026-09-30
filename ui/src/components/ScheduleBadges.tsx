import type { SyncRemoteWorkflowRow } from "../api/types.ts";
import { workflowBadges, type ScheduleSeriesInfo } from "../lib/scheduleView.ts";

/** "Scheduled · next …", "Run of <series>" and "Archived" for one workflow. */
export function ScheduleBadges({
	workflow,
	series,
}: {
	workflow: SyncRemoteWorkflowRow;
	series: ScheduleSeriesInfo | null | undefined;
}) {
	const badges = workflowBadges(workflow, series);
	if (badges.length === 0) return null;
	return (
		<span className="schedule-badges">
			{badges.map((b) => (
				<span key={b.kind} className={`badge badge--${b.tone} schedule-badge schedule-badge--${b.kind}`} title={b.title}>
					{b.label}
				</span>
			))}
		</span>
	);
}
