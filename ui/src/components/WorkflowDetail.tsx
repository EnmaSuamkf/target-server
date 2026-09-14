import { useState } from "react";
import type { WorkflowDetailResponse } from "../api/types.ts";
import { compactNumber, shortId } from "../lib/format.ts";
import { AgentBadge, SandboxBadge, StatusBadge } from "./Badges.tsx";
import { EventFeed } from "./EventFeed.tsx";
import { StepCanvas } from "./StepCanvas.tsx";
import { UsageMeter } from "./UsageMeter.tsx";
import { WorkflowCanvas } from "./WorkflowCanvas.tsx";

interface WorkflowDetailProps {
	detail: WorkflowDetailResponse | null;
	error: string | null;
	onClose: () => void;
	/** Hide the close control when embedded inside another panel. */
	embedded?: boolean;
}

/**
 * The expanded workflow: header, its steps, and its recent events.
 *
 * The steps are shown two ways because they answer two questions. The canvas is
 * the operator's own picture — what runs after what, what is judged, where the
 * run currently is — and it is the default, since reproducing it here is the
 * whole point of reporting the plan. The list is the same steps read as a
 * record: numbers, durations, one row at a time, which is what you want when
 * you are reading a finished run rather than watching a live one.
 *
 * Under them comes the token usage, one meter per Claude session, printed the
 * way the operator's own client prints it — the point of reporting usage at all
 * is that the two agree.
 */
export function WorkflowDetail({ detail, error, onClose, embedded = false }: WorkflowDetailProps) {
	const [view, setView] = useState<"canvas" | "list">("canvas");
	const [showAllUsageSessions, setShowAllUsageSessions] = useState(false);
	if (error) return <div className="err">{`Workflow detail: ${error}`}</div>;
	if (!detail) return <div className="empty">Loading workflow...</div>;
	const w = detail.workflow;
	// Lifecycle events can only describe steps that have already run, so without
	// a snapshot the canvas would quietly omit everything still ahead of the
	// cursor. Better to say the hub is too old than to draw half a workflow.
	const canDrawCanvas = w.hasPlan !== false;
	// A server older than the usage readout sends no `usage` at all; treat that
	// the same as a workflow that never reported a snapshot.
	const usage = detail.usage;
	const sessions = usage?.sessions ?? [];
	// Restarts create a new Claude session each time — mirror the hub and show the
	// current one by default, not every historical context bar stacked together.
	const visibleSessions =
		showAllUsageSessions || sessions.length <= 1 ? sessions : sessions.slice(0, 1);
	return (
		<>
			<div className="wf-detail-head">
				<span className="wf-title">{w.name}</span>
				<span className="mono wf-id">{shortId(w.workflowId)}</span>
				<StatusBadge status={w.status} />
				<AgentBadge agent={w.agent} />
				<SandboxBadge sandbox={w.sandbox} image={w.image} />
				{w.user ? <span className="wf-user">{w.user}</span> : null}
				{embedded ? null : (
					<button type="button" className="btn btn--ghost wf-close" onClick={onClose}>
						Close
					</button>
				)}
			</div>

			<div className="wf-view-switch">
				<button
					type="button"
					className={`btn btn--sm${view === "canvas" ? " btn--on" : ""}`}
					onClick={() => setView("canvas")}
					aria-pressed={view === "canvas"}
				>
					Canvas
				</button>
				<button
					type="button"
					className={`btn btn--sm${view === "list" ? " btn--on" : ""}`}
					onClick={() => setView("list")}
					aria-pressed={view === "list"}
				>
					List
				</button>
			</div>

			{view === "list" ? (
				<StepCanvas steps={detail.steps} />
			) : canDrawCanvas ? (
				<WorkflowCanvas steps={detail.steps} />
			) : (
				<div className="wf-no-plan">
					This workflow has not reported a plan snapshot, so its canvas cannot be drawn faithfully — the
					steps that never ran are not in the event stream. Update the reporting Target instance, or use the
					list view.
				</div>
			)}

			<h3>Token usage</h3>
			{sessions.length === 0 ? (
				<div className="empty">No usage snapshots reported for this workflow.</div>
			) : (
				<>
					{sessions.length > 1 ? (
						<div className="panel-note usage-summary">
							<span>
								{showAllUsageSessions
									? `${sessions.length} sessions · in ${compactNumber(usage?.inputTokens ?? 0)} · out ${compactNumber(usage?.outputTokens ?? 0)} in total`
									: `Latest of ${sessions.length} sessions · in ${compactNumber(visibleSessions[0]?.inputTokens ?? 0)} · out ${compactNumber(visibleSessions[0]?.outputTokens ?? 0)}`}
							</span>
							<button
								type="button"
								className="btn btn--sm btn--ghost"
								onClick={() => setShowAllUsageSessions((v) => !v)}
							>
								{showAllUsageSessions ? "Show latest only" : `Show all ${sessions.length} sessions`}
							</button>
						</div>
					) : null}
					<div className="usage-list">
						{visibleSessions.map((u) => (
							<UsageMeter key={u.sessionId ?? u.receivedAt} usage={u} />
						))}
					</div>
				</>
			)}

			<h3>Recent events</h3>
			<EventFeed events={detail.events} />
		</>
	);
}
