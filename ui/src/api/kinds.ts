/**
 * Event kinds, translated for humans: a short Title Case label everywhere the
 * kind is displayed, plus a one-line explanation shown as a tooltip. The raw
 * kind stays visible as secondary mono text (and in `title`) so filters and the
 * API docs keep matching what you see. Unknown future kinds degrade to the raw
 * string with a generic tooltip.
 */
interface KindInfo {
	label: string;
	tip: string;
}

export const KIND_INFO: Record<string, KindInfo> = {
	"workflow.created": {
		label: "Workflow created",
		tip: "A user created a new workflow (its steps are reported as 'Step added'). Carries the agent and sandbox it runs with.",
	},
	"workflow.updated": {
		label: "Workflow updated",
		tip: "The workflow's name, agent or sandbox changed — also sent when the hub starts, to re-announce the workflows it knows.",
	},
	"workflow.status_changed": {
		label: "Workflow status changed",
		tip: "The workflow moved to a new state (running, completed, failed, cancelled...).",
	},
	"workflow.plan": {
		label: "Plan snapshot",
		tip: "The workflow's whole plan as it stands right now: name, status and every step with its state. This is what lets the dashboard draw the canvas faithfully.",
	},
	"workflow.removed": {
		label: "Workflow removed",
		tip: "The user deleted the workflow from their hub.",
	},
	"workflow.failed": {
		label: "Workflow failed",
		tip: "The workflow run aborted with an error.",
	},
	"step.added": {
		label: "Step added",
		tip: "A step was added to the workflow plan. These events let the dashboard draw the workflow's structure.",
	},
	"step.started": {
		label: "Step started",
		tip: "A workflow step began executing on the user's machine.",
	},
	"step.done": {
		label: "Step finished",
		tip: "A step finished successfully. Carries how long it took and how many tokens it used.",
	},
	"step.failed": {
		label: "Step failed",
		tip: "A step ended with an error (the message travels in the event payload).",
	},
	"step.waiting": {
		label: "Step waiting",
		tip: "A step is queued and waiting - either for its turn, or for the user to run it by hand.",
	},
	"step.judged": {
		label: "Step reviewed",
		tip: "An automated review checked the step's result against its acceptance criteria and passed or failed it.",
	},
	"step.note.added": {
		label: "Note added",
		tip: "A sticky note was attached to a workflow step.",
	},
	"step.note.modified": {
		label: "Note edited",
		tip: "A sticky note on a workflow step was changed.",
	},
	"step.note.deleted": {
		label: "Note removed",
		tip: "A sticky note was removed from a workflow step.",
	},
	"usage.snapshot": {
		label: "Token usage",
		tip: "Periodic counters of the tokens the model consumed in the current step (input, output, cache).",
	},
	"conversation.snapshot": {
		label: "Conversation snapshot",
		tip: "A privacy-safe summary of the ongoing conversation: turn count and mode only - message content is never sent.",
	},
	heartbeat: {
		label: "Heartbeat",
		tip: "An 'I'm alive' ping each instance sends every 30 seconds while the hub runs. Powers the 'Last seen' column.",
	},
};

export function kindLabel(kind: string): string {
	return KIND_INFO[kind]?.label ?? kind;
}

export function kindTip(kind: string): string {
	return KIND_INFO[kind]?.tip ?? `Raw event kind "${kind}" - newer than this dashboard, no description yet.`;
}

/** Event kind → the badge tone the hub would give that state. */
export function badgeClass(kind: string): string {
	if (kind === "step.failed" || kind === "workflow.failed") return "badge badge--danger";
	if (kind === "step.done" || kind === "step.judged" || kind === "workflow.completed") return "badge badge--success";
	if (kind.startsWith("step") || kind.startsWith("workflow")) return "badge badge--info";
	if (kind.startsWith("usage") || kind.startsWith("conversation")) return "badge badge--warn";
	return "badge badge--neutral"; // heartbeat and anything new
}
