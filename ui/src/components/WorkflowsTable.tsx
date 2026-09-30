import { useState } from "react";
import type { SyncRemoteWorkflowRow, SyncScheduleSeriesRow, WorkflowRow } from "../api/types.ts";
import { compactTokens, shortId, timeAgo } from "../lib/format.ts";
import { DEFAULT_SCHEDULE_FILTER, matchesScheduleFilter, type ScheduleFilter } from "../lib/scheduleView.ts";
import { AgentBadge, SandboxBadge, StatusBadge } from "./Badges.tsx";
import { ScheduleBadges } from "./ScheduleBadges.tsx";
import { ScheduleFilterBar } from "./ScheduleFilterBar.tsx";

const COLUMNS = ["Workflow", "User", "Agent", "Sandbox", "Status", "Steps", "Tokens (in / out)", "Last activity"];

/** Steps cell: `done/total` plus the hub's thin progress bar. */
export function StepsProgress({ workflow: w }: { workflow: WorkflowRow }) {
	// The server derives `stepsTotal` from the plan events AND the largest
	// order_index seen, so pending steps and pre-step.added workflows count too.
	// The local max() is just a fallback for older servers.
	const total = w.stepsTotal ?? Math.max(w.stepsAdded, w.stepsStarted, w.stepsDone + w.stepsFailed);
	const pct = total > 0 ? Math.min(100, Math.round((w.stepsDone / total) * 100)) : 0;
	const tone = w.stepsFailed > 0 ? "progress__fill--failed" : w.status === "running" ? "progress__fill--running" : "";
	return (
		<div className="steps-cell">
			<span className="mono steps-n">{`${w.stepsDone}/${total}`}</span>
			<span className="progress">
				<span className={`progress__fill ${tone}`.trimEnd()} style={{ width: `${pct}%` }} />
			</span>
		</div>
	);
}

interface WorkflowsTableProps {
	workflows: WorkflowRow[] | null;
	selectedId: string;
	onSelect: (id: string) => void;
	/** Remote workflows, joined to reported rows by local id; null when the viewer cannot see them. */
	remoteWorkflows?: SyncRemoteWorkflowRow[] | null;
	series?: SyncScheduleSeriesRow[] | null;
}

/** The workflow-centric fleet view: one row per reported workflow. */
export function WorkflowsTable({ workflows, selectedId, onSelect, remoteWorkflows = null, series = null }: WorkflowsTableProps) {
	const [filter, setFilter] = useState<ScheduleFilter>(DEFAULT_SCHEDULE_FILTER);
	if (!workflows || workflows.length === 0) return <div className="empty">No workflows reported in this range.</div>;
	const remoteByLocalId = new Map((remoteWorkflows ?? []).filter((r) => r.local_id).map((r) => [r.local_id as string, r]));
	const seriesById = new Map((series ?? []).map((s) => [s.id, s]));
	// Schedule and archive state lives on the remote workflow. A workflow that is
	// not remote has neither, so it only shows under "All".
	const visible = remoteWorkflows
		? workflows.filter((w) => {
				const remote = remoteByLocalId.get(w.workflowId);
				return remote ? matchesScheduleFilter(remote, filter) : filter === "all";
			})
		: workflows;
	return (
		<>
		{remoteWorkflows ? <ScheduleFilterBar value={filter} onChange={setFilter} /> : null}
		{visible.length === 0 ? <div className="empty">No workflows match this filter.</div> : (
		<table className="wf-table">
			<thead>
				<tr>
					{COLUMNS.map((c) => (
						<th key={c}>{c}</th>
					))}
				</tr>
			</thead>
			<tbody>
				{visible.map((w) => {
					const remote = remoteByLocalId.get(w.workflowId);
					const selected = w.workflowId === selectedId;
					return (
						<tr
							key={w.workflowId}
							className={`wf-row${selected ? " wf-row--selected" : ""}`}
							title={selected ? "Click to close the detail" : "Click to inspect this workflow"}
							onClick={() => onSelect(selected ? "" : w.workflowId)}
						>
							<td>
								<div className="wf-name">
									{w.name}
									{remote ? <ScheduleBadges workflow={remote} series={remote.series_id ? seriesById.get(remote.series_id) : null} /> : null}
								</div>
								<div className="mono wf-id">{shortId(w.workflowId)}</div>
							</td>
							<td>{w.user || <span className="badge badge--neutral">anonymous</span>}</td>
							<td>
								<AgentBadge agent={w.agent} />
							</td>
							<td>
								<SandboxBadge sandbox={w.sandbox} image={w.image} />
							</td>
							<td>
								<StatusBadge status={w.status} />
							</td>
							<td>
								<StepsProgress workflow={w} />
							</td>
							<td className="mono">{`${compactTokens(w.tokens.input)} / ${compactTokens(w.tokens.output)}`}</td>
							<td className="mono">{timeAgo(w.lastActivityAt)}</td>
						</tr>
					);
				})}
			</tbody>
		</table>
		)}
		</>
	);
}
