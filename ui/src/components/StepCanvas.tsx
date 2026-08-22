import type { WorkflowStep } from "../api/types.ts";
import { formatDuration } from "../lib/format.ts";
import { StatusBadge } from "./Badges.tsx";
import { StepNotes } from "./StepNotes.tsx";

/**
 * Workflow steps as cards — the same read-only shape as the Target hub's step
 * list: description, meta badges, acceptance criteria, and sticky notes.
 */
export function StepCanvas({ steps }: { steps: WorkflowStep[] | null }) {
	if (!steps || steps.length === 0) return <div className="empty">No steps reported for this workflow yet.</div>;
	return (
		<ol className="step-list">
			{steps.map((s) => (
				<StepCard key={s.stepId} step={s} />
			))}
		</ol>
	);
}

function StepCard({ step }: { step: WorkflowStep }): React.JSX.Element {
	const isContext = step.kind === "context";
	const statusLabel =
		step.status === "running" && step.phase === "judge" ? "judging" : (step.status ?? "pending");
	const delegated = !isContext && step.useSubagent !== false;
	const inline = !isContext && step.useSubagent === false;
	const maxRetries = step.maxRetries ?? 0;
	const retryCount = step.retryCount ?? 0;
	const cardClass = [
		"step-card",
		step.status === "running" ? "step-card--running" : "",
		step.status === "waiting" ? "step-card--waiting" : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<li className={cardClass} data-step-id={step.stepId}>
			<div className="step-card__head">
				<span className="step-card__index">{isContext ? "ctx" : (step.orderIndex ?? 0) + 1}</span>
				<p className="step-card__desc">{step.description ?? "(no description reported)"}</p>
				<StatusBadge status={statusLabel} />
			</div>

			{isContext ? (
				<p className="step-card__hint">Conversation context — delivered before every other step.</p>
			) : null}

			{(step.hasAcceptanceCriteria ||
				step.manualReview ||
				delegated ||
				inline ||
				step.manualRun ||
				(step.durationMs != null && (step.status === "done" || step.status === "failed"))) && (
				<div className="step-card__meta">
					{step.hasAcceptanceCriteria ? (
						<span className="step-card__meta-item">
							judged
							{maxRetries > 0 ? (
								<span className="step-card__retries">{`${retryCount}/${maxRetries}`}</span>
							) : null}
						</span>
					) : null}
					{step.manualReview ? <span className="step-card__meta-item">manual review</span> : null}
					{delegated ? <span className="step-card__meta-item">subagent</span> : null}
					{inline ? <span className="step-card__meta-item">inline</span> : null}
					{step.manualRun ? <span className="step-card__meta-item">manual run</span> : null}
					{step.durationMs != null && (step.status === "done" || step.status === "failed") ? (
						<span className="step-card__meta-item">{formatDuration(step.durationMs)}</span>
					) : null}
				</div>
			)}

			{step.acceptanceCriteria ? (
				<div className="step-card__criteria">
					<span className="step-card__criteria-label">Accepts if:</span>
					<div className="step-card__criteria-body">{step.acceptanceCriteria}</div>
				</div>
			) : null}

			{!isContext && step.notes && step.notes.length > 0 ? <StepNotes notes={step.notes} /> : null}
		</li>
	);
}
