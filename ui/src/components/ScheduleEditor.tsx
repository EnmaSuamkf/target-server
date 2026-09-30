import {
	draftSpec,
	previewRuns,
	formatInZone,
	timeZoneOptions,
	validateSchedule,
	WEEKDAYS,
	type ScheduleDraft,
	type ScheduleKind,
} from "../lib/schedule.ts";
import { Field } from "./Field.tsx";

const KIND_LABELS: Record<ScheduleKind, string> = {
	once: "Once",
	daily: "Every day",
	weekly: "Certain days of the week",
};

interface Props {
	value: ScheduleDraft;
	onChange: (next: ScheduleDraft) => void;
	/** Offer the "Run on a schedule" switch (create form); the panel edits an existing schedule and hides it. */
	showToggle?: boolean;
	/** Why the editor cannot be used right now; shown instead of the controls. */
	disabledReason?: string | null;
	/** Server-side messages for the schedule (from a rejected request). */
	serverErrors?: string[];
	/** Clock for the preview — injectable so it can be tested. */
	now?: Date;
}

/**
 * Recurrence editor for a scheduled series: kind, date/time, weekdays, timezone
 * (defaults to the browser's), the include-previous-run toggle, and a preview
 * of the next three runs computed client-side with Intl.
 */
export function ScheduleEditor({
	value,
	onChange,
	showToggle = true,
	disabledReason = null,
	serverErrors = [],
	now = new Date(),
}: Props): React.JSX.Element {
	const set = (patch: Partial<ScheduleDraft>) => onChange({ ...value, ...patch });
	const disabled = disabledReason != null;
	const active = value.enabled || !showToggle;
	const spec = draftSpec(value);
	const problems = validateSchedule(spec, value.timezone);
	const problem = (field: string) => problems.find((p) => p.field === field)?.message;
	const runs = active && !disabled ? previewRuns(spec, value.timezone, now) : [];
	const pastOnce = active && !problems.length && value.kind === "once" && runs.length === 0;

	return (
		<div className="schedule-editor">
			{showToggle ? (
				<label className="schedule-editor__toggle">
					<input
						type="checkbox"
						checked={value.enabled && !disabled}
						disabled={disabled}
						onChange={(e) => set({ enabled: e.target.checked })}
					/>
					<span>Run on a schedule</span>
				</label>
			) : null}
			{disabled ? (
				<p className="hint schedule-editor__disabled" role="status">
					Scheduling is unavailable: {disabledReason}
				</p>
			) : null}
			{active && !disabled ? (
				<div className="schedule-editor__body">
					<Field label="Repeats" hint="Each run is its own workflow, cloned from this one when the previous run starts.">
						{(props) => (
							<select
								{...props}
								className="select"
								value={value.kind}
								onChange={(e) => set({ kind: e.target.value as ScheduleKind })}
							>
								{(Object.keys(KIND_LABELS) as ScheduleKind[]).map((kind) => (
									<option key={kind} value={kind}>
										{KIND_LABELS[kind]}
									</option>
								))}
							</select>
						)}
					</Field>
					{value.kind === "once" ? (
						<Field label="Date and time" required {...(problem("at") ? { error: problem("at")! } : {})}>
							{(props) => (
								<input
									{...props}
									className="input"
									type="datetime-local"
									value={value.at}
									onChange={(e) => set({ at: e.target.value })}
								/>
							)}
						</Field>
					) : (
						<Field label="Time" required {...(problem("time") ? { error: problem("time")! } : {})}>
							{(props) => (
								<input
									{...props}
									className="input"
									type="time"
									value={value.time}
									onChange={(e) => set({ time: e.target.value })}
								/>
							)}
						</Field>
					)}
					{value.kind === "weekly" ? (
						<fieldset className="schedule-editor__days">
							<legend className="label">Days</legend>
							<div className="schedule-editor__day-row">
								{WEEKDAYS.map((label, day) => {
									const on = value.days.includes(day);
									return (
										<label key={label} className={`btn btn--sm${on ? " btn--on" : ""}`}>
											<input
												type="checkbox"
												className="sr-only"
												checked={on}
												onChange={() =>
													set({ days: on ? value.days.filter((d) => d !== day) : [...value.days, day] })
												}
											/>
											{label}
										</label>
									);
								})}
							</div>
							{problem("days") ? (
								<p className="msg msg--error" role="alert">
									{problem("days")}
								</p>
							) : null}
						</fieldset>
					) : null}
					<Field
						label="Time zone"
						required
						hint="Defaults to this browser's zone. The hub runs the schedule in this zone, whatever zone the hub itself is in."
						{...(problem("timezone") ? { error: problem("timezone")! } : {})}
					>
						{(props) => (
							<select
								{...props}
								className="select"
								value={value.timezone}
								onChange={(e) => set({ timezone: e.target.value })}
							>
								{timeZoneOptions(value.timezone).map((tz) => (
									<option key={tz} value={tz}>
										{tz}
									</option>
								))}
							</select>
						)}
					</Field>
					<label className="schedule-editor__toggle">
						<input
							type="checkbox"
							checked={value.includePrevious}
							onChange={(e) => set({ includePrevious: e.target.checked })}
						/>
						<span>Give each run a reference to the previous run (its status and results folder)</span>
					</label>
					<div className="schedule-editor__preview" aria-live="polite">
						<h5>Next runs</h5>
						{runs.length > 0 ? (
							<ol>
								{runs.map((run) => (
									<li key={run.toISOString()}>
										<span className="mono">{formatInZone(run, value.timezone)}</span> {value.timezone}
									</li>
								))}
							</ol>
						) : (
							<p className="hint">
								{pastOnce
									? "That date and time has already passed."
									: "Complete the schedule to preview its next runs."}
							</p>
						)}
					</div>
					{serverErrors.map((message) => (
						<p key={message} className="msg msg--error" role="alert">
							{message}
						</p>
					))}
				</div>
			) : null}
		</div>
	);
}
