import type { WorkflowRow } from "../api/types.ts";
import { compactTokens, shortId, timeAgo } from "../lib/format.ts";
import { AgentBadge, SandboxBadge, StatusBadge } from "./Badges.tsx";

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
}

/** The workflow-centric fleet view: one row per reported workflow. */
export function WorkflowsTable({ workflows, selectedId, onSelect }: WorkflowsTableProps) {
	if (!workflows || workflows.length === 0) return <div className="empty">No workflows reported in this range.</div>;
	return (
		<table className="wf-table">
			<thead>
				<tr>
					{COLUMNS.map((c) => (
						<th key={c}>{c}</th>
					))}
				</tr>
			</thead>
			<tbody>
				{workflows.map((w) => {
					const selected = w.workflowId === selectedId;
					return (
						<tr
							key={w.workflowId}
							className={`wf-row${selected ? " wf-row--selected" : ""}`}
							title={selected ? "Click to close the detail" : "Click to inspect this workflow"}
							onClick={() => onSelect(selected ? "" : w.workflowId)}
						>
							<td>
								<div className="wf-name">{w.name}</div>
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
	);
}
