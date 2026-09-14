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
	deleting: "badge badge--warn",
};

const SYNC_ARROWS_SVG = (
	<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
		<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" strokeLinecap="round" strokeLinejoin="round" />
		<path d="M3 3v5h5" strokeLinecap="round" strokeLinejoin="round" />
		<path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" strokeLinecap="round" strokeLinejoin="round" />
		<path d="M16 16h5v5" strokeLinecap="round" strokeLinejoin="round" />
	</svg>
);

/** Sync indicator — same sync icon; spins while syncing, static green when synced. */
function SyncLinkIcon({ synced, title }: { synced: boolean; title: string }) {
	return (
		<span
			className={`sync-link-icon${synced ? " sync-link-icon--synced" : " sync-link-icon--syncing"}`}
			title={title}
			aria-label={title}
			role="img"
		>
			{SYNC_ARROWS_SVG}
		</span>
	);
}

const STEP_ACKED = new Set(["running", "waiting", "done", "completed", "failed"]);

/** Whether a mirrored step is confirmed on the client. */
export function isStepSyncedOnClient(
	step: { on_client?: boolean; status?: string | null },
	workflowOnClient: boolean,
): boolean {
	if (!workflowOnClient) return false;
	const s = step.status ?? "pending";
	return Boolean(step.on_client) || STEP_ACKED.has(s);
}

/** Count steps still waiting to be applied on the client. */
export function countStepsPendingSync(
	steps: { on_client?: boolean; status?: string | null }[],
	workflowOnClient: boolean,
): number {
	if (!workflowOnClient) return 0;
	return steps.filter((step) => !isStepSyncedOnClient(step, true)).length;
}

/** Whether a remote workflow is fully synced (on client and every step applied). */
export function ClientSyncBadge({
	localId,
	stepsPendingSync = 0,
}: {
	localId: string | null;
	stepsPendingSync?: number;
}) {
	const workflowOnClient = Boolean(localId);
	const synced = workflowOnClient && stepsPendingSync === 0;
	const title = !workflowOnClient
		? "Syncing to client — waiting for workflow.create to be applied"
		: stepsPendingSync > 0
			? `Syncing to client — ${stepsPendingSync} step${stepsPendingSync === 1 ? "" : "s"} still applying`
			: `Synced to client · ${localId}`;
	return <SyncLinkIcon synced={synced} title={title} />;
}

/** Step sync indicator — same icon language as the workflow badge. */
export function StepClientBadge({
	status,
	workflowOnClient,
	onClient = false,
}: {
	status: StepStatus | string | null;
	workflowOnClient: boolean;
	onClient?: boolean;
}) {
	const s = status ?? "pending";
	const synced = isStepSyncedOnClient({ on_client: onClient, status: s }, workflowOnClient);
	const title = !workflowOnClient
		? "Syncing — workflow not on client yet"
		: synced
			? `Synced on client · step status: ${s}`
			: "Syncing — waiting for step changes to be applied on the client";
	return (
		<span className="sync-step-client">
			<SyncLinkIcon synced={synced} title={title} />
			<StatusBadge status={s as StepStatus} />
		</span>
	);
}

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
