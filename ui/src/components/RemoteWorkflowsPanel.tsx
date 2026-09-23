import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
	appendRemoteTemplate,
	createRemoteWorkflow,
	deleteRemoteWorkflow,
	enqueueRemoteCommand,
	setRemoteWorkflowResourceSets,
	setRemoteWorkflowTcps,
	updateRemoteWorkflowContext,
	updateRemoteStepRunSelection,
} from "../api/sync.ts";
import type {
	FieldError,
	ResourceSelection,
	ResourceSetsResponse,
	SyncClientRow,
	SyncCommand,
	SyncEventRow,
	SyncRemoteStepRow,
	SyncRemoteWorkflowDetailResponse,
	SyncRemoteWorkflowRow,
	TcpSelection,
	TcpsResponse,
	TemplatesResponse,
	WorkflowDetailResponse,
	WorkflowStep,
} from "../api/types.ts";
import { useApi } from "../hooks/useApi.ts";
import { sameResourceSelections } from "../lib/rciSelection.ts";
import { sameTcpSelections } from "../lib/tcpSelection.ts";
import { Field } from "./Field.tsx";
import { Modal } from "./Modal.tsx";
import { ResourceSelectionEditor } from "./ResourceSelectionEditor.tsx";
import { TcpSelectionEditor } from "./TcpSelectionEditor.tsx";
import { shortId, timeAgo } from "../lib/format.ts";
import { WorkflowDetail } from "./WorkflowDetail.tsx";
import {
	AgentBadge,
	ClientSyncBadge,
	countStepsPendingSync,
	SandboxBadge,
	StatusBadge,
	StepClientBadge,
} from "./Badges.tsx";
import { StepCanvas } from "./StepCanvas.tsx";
import { WorkflowCanvas } from "./WorkflowCanvas.tsx";

function fieldErrors(errors: FieldError[], field: string) {
	return errors.filter((e) => e.field === field || e.field.startsWith(`${field}.`));
}


/** Next `step-N` key that does not collide after removals (N = max existing suffix + 1). */
function nextRemoteStepKey(existingKeys: string[]): string {
	let max = 0;
	for (const key of existingKeys) {
		const match = /^step-(\d+)$/.exec(key);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return `step-${max + 1}`;
}

/** Plan-preview steps only — run state lives in Client activity (ingest), not the sync mirror. */
function remoteStepsToCanvas(steps: SyncRemoteStepRow[], context: string | null): WorkflowStep[] {
	const out: WorkflowStep[] = [];
	if (context?.trim()) {
		out.push({
			stepId: "context",
			orderIndex: 0,
			description: context.trim(),
			// Context is hub-owned; the client never mirrors its status into remote_workflow_steps.
			status: "pending",
			statusAt: null,
			durationMs: null,
			retryCount: null,
			startedAt: null,
			finishedAt: null,
			judged: null,
			manualReview: false,
			hasAcceptanceCriteria: false,
			kind: "context",
			useSubagent: true,
			maxRetries: 0,
			manualRun: false,
			acceptanceCriteria: null,
			notes: [],
		});
	}
	for (const s of steps) {
		out.push({
			stepId: s.step_key,
			orderIndex: s.order_index + (context?.trim() ? 1 : 0),
			description: s.description,
			status: s.status,
			statusAt: null,
			durationMs: null,
			retryCount: 0,
			startedAt: null,
			finishedAt: null,
			judged: null,
			manualReview: s.manual_review,
			hasAcceptanceCriteria: Boolean(s.acceptance_criteria?.trim()),
			acceptanceCriteria: s.acceptance_criteria,
			kind: "task",
			useSubagent: s.use_subagent,
			maxRetries: s.max_retries,
			manualRun: false,
			notes: [],
		});
	}
	return out;
}

interface StepFormState {
	description: string;
	acceptanceCriteria: string;
	manualReview: boolean;
	useSubagent: boolean;
	maxRetries: string;
	retryInterval: string;
}

const RUNNER_LABELS: Record<string, string> = {
	claude: "Claude",
	"free-code": "Free Code",
	cursor: "Cursor",
};

const POLL_MS = 4000;
const RUN_LIFECYCLE_COMMANDS = new Set(["workflow.start", "workflow.resume", "workflow.restart"]);

/** Start only runs pending steps; completed/failed workflows or done steps need restart. */
function computeRunAction(
	workflowStatus: string | null,
	selectedSteps: SyncRemoteStepRow[],
): "start" | "resume" | "restart" {
	const hasNonPending = selectedSteps.some((s) => s.status !== "pending");
	if (workflowStatus === "paused") return hasNonPending ? "restart" : "resume";
	if (
		workflowStatus === "completed" ||
		workflowStatus === "done" ||
		workflowStatus === "failed" ||
		hasNonPending
	) {
		return "restart";
	}
	return "start";
}

function formatSyncEventSummary(ev: SyncEventRow): string | null {
	if (ev.type === "workflow.status_changed" && typeof ev.payload.to === "string") {
		return `Workflow status → ${ev.payload.to}`;
	}
	if (ev.type === "step.status_changed" && typeof ev.payload.to === "string") {
		return `${String(ev.payload.step_key ?? "step")} → ${ev.payload.to}`;
	}
	if (ev.type === "step.result" && typeof ev.payload.outcome === "string") {
		return `${String(ev.payload.step_key ?? "step")}: ${ev.payload.outcome}`;
	}
	if (ev.type === "command.ack") {
		const ackStatus = String(ev.payload.status ?? "");
		if (ackStatus === "failed") {
			const msg = (ev.payload.error as { message?: string } | undefined)?.message;
			return msg ? `Command failed — ${msg}` : "Command failed on client";
		}
		return ackStatus === "acked" ? "Command applied on client" : null;
	}
	if (ev.type === "workflow.created") return "Workflow created on client";
	return null;
}

function describeRunState({
	status,
	pendingCommands,
	stepsPendingSync,
	hasLocalId,
}: {
	status: string | null;
	pendingCommands: SyncCommand[];
	stepsPendingSync: number;
	hasLocalId: boolean;
}): { tone: "info" | "warn" | "success" | "neutral"; message: string } {
	const pendingRun = pendingCommands.find((c) => RUN_LIFECYCLE_COMMANDS.has(c.type));
	if (!hasLocalId) {
		return { tone: "warn", message: "Workflow not on the client yet — wait for workflow.create to finish syncing." };
	}
	if (stepsPendingSync > 0) {
		return {
			tone: "warn",
			message: `${stepsPendingSync} step${stepsPendingSync === 1 ? "" : "s"} still syncing — finish before starting.`,
		};
	}
	if (pendingRun) {
		const waiting = pendingRun.status === "pending" ? "queued" : "delivered to client";
		return {
			tone: "info",
			message: `${pendingRun.type.replace("workflow.", "")} ${waiting} — waiting for the client to apply it (poll ~30s).`,
		};
	}
	if (status === "running" || status === "waiting") {
		return { tone: "success", message: `Running on the client — status ${status}.` };
	}
	if (status === "completed" || status === "done") {
		return { tone: "neutral", message: "Workflow finished on the client." };
	}
	if (status === "failed") {
		return { tone: "warn", message: "Workflow failed on the client." };
	}
	return { tone: "neutral", message: "Ready to start on the client." };
}

const EMPTY_STEP: StepFormState = {
	description: "",
	acceptanceCriteria: "",
	manualReview: false,
	useSubagent: true,
	maxRetries: "0",
	retryInterval: "0",
};

interface WorkflowPermissions {
	create: boolean;
	addStep: boolean;
	editStep: boolean;
	manage: boolean;
	execute: boolean;
	templatesRead: boolean;
	tcpRead: boolean;
	rciRead: boolean;
}

interface Props {
	clients: SyncClientRow[] | null;
	workflows: SyncRemoteWorkflowRow[] | null;
	detail: SyncRemoteWorkflowDetailResponse | null;
	events: SyncEventRow[] | null;
	selectedId: string;
	onSelect: (id: string) => void;
	onRefresh: () => void;
	permissions: WorkflowPermissions;
	onOpenInActivity: (localWorkflowId: string) => void;
}

/** Operator control for server-side remote workflows — Target-like plan editor. */
export function RemoteWorkflowsPanel({
	clients,
	workflows,
	detail,
	events,
	selectedId,
	onSelect,
	onRefresh,
	permissions,
	onOpenInActivity,
}: Props) {
	const [clientId, setClientId] = useState("");
	const [agent, setAgent] = useState("");
	const [name, setName] = useState("");
	const [createContext, setCreateContext] = useState("");
	const [errors, setErrors] = useState<FieldError[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [view, setView] = useState<"canvas" | "list">("canvas");
	const [contextDraft, setContextDraft] = useState("");
	const [stepForm, setStepForm] = useState<StepFormState>(EMPTY_STEP);
	const [addOpen, setAddOpen] = useState(false);
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [selectedStepKeys, setSelectedStepKeys] = useState<Set<string>>(new Set());
	const [templateId, setTemplateId] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	const [appendTemplateId, setAppendTemplateId] = useState("");
	const [tcpDraft, setTcpDraft] = useState<TcpSelection[]>([]);
	const [rciDraft, setRciDraft] = useState<ResourceSelection[]>([]);
	const [catalogError, setCatalogError] = useState<string | null>(null);

	const activeClients = (clients ?? []).filter((c) => c.status === "active");
	const createClient = activeClients.find((c) => c.id === clientId) ?? null;
	const installedRunners = (createClient?.capabilities?.runners ?? []).filter((r) => r.installed);
	const selected = detail?.remote_workflow ?? workflows?.find((w) => w.id === selectedId) ?? null;
	const steps = detail?.steps ?? [];
	const pendingCommands = detail?.pending_commands ?? [];
	const selectedClient = activeClients.find((c) => c.id === selected?.client_id) ?? null;
	const { data: reportedDetail, error: reportedDetailErr } = useApi<WorkflowDetailResponse>(
		selected?.local_id ? `/api/workflows/${encodeURIComponent(selected.local_id)}` : null,
		POLL_MS,
	);
	const { data: templatesData } = useApi<TemplatesResponse>(
		permissions.templatesRead ? "/api/templates" : null,
	);
	const { data: tcpsData } = useApi<TcpsResponse>(permissions.tcpRead ? "/api/tcps" : null);
	const { data: resourceSetsData } = useApi<ResourceSetsResponse>(
		permissions.rciRead ? "/api/resource-sets" : null,
	);
	const templates = templatesData?.templates ?? [];
	const tcps = tcpsData?.tcps ?? [];
	const resourceSets = resourceSetsData?.resourceSets ?? [];
	const canSaveTcps = permissions.manage && permissions.tcpRead;
	const canSaveRci = permissions.manage && permissions.rciRead;
	const canvasSteps = useMemo(
		() => remoteStepsToCanvas(steps, selected?.conversation_context ?? null),
		[steps, selected?.conversation_context],
	);

	// Re-seed when the workflow or server-side run selection changes — not on every poll refresh.
	const stepPlanSignature = useMemo(
		() => steps.map((s) => `${s.step_key}:${s.run_selected ? 1 : 0}`).join("\0"),
		[steps],
	);
	useEffect(() => {
		setSelectedStepKeys(
			new Set(steps.filter((s) => s.run_selected !== false).map((s) => s.step_key)),
		);
	}, [selectedId, stepPlanSignature]);

	useEffect(() => {
		setTcpDraft(selected?.tcp_selections ?? []);
		setRciDraft(selected?.resource_selections ?? []);
		setAppendTemplateId("");
		setCatalogError(null);
	}, [selectedId]);

	const selectedStepKeysList = useMemo(() => [...selectedStepKeys], [selectedStepKeys]);
	const allStepsSelected = steps.length > 0 && selectedStepKeys.size === steps.length;
	const persistRunSelection = useCallback(
		async (keys: string[]) => {
			if (!selected || !permissions.manage) return;
			await updateRemoteStepRunSelection(selected.id, keys);
		},
		[selected, permissions.manage],
	);

	const toggleStepKey = useCallback(
		(stepKey: string) => {
			setSelectedStepKeys((prev) => {
				const next = new Set(prev);
				if (next.has(stepKey)) next.delete(stepKey);
				else next.add(stepKey);
				void persistRunSelection([...next]);
				return next;
			});
		},
		[persistRunSelection],
	);
	const toggleAllStepKeys = useCallback(() => {
		const next = allStepsSelected ? new Set<string>() : new Set(steps.map((s) => s.step_key));
		setSelectedStepKeys(next);
		void persistRunSelection([...next]);
	}, [allStepsSelected, steps, persistRunSelection]);

	const runPayload = useCallback(() => ({ step_keys: selectedStepKeysList }), [selectedStepKeysList]);

	const onCreate = useCallback(
		async (e: FormEvent) => {
			e.preventDefault();
			setBusy(true);
			setErrors([]);
			setNotice(null);
			try {
				const body: {
					client_id: string;
					name: string;
					conversation_context?: string;
					agent?: string;
					template_id?: string;
				} = {
					client_id: clientId,
					name,
				};
				const ctx = createContext.trim();
				if (ctx) body.conversation_context = ctx;
				if (agent) body.agent = agent;
				if (templateId) body.template_id = templateId;
				const res = await createRemoteWorkflow(body);
				if (!res.ok) {
					setErrors(res.errors);
					return;
				}
				const agentLabel = res.data.remote_workflow.agent ?? agent ?? "client default";
				const fromTemplate = templateId
					? ` from template “${templates.find((t) => t.id === templateId)?.name ?? templateId}”`
					: "";
				setNotice(
					`Created “${res.data.remote_workflow.name}” (${agentLabel}, docker)${fromTemplate} — workflow.create queued.`,
				);
				setName("");
				setCreateContext("");
				setAgent("");
				setTemplateId("");
				setCreateOpen(false);
				onSelect(res.data.remote_workflow.id);
				onRefresh();
			} finally {
				setBusy(false);
			}
		},
		[clientId, name, agent, createContext, templateId, templates, onRefresh, onSelect],
	);

	const runCommand = useCallback(
		async (type: string, payload: Record<string, unknown> = {}) => {
			if (!selected) return;
			setBusy(true);
			setNotice(null);
			setErrors([]);
			try {
				const res = await enqueueRemoteCommand(selected.id, { type, payload });
				if (!res.ok) {
					setErrors(res.errors);
					return;
				}
				setNotice(`Queued ${type} (sequence ${res.command.sequence}).`);
				onRefresh();
			} finally {
				setBusy(false);
			}
		},
		[selected, onRefresh],
	);

	const onDelete = useCallback(async () => {
		if (!selected) return;
		const label = selected.name ?? shortId(selected.id);
		if (
			!window.confirm(
				`Delete remote workflow “${label}”? This queues workflow.delete on the client and marks the workflow as deleting.`,
			)
		) {
			return;
		}
		setBusy(true);
		setNotice(null);
		setErrors([]);
		try {
			const res = await deleteRemoteWorkflow(selected.id);
			if (!res.ok) {
				setNotice(res.error);
				return;
			}
			setNotice(
				`Delete queued (workflow.delete, sequence ${res.command.sequence}). It will disappear from the list once the client confirms.`,
			);
			onSelect("");
			onRefresh();
		} finally {
			setBusy(false);
		}
	}, [selected, onRefresh, onSelect]);

	const onAppendTemplate = useCallback(async () => {
		if (!selected || !appendTemplateId) return;
		setBusy(true);
		setNotice(null);
		setErrors([]);
		setCatalogError(null);
		try {
			const res = await appendRemoteTemplate(selected.id, appendTemplateId);
			if (!res.ok) {
				setErrors(res.errors);
				setCatalogError(res.errors[0]?.message ?? "Could not append template.");
				return;
			}
			const label = templates.find((t) => t.id === appendTemplateId)?.name ?? appendTemplateId;
			setNotice(`Appended steps from “${label}” — step.add queued.`);
			setAppendTemplateId("");
			setTcpDraft(res.data.remote_workflow.tcp_selections ?? []);
			setRciDraft(res.data.remote_workflow.resource_selections ?? []);
			onRefresh();
		} finally {
			setBusy(false);
		}
	}, [selected, appendTemplateId, templates, onRefresh]);

	const onSaveTcps = useCallback(async () => {
		if (!selected) return;
		setBusy(true);
		setCatalogError(null);
		setNotice(null);
		try {
			const res = await setRemoteWorkflowTcps(selected.id, tcpDraft);
			if (!res.ok) {
				setCatalogError(res.error);
				return;
			}
			setTcpDraft(res.remote_workflow.tcp_selections ?? tcpDraft);
			setNotice("TCP selection saved and queued for the client.");
			onRefresh();
		} finally {
			setBusy(false);
		}
	}, [selected, tcpDraft, onRefresh]);

	const onSaveRci = useCallback(async () => {
		if (!selected) return;
		setBusy(true);
		setCatalogError(null);
		setNotice(null);
		try {
			const res = await setRemoteWorkflowResourceSets(selected.id, rciDraft);
			if (!res.ok) {
				setCatalogError(res.error);
				return;
			}
			setRciDraft(res.remote_workflow.resource_selections ?? rciDraft);
			setNotice("RCI selection saved and queued for the client.");
			onRefresh();
		} finally {
			setBusy(false);
		}
	}, [selected, rciDraft, onRefresh]);

	const saveContext = useCallback(async () => {
		if (!selected) return;
		setBusy(true);
		setNotice(null);
		try {
			const res = await updateRemoteWorkflowContext(selected.id, contextDraft.trim());
			if (!res.ok) {
				setNotice(res.error);
				return;
			}
			setNotice("Conversation context saved and queued for the client.");
			onRefresh();
		} finally {
			setBusy(false);
		}
	}, [selected, contextDraft, onRefresh]);

	const buildStepPayload = (stepKey: string, form: StepFormState) => {
		const maxRetries = Math.max(0, Number.parseInt(form.maxRetries, 10) || 0);
		const intervalEnabled = maxRetries > 1;
		return {
			step_key: stepKey,
			description: form.description.trim(),
			acceptance_criteria: form.acceptanceCriteria.trim() || undefined,
			manual_review: form.manualReview,
			use_subagent: form.useSubagent,
			max_retries: maxRetries,
			retry_interval_seconds: intervalEnabled
				? Math.max(0, Number.parseInt(form.retryInterval, 10) || 0)
				: 0,
		};
	};

	const onAddStep = useCallback(
		async (e: FormEvent) => {
			e.preventDefault();
			if (!selected || !stepForm.description.trim()) return;
			const stepKey = nextRemoteStepKey(steps.map((s) => s.step_key));
			await runCommand("step.add", buildStepPayload(stepKey, stepForm));
			setStepForm(EMPTY_STEP);
			setAddOpen(false);
		},
		[runCommand, selected, stepForm, steps],
	);

	const onSaveStepEdit = useCallback(
		async (stepKey: string, form: StepFormState) => {
			await runCommand("step.edit", buildStepPayload(stepKey, form));
			setEditingKey(null);
		},
		[runCommand],
	);

	const intervalEnabled = (Number.parseInt(stepForm.maxRetries, 10) || 0) > 1;
	const selectedStepsPendingSync = selected
		? countStepsPendingSync(steps, Boolean(selected.local_id))
		: 0;
	const isRunningOnClient = selected?.status === "running" || selected?.status === "waiting";
	const pendingRunCommand = pendingCommands.some((c) => RUN_LIFECYCLE_COMMANDS.has(c.type));
	const selectedStepsForRun = steps.filter((s) => selectedStepKeys.has(s.step_key));
	const runAction = selected ? computeRunAction(selected.status, selectedStepsForRun) : "start";
	const runLabels = { start: "Start", resume: "Resume", restart: "Restart" } as const;
	const runState = selected
		? describeRunState({
				status: selected.status,
				pendingCommands,
				stepsPendingSync: selectedStepsPendingSync,
				hasLocalId: Boolean(selected.local_id),
			})
		: null;
	const startDisabled =
		busy ||
		!selected?.local_id ||
		selectedStepsPendingSync > 0 ||
		isRunningOnClient ||
		pendingRunCommand ||
		selectedStepKeys.size === 0 ||
		steps.length === 0;
	const agentTitle = !clientId
		? "Pick a client first"
		: installedRunners.length === 0
			? "Waiting for the client to report installed agents (next heartbeat)"
			: "Agent CLI that will run this workflow on the client";
	const clientError = fieldErrors(errors, "client_id")[0]?.message;
	const agentError = fieldErrors(errors, "agent")[0]?.message;
	const nameError = fieldErrors(errors, "name")[0]?.message;
	const templateError = fieldErrors(errors, "template_id")[0]?.message;
	const formError = fieldErrors(errors, "_")[0]?.message;

	return (
		<div className="sync-remote">
			{permissions.create ? (
				<div className="sync-remote-toolbar">
					<button type="button" className="btn btn--on" onClick={() => setCreateOpen(true)}>
						+ New remote workflow
					</button>
				</div>
			) : null}
			<Modal
				open={createOpen && permissions.create}
				title="New remote workflow"
				description="Creates a remote workflow on the chosen client. Its steps then run in order on that machine."
				onClose={() => setCreateOpen(false)}
				footer={
					<>
						<button type="button" className="btn" onClick={() => setCreateOpen(false)} disabled={busy}>
							Cancel
						</button>
						<button
							type="submit"
							form="create-remote-workflow"
							className="btn btn--on"
							disabled={
								busy ||
								activeClients.length === 0 ||
								(installedRunners.length > 0 && !agent)
							}
						>
							Create remote workflow
						</button>
					</>
				}
			>
				<form id="create-remote-workflow" className="sync-create" onSubmit={(e) => void onCreate(e)}>
					<fieldset className="sync-create-group">
						<legend>Where it runs</legend>
						<Field
							label="Client"
							required
							hint="The Target hub that will own this workflow."
							{...(clientError ? { error: clientError } : {})}
						>
							{(props) => (
								<select
									{...props}
									className="select"
									required
									value={clientId}
									onChange={(e) => {
										const nextClientId = e.target.value;
										setClientId(nextClientId);
										const nextClient = activeClients.find((c) => c.id === nextClientId);
										const nextRunners = (nextClient?.capabilities?.runners ?? []).filter((r) => r.installed);
										setAgent(nextRunners[0]?.id ?? "");
									}}
								>
									<option value="">Select client…</option>
									{activeClients.map((c) => (
										<option key={c.id} value={c.id}>
											{c.name || shortId(c.id)}
											{c.availability ? ` · ${c.availability}` : ""}
										</option>
									))}
								</select>
							)}
						</Field>
						<Field
							label="Agent"
							required={installedRunners.length > 0}
							hint={agentTitle}
							{...(agentError ? { error: agentError } : {})}
						>
							{(props) => (
								<select
									{...props}
									className="select"
									required={installedRunners.length > 0}
									disabled={!clientId || installedRunners.length === 0}
									value={agent}
									onChange={(e) => setAgent(e.target.value)}
									title={agentTitle}
								>
									<option value="">
										{!clientId
											? "Agent…"
											: installedRunners.length === 0
												? "No agents reported yet"
												: "Select agent…"}
									</option>
									{installedRunners.map((r) => (
										<option key={r.id} value={r.id}>
											{RUNNER_LABELS[r.id] ?? r.id}
										</option>
									))}
								</select>
							)}
						</Field>
						<p className="hint">
							Remote workflows always run in the <strong>docker</strong> sandbox on the client. The agent list
							comes from the client heartbeat — only installed CLIs are selectable.
						</p>
					</fieldset>
					<fieldset className="sync-create-group">
						<legend>What it does</legend>
						<Field
							label="Name"
							required
							hint="Shown in this list and on the client. Pick something an operator can recognise later."
							{...(nameError ? { error: nameError } : {})}
						>
							{(props) => (
								<input
									{...props}
									className="input"
									required
									placeholder="e.g. release-notes"
									value={name}
									onChange={(e) => setName(e.target.value)}
								/>
							)}
						</Field>
						{permissions.templatesRead ? (
							<Field
								label="Start from template"
								hint="Optional — seeds the workflow with the template's steps and merged TCP/RCI selections."
								{...(templateError ? { error: templateError } : {})}
							>
								{(props) => (
									<select
										{...props}
										className="select"
										value={templateId}
										onChange={(e) => setTemplateId(e.target.value)}
									>
										<option value="">No template — start empty</option>
										{templates.map((template) => (
											<option key={template.id} value={template.id}>
												{template.name} ({template.steps.length} step{template.steps.length === 1 ? "" : "s"})
											</option>
										))}
									</select>
								)}
							</Field>
						) : null}
						<Field
							label="Conversation context"
							hint="Optional. Delivered before every step on the client — same as a Target hub conversation context."
						>
							{(props) => (
								<textarea
									{...props}
									className="input sync-context-input"
									rows={3}
									placeholder="Background that applies to every step of this workflow…"
									value={createContext}
									onChange={(e) => setCreateContext(e.target.value)}
								/>
							)}
						</Field>
					</fieldset>
					{formError ? (
						<p className="msg msg--error" role="alert">
							{formError}
						</p>
					) : null}
				</form>
			</Modal>
			{notice ? <div className="panel-note">{notice}</div> : null}
			{permissions.create && activeClients.length === 0 && clients ? (
				<div className="empty">Register a sync client before creating remote workflows.</div>
			) : null}

			{!workflows ? (
				<div className="empty">Loading remote workflows…</div>
			) : workflows.length === 0 ? (
				<div className="empty">No remote workflows yet.</div>
			) : (
				<table>
					<thead>
						<tr>
							<th>Name</th>
							<th>Client</th>
							<th>Steps</th>
							<th>Agent</th>
							<th>Sandbox</th>
							<th>Status</th>
							<th>Client sync</th>
							<th>Created</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{workflows.map((w) => (
							<tr key={w.id} className={selectedId === w.id ? "sync-row--selected" : ""}>
								<td>{w.name || <span className="badge badge--neutral">unnamed</span>}</td>
								<td className="mono" title={w.client_id}>
									{shortId(w.client_id)}
								</td>
								<td className="mono">{w.step_count ?? 0}</td>
								<td>
									<AgentBadge agent={w.agent} />
								</td>
								<td>
									<SandboxBadge sandbox={w.sandbox ?? "docker"} image={null} />
								</td>
								<td>
									<StatusBadge status={w.status} />
								</td>
								<td>
									<ClientSyncBadge localId={w.local_id} stepsPendingSync={w.steps_pending_sync ?? 0} />
									{w.local_id ? (
										<span className="mono hint sync-local-id" title={w.local_id}>
											{shortId(w.local_id)}
										</span>
									) : null}
								</td>
								<td className="mono">{timeAgo(w.created_at)}</td>
								<td>
									<button type="button" className="btn btn--sm" onClick={() => onSelect(w.id)}>
										Open
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			{selected ? (
				<div className="sync-control sync-control--editor">
					<div className="sync-control-head">
						<h3>{selected.name ?? shortId(selected.id)}</h3>
						<StatusBadge status={selected.status} />
						<ClientSyncBadge localId={selected.local_id} stepsPendingSync={selectedStepsPendingSync} />
						<AgentBadge agent={selected.agent} />
						<SandboxBadge sandbox={selected.sandbox ?? "docker"} image={null} />
						<span className="badge badge--neutral">{steps.length} step{steps.length === 1 ? "" : "s"}</span>
						{selected.local_id ? (
							<span className="mono hint" title={selected.local_id}>
								local {shortId(selected.local_id)}
							</span>
						) : null}
					</div>

					{runState ? (
						<div className={`sync-run-banner sync-run-banner--${runState.tone}`} role="status">
							{runState.message}
							{selectedClient?.availability ? (
								<span className="sync-run-banner__meta">
									Client {selectedClient.name || shortId(selectedClient.id)} · {selectedClient.availability}
								</span>
							) : null}
						</div>
					) : null}

					{steps.length > 0 ? (
						<p className="hint sync-step-run-hint">
							{selectedStepKeys.size} of {steps.length} step{steps.length === 1 ? "" : "s"} selected.
							{runAction === "restart"
								? " Completed steps are re-run with Restart (resets and executes again)."
								: " Start runs pending steps only — same as the Target hub."}
						</p>
					) : null}

					<div className="sync-control-actions">
						{permissions.execute ? (
							<button
								type="button"
								className="btn btn--sm btn--on"
								disabled={startDisabled}
								title={
									selectedStepKeys.size === 0
										? "Select at least one step to run"
										: pendingRunCommand
											? "Run command already queued or in flight"
											: isRunningOnClient
												? "Workflow is already running on the client"
												: runAction === "restart"
													? "Restart resets the selected steps and runs them again"
													: undefined
								}
								onClick={() => void runCommand(`workflow.${runAction}`, runPayload())}
							>
								{pendingRunCommand
									? "Run queued…"
									: isRunningOnClient
										? "Running…"
										: `${runLabels[runAction]}${selectedStepKeys.size > 0 ? ` (${selectedStepKeys.size})` : ""}`}
							</button>
						) : null}
						{permissions.manage ? (
							<button
								type="button"
								className="btn btn--sm"
								disabled={busy || !isRunningOnClient}
								onClick={() => void runCommand("workflow.pause")}
							>
								Pause
							</button>
						) : null}
						{permissions.manage ? (
							<button
								type="button"
								className="btn btn--sm btn--danger"
								disabled={busy || selected.status === "deleting"}
								onClick={() => void onDelete()}
							>
								Delete
							</button>
						) : null}
					</div>

					{permissions.addStep && permissions.templatesRead ? (
						<section className="sync-section">
							<div className="sync-create-row">
								<Field
									label="Append a template's steps"
									hint="Adds every step from a server catalog template. TCP and RCI selections are merged into this workflow."
								>
									{(props) => (
										<select
											{...props}
											className="select"
											value={appendTemplateId}
											onChange={(e) => setAppendTemplateId(e.target.value)}
											disabled={busy}
										>
											<option value="">Select a template…</option>
											{templates.map((template) => (
												<option key={template.id} value={template.id}>
													{template.name} ({template.steps.length} step{template.steps.length === 1 ? "" : "s"})
												</option>
											))}
										</select>
									)}
								</Field>
								<button
									type="button"
									className="btn btn--sm btn--on"
									disabled={busy || !appendTemplateId}
									onClick={() => void onAppendTemplate()}
								>
									Append template
								</button>
							</div>
						</section>
					) : null}

					<section className="sync-section">
						<div className="sync-section-head">
							<h4>TCP</h4>
							{canSaveTcps ? (
								<button
									type="button"
									className="btn btn--sm btn--on"
									disabled={
										busy || sameTcpSelections(tcpDraft, selected.tcp_selections ?? [])
									}
									onClick={() => void onSaveTcps()}
								>
									Save TCP selection
								</button>
							) : null}
						</div>
						<p className="hint">
							Attach server catalog TCP packs. Whole packs or individual tools are pushed to the client.
						</p>
						{permissions.tcpRead ? (
							<TcpSelectionEditor
								tcps={tcps}
								selections={tcpDraft}
								disabled={!canSaveTcps || busy}
								onChange={setTcpDraft}
							/>
						) : (
							<p className="hint">Needs tcp-tools.read to list server TCP packs.</p>
						)}
						{!canSaveTcps && permissions.tcpRead ? (
							<p className="hint">Saving TCP selections needs client.workflows.manage.</p>
						) : null}
					</section>

					<section className="sync-section">
						<div className="sync-section-head">
							<h4>RCI</h4>
							{canSaveRci ? (
								<button
									type="button"
									className="btn btn--sm btn--on"
									disabled={
										busy || sameResourceSelections(rciDraft, selected.resource_selections ?? [])
									}
									onClick={() => void onSaveRci()}
								>
									Save RCI selection
								</button>
							) : null}
						</div>
						<p className="hint">
							Attach server catalog resource sets. Whole sets or individual resources are pushed to the client.
						</p>
						{permissions.rciRead ? (
							<ResourceSelectionEditor
								resourceSets={resourceSets}
								selections={rciDraft}
								disabled={!canSaveRci || busy}
								onChange={setRciDraft}
							/>
						) : (
							<p className="hint">Needs rci.read to list server resource sets.</p>
						)}
						{!canSaveRci && permissions.rciRead ? (
							<p className="hint">Saving RCI selections needs client.workflows.manage.</p>
						) : null}
					</section>

					{catalogError ? <div className="err">{catalogError}</div> : null}

					<section className="sync-section">
						<h4>Conversation context</h4>
						<p className="hint">Delivered before every step — same as Target hub.</p>
						<textarea
							className="input sync-context-input"
							rows={4}
							value={contextDraft || selected.conversation_context || ""}
							onChange={(e) => setContextDraft(e.target.value)}
							placeholder="Background for every step…"
							disabled={!permissions.manage}
							readOnly={!permissions.manage}
						/>
						{permissions.manage ? (
							<button
								type="button"
								className="btn btn--sm btn--on"
								disabled={busy}
								onClick={() => void saveContext()}
							>
								Save context
							</button>
						) : null}
					</section>

					{selected.local_id ? (
						<p className="hint sync-plan-live-hint">
							Live canvas and step status are in <strong>Client activity</strong> below — this panel is
							for editing the plan and sending commands.
						</p>
					) : (
						<>
							<div className="wf-view-switch">
								<button
									type="button"
									className={`btn btn--sm${view === "canvas" ? " btn--on" : ""}`}
									onClick={() => setView("canvas")}
								>
									Canvas
								</button>
								<button
									type="button"
									className={`btn btn--sm${view === "list" ? " btn--on" : ""}`}
									onClick={() => setView("list")}
								>
									List
								</button>
							</div>

							{view === "list" ? (
								<StepCanvas steps={canvasSteps} planMode />
							) : steps.length > 0 || selected.conversation_context ? (
								<WorkflowCanvas steps={canvasSteps} planMode />
							) : (
								<div className="empty">Add steps below to see the workflow plan preview.</div>
							)}
						</>
					)}

					<section className="sync-section">
						<div className="sync-section-head">
							<h4>Steps</h4>
							<div className="sync-section-head-actions">
								{steps.length > 0 && (permissions.execute || permissions.manage) ? (
									<label className="sync-step-select-all">
										<input
											type="checkbox"
											checked={allStepsSelected}
											onChange={() => toggleAllStepKeys()}
										/>
										Run all
									</label>
								) : null}
								{permissions.addStep && !addOpen ? (
									<button type="button" className="btn btn--sm btn--on" onClick={() => setAddOpen(true)}>
										+ Add step
									</button>
								) : null}
							</div>
						</div>

						{permissions.addStep && addOpen ? (
							<StepEditorForm
								form={stepForm}
								setForm={setStepForm}
								intervalEnabled={intervalEnabled}
								busy={busy}
								onSubmit={(e) => void onAddStep(e)}
								onCancel={() => {
									setAddOpen(false);
									setStepForm(EMPTY_STEP);
								}}
								submitLabel="Add step"
							/>
						) : null}

						<ol className="sync-step-plan">
							{steps.map((step, idx) => (
								<li
									key={step.step_key}
									className={`sync-step-plan__item${selectedStepKeys.has(step.step_key) ? " sync-step-plan__item--selected" : ""}`}
								>
									<div className="sync-step-plan__head">
										{permissions.execute || permissions.manage ? (
											<label className="sync-step-run-check" title="Include this step when Start/Resume/Restart runs">
												<input
													type="checkbox"
													checked={selectedStepKeys.has(step.step_key)}
													onChange={() => toggleStepKey(step.step_key)}
												/>
											</label>
										) : null}
										<span className="sync-step-plan__index">{idx + 1}</span>
										<span className="sync-step-plan__title">{step.description}</span>
										<StepClientBadge
											status={step.status}
											workflowOnClient={Boolean(selected.local_id)}
											onClient={step.on_client}
											showRunStatus={!selected.local_id}
										/>
										<div className="sync-step-plan__actions">
											{permissions.manage ? (
												<>
													<button
														type="button"
														className="btn btn--sm"
														disabled={busy || idx === 0}
														onClick={() => void runCommand("step.move", { step_key: step.step_key, to_index: idx - 1 })}
													>
														↑
													</button>
													<button
														type="button"
														className="btn btn--sm"
														disabled={busy || idx >= steps.length - 1}
														onClick={() => void runCommand("step.move", { step_key: step.step_key, to_index: idx + 1 })}
													>
														↓
													</button>
												</>
											) : null}
											{permissions.editStep ? (
												<button
													type="button"
													className="btn btn--sm"
													disabled={busy}
													onClick={() => {
														setEditingKey(editingKey === step.step_key ? null : step.step_key);
														setStepForm({
															description: step.description,
															acceptanceCriteria: step.acceptance_criteria ?? "",
															manualReview: step.manual_review,
															useSubagent: step.use_subagent,
															maxRetries: String(step.max_retries),
															retryInterval: String(step.retry_interval_seconds),
														});
													}}
												>
													{editingKey === step.step_key ? "Close" : "Edit"}
												</button>
											) : null}
											{permissions.manage ? (
												<button
													type="button"
													className="btn btn--sm"
													disabled={busy}
													onClick={() => void runCommand("step.remove", { step_key: step.step_key })}
												>
													Remove
												</button>
											) : null}
										</div>
									</div>
									<div className="sync-step-plan__meta">
										{step.acceptance_criteria?.trim() ? <span className="badge badge--neutral">judged</span> : null}
										{step.manual_review ? <span className="badge badge--neutral">manual review</span> : null}
										{step.use_subagent ? <span className="badge badge--neutral">subagent</span> : null}
										{step.max_retries > 0 ? (
											<span className="badge badge--neutral">{`retries ${step.max_retries}`}</span>
										) : null}
									</div>
									{permissions.editStep && editingKey === step.step_key ? (
										<StepEditorForm
											form={stepForm}
											setForm={setStepForm}
											intervalEnabled={(Number.parseInt(stepForm.maxRetries, 10) || 0) > 1}
											busy={busy}
											onSubmit={(e) => {
												e.preventDefault();
												void onSaveStepEdit(step.step_key, stepForm);
											}}
											onCancel={() => setEditingKey(null)}
											submitLabel="Save step"
										/>
									) : null}
								</li>
							))}
						</ol>
					</section>

					{selected.local_id ? (
						<section className="sync-section sync-reported">
							<div className="sync-section-head">
								<h4>Client activity</h4>
								{reportedDetail ? (
									<button
										type="button"
										className="btn btn--sm btn--ghost"
										onClick={() => onOpenInActivity(selected.local_id!)}
									>
										Open in Activity tab
									</button>
								) : null}
							</div>
							<p className="hint">
								Live run state from the client hub (same feed as Activity when reporting is enabled).
							</p>
							{reportedDetail ? (
								<WorkflowDetail detail={reportedDetail} error={null} onClose={() => {}} embedded />
							) : reportedDetailErr ? (
								<div className="empty">
									No ingest data for this workflow yet — ensure the client reports to this server
									(`TARGET_REPORT_URL`).
								</div>
							) : (
								<div className="empty">Loading client activity…</div>
							)}
						</section>
					) : null}

					{errors.length ? <div className="err">{errors.map((e) => e.message).join(" · ")}</div> : null}

					<h4>Live sync events</h4>
					{!events || events.length === 0 ? (
						<div className="empty">No sync events for this workflow yet.</div>
					) : (
						<ul className="sync-event-feed">
							{events.map((ev) => (
								<li key={ev.id}>
									<span className="mono">{timeAgo(ev.received_at)}</span>
									<span className="badge badge--neutral">{ev.type}</span>
									<span className="sync-event-payload">{formatSyncEventSummary(ev)}</span>
								</li>
							))}
						</ul>
					)}
				</div>
			) : null}
		</div>
	);
}

function StepEditorForm({
	form,
	setForm,
	intervalEnabled,
	busy,
	onSubmit,
	onCancel,
	submitLabel,
}: {
	form: StepFormState;
	setForm: (next: StepFormState) => void;
	intervalEnabled: boolean;
	busy: boolean;
	onSubmit: (e: FormEvent) => void;
	onCancel: () => void;
	submitLabel: string;
}) {
	return (
		<form className="sync-step-form" onSubmit={onSubmit}>
			<Field
				label="Task description"
				required
				hint="What the agent should do in this step."
			>
				{(props) => (
					<textarea
						{...props}
						className="input"
						required
						rows={3}
						value={form.description}
						onChange={(e) => setForm({ ...form, description: e.target.value })}
						placeholder="What the agent should do in this step…"
					/>
				)}
			</Field>
			<Field
				label="Acceptance criteria"
				hint="If set, the agent self-evaluates its result after running and re-runs the step on a reject, up to the retry budget."
			>
				{(props) => (
					<textarea
						{...props}
						className="input"
						rows={2}
						value={form.acceptanceCriteria}
						onChange={(e) => setForm({ ...form, acceptanceCriteria: e.target.value })}
						placeholder="Optional — what a good result must satisfy."
					/>
				)}
			</Field>
			<Field
				label="Manual review"
				hint="The workflow stops after this step and waits for you. No further step runs until you continue it."
			>
				{(props) => (
					<label className="sync-toggle">
						<input
							{...props}
							type="checkbox"
							checked={form.manualReview}
							onChange={(e) => setForm({ ...form, manualReview: e.target.checked })}
						/>
						Stop after this step for a human continue
					</label>
				)}
			</Field>
			<Field
				label="Use subagent"
				hint="On: the agent delegates this step to a subagent, so the shared session only keeps its summary. Off: it solves the step itself."
			>
				{(props) => (
					<label className="sync-toggle">
						<input
							{...props}
							type="checkbox"
							checked={form.useSubagent}
							onChange={(e) => setForm({ ...form, useSubagent: e.target.checked })}
						/>
						Delegate this step to a subagent
					</label>
				)}
			</Field>
			<div className="sync-step-form__grid">
				<Field label="Max retries" hint="How many times the step may re-run after a rejected result.">
					{(props) => (
						<input
							{...props}
							type="number"
							className="input"
							min={0}
							value={form.maxRetries}
							onChange={(e) => setForm({ ...form, maxRetries: e.target.value })}
						/>
					)}
				</Field>
				<Field
					label="Interval (s)"
					hint="Seconds to wait before each re-run after a judge reject. Only editable with more than one retry."
				>
					{(props) => (
						<input
							{...props}
							type="number"
							className="input"
							min={0}
							disabled={!intervalEnabled}
							value={intervalEnabled ? form.retryInterval : "0"}
							onChange={(e) => setForm({ ...form, retryInterval: e.target.value })}
							title="Seconds to wait before each re-run after a judge reject. Only editable with more than one retry."
						/>
					)}
				</Field>
			</div>
			<div className="sync-step-form__actions">
				<button type="submit" className="btn btn--sm btn--on" disabled={busy || !form.description.trim()}>
					{submitLabel}
				</button>
				<button type="button" className="btn btn--sm" disabled={busy} onClick={onCancel}>
					Cancel
				</button>
			</div>
		</form>
	);
}
