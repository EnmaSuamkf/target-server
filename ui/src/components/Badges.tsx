import { badgeClass, kindLabel, kindTip } from "../api/kinds.ts";
import type { StepStatus, WorkflowStatus } from "../api/types.ts";

/** Kind badge: friendly label + explanation tooltip, raw kind kept in title. */
export function KindBadge({ kind }: { kind: string }) {
	return (
		<span className={badgeClass(kind)} title={`${kind} - ${kindTip(kind)}`}>
			{kindLabel(kind)}
		</span>
	);
}

/** Agent badge: the CLI that runs the workflow's steps (free-code, claude…). */
export function AgentBadge({ agent }: { agent: string | null }) {
	if (!agent) {
		return (
			<span className="badge badge--neutral" title="This workflow never reported its agent (created before the hub reported it)">
				unknown
			</span>
		);
	}
	return (
		<span className="badge badge--agent" title={`Runs on the ${agent} agent`}>
			{agent}
		</span>
	);
}

/** Sandbox badge: where the agent runs — "local" (host) or docker + image. */
export function SandboxBadge({ sandbox, image }: { sandbox: string | null; image: string | null }) {
	if (!sandbox) {
		return (
			<span className="badge badge--neutral" title="This workflow never reported its sandbox (created before the hub reported it)">
				unknown
			</span>
		);
	}
	if (sandbox === "docker") {
		return (
			<span className="badge badge--info" title={image ? `Runs inside the docker image ${image}` : "Runs inside docker"}>
				docker
			</span>
		);
	}
	return (
		<span className="badge badge--neutral" title="Runs directly on the user's machine (no container)">
			local
		</span>
	);
}

const STATUS_TONES: Record<string, string> = {
	running: "badge badge--info",
	completed: "badge badge--success",
	waiting: "badge badge--attention",
	done: "badge badge--success",
	failed: "badge badge--danger",
	draft: "badge badge--neutral",
	pending: "badge badge--neutral",
};

/** Workflow/step run state → the badge tone the hub gives that state. */
export function StatusBadge({ status }: { status: WorkflowStatus | StepStatus | null }) {
	const tone = (status && STATUS_TONES[status]) || "badge badge--neutral";
	return (
		<span className={tone}>
			{status === "running" ? <span className="badge__dot" /> : null}
			{status ?? "unknown"}
		</span>
	);
}
