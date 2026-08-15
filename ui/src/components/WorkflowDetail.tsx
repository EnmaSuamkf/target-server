import { useState } from "react";
import type { WorkflowDetailResponse } from "../api/types.ts";
import { shortId } from "../lib/format.ts";
import { AgentBadge, SandboxBadge, StatusBadge } from "./Badges.tsx";
import { EventFeed } from "./EventFeed.tsx";
import { StepCanvas } from "./StepCanvas.tsx";
import { WorkflowCanvas } from "./WorkflowCanvas.tsx";

interface WorkflowDetailProps {
	detail: WorkflowDetailResponse | null;
	error: string | null;
	onClose: () => void;
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
 */
export function WorkflowDetail({ detail, error, onClose }: WorkflowDetailProps) {
	const [view, setView] = useState<"canvas" | "list">("canvas");
	if (error) return <div className="err">{`Workflow detail: ${error}`}</div>;
	if (!detail) return <div className="empty">Loading workflow...</div>;
	const w = detail.workflow;
	// Lifecycle events can only describe steps that have already run, so without
	// a snapshot the canvas would quietly omit everything still ahead of the
	// cursor. Better to say the hub is too old than to draw half a workflow.
	const canDrawCanvas = w.hasPlan !== false;
	return (
		<>
			<div className="wf-detail-head">
				<span className="wf-title">{w.name}</span>
				<span className="mono wf-id">{shortId(w.workflowId)}</span>
				<StatusBadge status={w.status} />
				<AgentBadge agent={w.agent} />
				<SandboxBadge sandbox={w.sandbox} image={w.image} />
				{w.user ? <span className="wf-user">{w.user}</span> : null}
				<button type="button" className="btn btn--ghost wf-close" onClick={onClose}>
					Close
				</button>
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

			<h3>Recent events</h3>
			<EventFeed events={detail.events} />
		</>
	);
}
