import { SCHEDULE_FILTERS, type ScheduleFilter } from "../lib/scheduleView.ts";

/** Scheduled / Scheduled runs / Archived filter; "All" hides archived workflows. */
export function ScheduleFilterBar({
	value,
	onChange,
}: {
	value: ScheduleFilter;
	onChange: (next: ScheduleFilter) => void;
}) {
	return (
		<div className="schedule-filters" role="group" aria-label="Schedule filter">
			{SCHEDULE_FILTERS.map((f) => (
				<button
					key={f.id}
					type="button"
					className={`btn btn--sm${value === f.id ? " btn--on" : ""}`}
					aria-pressed={value === f.id}
					title={f.tip}
					onClick={() => onChange(f.id)}
				>
					{f.label}
				</button>
			))}
		</div>
	);
}
