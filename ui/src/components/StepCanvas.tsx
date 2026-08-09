import type { WorkflowStep } from "../api/types.ts";
import { formatDuration } from "../lib/format.ts";
import { StatusBadge } from "./Badges.tsx";

/**
 * The step canvas: Target's canvas read vertically — status dots down a 2px
 * rail on the left, one node per step with its number, status, description and
 * (once settled) duration.
 */
export function StepCanvas({ steps }: { steps: WorkflowStep[] | null }) {
	if (!steps || steps.length === 0) return <div className="empty">No steps reported for this workflow yet.</div>;
	return (
		<ol className="steps-canvas">
			{steps.map((s) => (
				<li className="step-node" key={s.stepId}>
					<span className={`step-dot step-dot--${s.status}`} />
					<div className="step-body">
						<div className="step-head">
							<span className="mono step-num">{`#${(s.orderIndex ?? 0) + 1}`}</span>
							<StatusBadge status={s.status} />
							{s.retryCount ? <span className="step-extra mono">{`retry ${s.retryCount}`}</span> : null}
							{s.durationMs != null && (s.status === "done" || s.status === "failed") ? (
								<span className="step-dur mono">{formatDuration(s.durationMs)}</span>
							) : null}
						</div>
						<div className="step-desc">{s.description ?? "(no description reported)"}</div>
					</div>
				</li>
			))}
		</ol>
	);
}
