import type { WorkflowDetailResponse } from "../api/types.ts";
import { shortId } from "../lib/format.ts";
import { AgentBadge, SandboxBadge, StatusBadge } from "./Badges.tsx";
import { EventFeed } from "./EventFeed.tsx";
import { StepCanvas } from "./StepCanvas.tsx";

interface WorkflowDetailProps {
	detail: WorkflowDetailResponse | null;
	error: string | null;
	onClose: () => void;
}

/** The expanded workflow: header, step canvas, and its recent events. */
export function WorkflowDetail({ detail, error, onClose }: WorkflowDetailProps) {
	if (error) return <div className="err">{`Workflow detail: ${error}`}</div>;
	if (!detail) return <div className="empty">Loading workflow...</div>;
	const w = detail.workflow;
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
			<StepCanvas steps={detail.steps} />
			<h3>Recent events</h3>
			<EventFeed events={detail.events} />
		</>
	);
}
