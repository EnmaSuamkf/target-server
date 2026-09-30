import type { SyncScheduleSeriesRow } from "../api/types.ts";
import { describeSchedule } from "../lib/schedule.ts";
import { describeNotice, seriesProblem } from "../lib/scheduleView.ts";
import { shortId, timeAgo } from "../lib/format.ts";
import { StatusBadge } from "./Badges.tsx";

/**
 * One scheduled series: its recurrence, a problem banner when it is broken, the
 * missed/skipped notices the hub reported, and every instance it has created
 * (status, who created it, when it was meant to run).
 */
export function SeriesView({
	series,
	selectedId,
	onOpen,
}: {
	series: SyncScheduleSeriesRow;
	selectedId?: string;
	onOpen?: (remoteId: string) => void;
}) {
	const problem = seriesProblem(series);
	return (
		<section className="series-view" aria-label={`Series ${series.name}`}>
			<div className="series-view__head">
				<h4>{series.name}</h4>
				<span className={`badge badge--${series.state === "active" ? "success" : series.state === "broken" ? "danger" : "neutral"}`}>
					{series.state}
				</span>
				<span className="hint">{describeSchedule(series.spec, series.timezone)}</span>
			</div>
			{problem ? (
				<p className="msg msg--error series-view__problem" role="alert">
					{problem}
				</p>
			) : null}
			{series.notices.length > 0 ? (
				<ul className="series-notices" aria-label="Schedule notices">
					{series.notices.map((notice) => {
						const view = describeNotice(notice, series.timezone);
						return (
							<li key={view.id} className={`series-notice series-notice--${view.tone}`}>
								<strong>{view.title}</strong>
								{view.detail ? <span> {view.detail}</span> : null}
								<span className="hint"> · {timeAgo(view.at)}</span>
							</li>
						);
					})}
				</ul>
			) : null}
			<table className="series-instances">
				<thead>
					<tr>
						<th>Run</th>
						<th>Scheduled for</th>
						<th>Status</th>
						<th>Schedule</th>
						<th>Created by</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{series.instances.map((w) => (
						<tr key={w.id} className={selectedId === w.id ? "sync-row--selected" : ""}>
							<td title={w.id}>{w.name ?? shortId(w.id)}</td>
							<td className="mono">{w.scheduled_for ?? "—"}</td>
							<td>
								<StatusBadge status={w.status} />
							</td>
							<td>{w.schedule_state ?? "—"}</td>
							<td>{w.created_by ?? "server"}</td>
							<td>
								{onOpen ? (
									<button type="button" className="btn btn--sm" onClick={() => onOpen(w.id)}>
										Open
									</button>
								) : null}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}
