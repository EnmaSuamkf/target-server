import { useMemo, useState } from "react";
import type { WorkflowStep } from "../api/types.ts";
import type { CanvasEdge, CanvasNode, CanvasStep } from "../lib/canvasLayout.ts";
import { edgePath, layoutWorkflow } from "../lib/canvasLayout.ts";

/**
 * The operator's canvas, redrawn from reported data.
 *
 * This is deliberately not "a canvas for the server": it is THE canvas, the
 * same picture the person running the workflow is looking at in their own hub.
 * The geometry comes from `lib/canvasLayout.ts`, copied verbatim from the hub —
 * a pure function over the step list with no DOM and no dependencies — so the
 * two drawings cannot drift into different shapes. Everything this file adds is
 * the rendering of a graph that has already been laid out.
 *
 * What is deliberately NOT copied is the interaction. The hub's cards are
 * buttons that take the operator to the step's row, because in the hub there is
 * somewhere to go and something to change. Here there is neither: this is a
 * read-only mirror of someone else's workflow, so the cards are plain elements
 * with titles. Making them look pressable would promise an editor that does not
 * and should not exist on a reporting dashboard.
 *
 * It needs a `workflow.plan` snapshot to be honest. Folding lifecycle events
 * can only describe steps that have already run, so without a snapshot the
 * canvas would silently draw a workflow missing everything still ahead of the
 * cursor — the caller checks `hasPlan` and shows the notice instead.
 */

/** Zoom ladder, same rungs as the hub's: a whole-workflow map up to readable. */
const ZOOM_STEPS = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1, 1.15, 1.35] as const;
/** 60% — several steps and the shape joining them on screen, titles still legible. */
const DEFAULT_ZOOM_INDEX = 3;

function cls(...names: Array<string | false | undefined>): string {
	return names.filter(Boolean).join(" ");
}

/**
 * The dashboard's step shape into the geometry's. Two things are being bridged:
 * the field names (`stepId` → `id`), and the nullability — the API leaves
 * fields null when no snapshot carried them, while the layout wants concrete
 * values. The defaults chosen here are the hub's own: a step delegates unless
 * it says otherwise, and an unknown order sorts last rather than first.
 */
function toCanvasStep(step: WorkflowStep, fallbackOrder: number): CanvasStep {
	return {
		id: step.stepId,
		kind: step.kind ?? "task",
		orderIndex: step.orderIndex ?? fallbackOrder,
		description: step.description ?? "(no description reported)",
		status: step.status,
		// Spread rather than assigned: under `exactOptionalPropertyTypes` an
		// optional field may be absent, but not explicitly `undefined`.
		...(step.phase ? { phase: step.phase } : {}),
		acceptanceCriteria: step.acceptanceCriteria ?? null,
		manualReview: step.manualReview,
		useSubagent: step.useSubagent !== false,
		maxRetries: step.maxRetries ?? 0,
		retryCount: step.retryCount ?? 0,
		selected: step.selected === true,
	};
}

export function WorkflowCanvas({ steps }: { steps: WorkflowStep[] | null }) {
	const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
	const zoom = ZOOM_STEPS[zoomIndex] ?? 1;
	const graph = useMemo(
		() => layoutWorkflow((steps ?? []).map((s, i) => toCanvasStep(s, i))),
		[steps],
	);

	if (graph.nodes.length === 0) {
		return <div className="empty">No steps reported for this workflow yet.</div>;
	}

	return (
		<div className="wf-canvas" data-workflow-canvas>
			<div className="wf-canvas-toolbar">
				<p className="wf-canvas-hint">
					This workflow as its operator sees it — one card per step, a circle for every step that has to
					satisfy a judge, and a box for the work handed to a subagent.
				</p>
				<div className="wf-zoom">
					<button
						type="button"
						className="wf-zoom-btn"
						onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
						disabled={zoomIndex === 0}
						aria-label="Zoom out"
						title="Zoom out"
					>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
							<path d="M5 12h14" />
						</svg>
					</button>
					<span className="wf-zoom-level mono">{Math.round(zoom * 100)}%</span>
					<button
						type="button"
						className="wf-zoom-btn"
						onClick={() => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
						disabled={zoomIndex === ZOOM_STEPS.length - 1}
						aria-label="Zoom in"
						title="Zoom in"
					>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
							<path d="M12 5v14M5 12h14" />
						</svg>
					</button>
				</div>
			</div>

			<div className="wf-viewport">
				{/* Two boxes, because a transform doesn't change layout: the outer one
				    is the drawing at its ZOOMED size so the scroll area matches what is
				    on screen, the inner one is the drawing at natural size scaled into
				    it from its top-left corner. */}
				<div className="wf-stage" style={{ width: graph.width * zoom, height: graph.height * zoom }}>
					<div
						className="wf-drawing"
						style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}
					>
						<svg
							className="wf-edges"
							width={graph.width}
							height={graph.height}
							viewBox={`0 0 ${graph.width} ${graph.height}`}
							aria-hidden="true"
						>
							<defs>
								{/* One arrowhead per state: a marker cannot inherit the stroke
								    of the path that uses it. */}
								{(["pending", "active", "done"] as const).map((state) => (
									<marker
										key={state}
										id={`wf-arrow-${state}`}
										viewBox="0 0 10 10"
										refX="9"
										refY="5"
										markerWidth="6"
										markerHeight="6"
										orient="auto-start-reverse"
									>
										<path d="M0 0 L10 5 L0 10 z" className={`wf-head wf-head--${state}`} />
									</marker>
								))}
							</defs>
							{graph.edges.map((edge) => (
								<EdgeLine key={edge.id} edge={edge} />
							))}
						</svg>

						{graph.nodes.map((node) =>
							node.kind === "judge" ? (
								<JudgeCircle key={node.id} node={node} />
							) : node.kind === "subagent" ? (
								<SubagentBox key={node.id} node={node} />
							) : (
								<StepCard key={node.id} node={node} />
							),
						)}
					</div>
				</div>
			</div>

			<ul className="wf-legend">
				<li><span className="wf-swatch wf-swatch--running" aria-hidden="true" /> in flight</li>
				<li><span className="wf-swatch wf-swatch--done" aria-hidden="true" /> done</li>
				<li><span className="wf-swatch wf-swatch--waiting" aria-hidden="true" /> waiting for a human</li>
				<li><span className="wf-swatch wf-swatch--failed" aria-hidden="true" /> failed</li>
				<li><span className="wf-swatch wf-swatch--judge" aria-hidden="true" /> judged step</li>
				<li><span className="wf-swatch wf-swatch--subagent" aria-hidden="true" /> runs in a subagent</li>
			</ul>
		</div>
	);
}

function EdgeLine({ edge }: { edge: CanvasEdge }) {
	return (
		<path
			d={edgePath(edge)}
			className={cls("wf-edge", `wf-edge--${edge.state}`, edge.kind === "retry" && "wf-edge--retry")}
			markerEnd={`url(#wf-arrow-${edge.state})`}
			fill="none"
		/>
	);
}

function StepCard({ node }: { node: CanvasNode }) {
	const isContext = node.kind === "context";
	return (
		<div
			data-canvas-node={node.id}
			className={cls("wf-card", `wf-state--${node.state}`, isContext && "wf-card--context", node.selected && "wf-card--selected")}
			style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
			title={node.description}
		>
			<span className="wf-card-head">
				<span className="wf-card-index mono">{node.label}</span>
				<span className="wf-card-state">
					{isLiveState(node.state) && <span className="wf-dot" aria-hidden="true" />}
					{node.state}
				</span>
			</span>
			<span className="wf-card-body">{node.description}</span>
			{!isContext && (node.manualReview || node.inline || node.selected) && (
				<span className="wf-card-foot">
					{node.selected && <span className="wf-flag">selected</span>}
					{node.manualReview && <span className="wf-flag">manual review</span>}
					{node.inline && <span className="wf-flag">inline</span>}
				</span>
			)}
		</div>
	);
}

function SubagentBox({ node }: { node: CanvasNode }) {
	return (
		<div
			data-canvas-node={node.id}
			data-canvas-subagent
			className={cls("wf-subagent", `wf-state--${node.state}`)}
			style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
			title="This step's work is delegated to a subagent (the Task tool), so the shared session only keeps its summary."
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
				<path d="M6 3v6a3 3 0 0 0 3 3h9" />
				<path d="M15 9l3 3-3 3" />
				<circle cx="6" cy="18" r="2" />
			</svg>
			<span className="wf-subagent-label">subagent</span>
			{isLiveState(node.state) && <span className="wf-dot" aria-hidden="true" />}
		</div>
	);
}

function JudgeCircle({ node }: { node: CanvasNode }) {
	return (
		<div
			data-canvas-node={node.id}
			data-canvas-judge
			className={cls("wf-judge", `wf-judge--${node.state}`)}
			style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
			title={`Accepts if: ${node.description}`}
		>
			<span className="wf-judge-ring" aria-hidden="true" />
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
				<path d="M12 3v18M5 7h14M6 7l-3 6a3.5 3.5 0 0 0 6 0L6 7zM18 7l-3 6a3.5 3.5 0 0 0 6 0l-3-6z" />
			</svg>
			<span className="wf-judge-label mono">{node.retries ? `${node.retries.count}/${node.retries.max}` : "judge"}</span>
		</div>
	);
}

function isLiveState(state: CanvasNode["state"]): boolean {
	return state === "running" || state === "queued" || state === "judging" || state === "waiting";
}
