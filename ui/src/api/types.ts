/**
 * The shapes `server.mjs` returns, mirrored as types.
 *
 * These are hand-written on purpose: `db.mjs` is plain JS and maps every SQLite
 * row to camelCase itself (see `rowToEvent`, `listInstances`, `stats`,
 * `workflowAggregates`, `workflowDetail`), so this file is the one place that
 * states the contract for the UI. Keep it in sync with those mappers.
 */

/** One activity event as stored and served (§7 of the wire contract). */
export interface EventRow {
	id: string;
	instanceId: string;
	kind: string;
	workflowId: string | null;
	sessionId: string | null;
	version: string | null;
	createdAt: string | null;
	receivedAt: string;
	data: Record<string, unknown>;
}

/** A reporting machine. */
export interface InstanceRow {
	instanceId: string;
	displayName: string | null;
	version: string | null;
	firstSeenAt: string;
	lastSeenAt: string;
	eventsCount: number;
}

/** A reporting user — an instance display name, with its totals. */
export interface UserRow {
	name: string;
	instances: number;
	events: number;
	lastSeenAt: string;
}

export interface CountByKind {
	kind: string;
	count: number;
}

export interface CountByVersion {
	version: string;
	count: number;
}

/** `GET /api/stats` — every number the KPI row and the breakdowns show. */
export interface Stats {
	totalEvents: number;
	totalInstances: number;
	workflows: number;
	failures: number;
	byKind: CountByKind[];
	byVersion: CountByVersion[];
	/** Distinct values ever reported (unfiltered), for the filter dropdowns. */
	agents: string[];
	sandboxes: string[];
	usage: { inputTokens: number; outputTokens: number };
}

/** Run state as the server derives it; anything else degrades to a neutral badge. */
export type WorkflowStatus = "running" | "completed" | "failed" | "cancelled" | "draft" | string;
export type StepStatus = "pending" | "running" | "done" | "failed" | string;

/** One aggregate row per workflow, folded from its event stream. */
export interface WorkflowRow {
	workflowId: string;
	name: string;
	user: string | null;
	instanceId: string | null;
	agent: string | null;
	sandbox: string | null;
	image: string | null;
	firstSeenAt: string;
	lastActivityAt: string;
	stepsAdded: number;
	stepsStarted: number;
	stepsDone: number;
	stepsFailed: number;
	/** Plan size the progress bar divides by (see `workflowAggregates`). */
	stepsTotal: number;
	tokens: { input: number; output: number };
	status: WorkflowStatus;
	/**
	 * Whether this row's shape came from a `workflow.plan` snapshot. Without one
	 * the server is folding lifecycle events, which cannot describe steps that
	 * never ran — so the canvas would be drawing a guess, and says so instead.
	 */
	hasPlan?: boolean;
}

/**
 * One step, from the `workflow.plan` snapshot where there is one, falling back
 * to a fold of `step.added` + the lifecycle events.
 *
 * The fields below `hasAcceptanceCriteria` are what the canvas lays out from —
 * they are only fully populated from a snapshot. `WorkflowStep` structurally
 * satisfies `CanvasStep` (see lib/canvasLayout.ts), which is what lets the
 * server reuse the hub's geometry verbatim instead of approximating it.
 */
export interface WorkflowStep {
	stepId: string;
	orderIndex: number | null;
	description: string | null;
	status: StepStatus;
	statusAt: string | null;
	durationMs: number | null;
	retryCount: number | null;
	startedAt: string | null;
	finishedAt: string | null;
	judged: "pass" | "fail" | null;
	manualReview: boolean;
	hasAcceptanceCriteria: boolean;
	/** "context" for the hub-owned context step, "task" for everything else. */
	kind?: "context" | "task";
	/** Which job a `running` step is on — "judge" is what turns the circle on. */
	phase?: "exec" | "judge";
	acceptanceCriteria?: string | null;
	useSubagent?: boolean;
	manualRun?: boolean;
	maxRetries?: number | null;
	selected?: boolean;
	/** Sticky notes reconstructed from step.note.* events. */
	notes?: StepNote[];
}

export type StepNoteTheme = "warning" | "success" | "neutral";

export interface StepNote {
	id: string;
	theme: StepNoteTheme;
	content: string;
	updatedAt?: string | null;
}

/**
 * One session's `usage.snapshot`, normalised by the server
 * (`normalizeUsageSnapshot` in db.mjs). `inputTokens` is the FULL input —
 * uncached + cache creation + cache read — which is the number the operator's
 * client prints as "in"; the bare uncached field is kept as
 * `inputTokensUncached` for anyone who wants the breakdown.
 *
 * The context/model fields are only populated by hubs new enough to send them;
 * older snapshots report zeros there and the meter says so.
 */
export interface UsageSession {
	sessionId: string | null;
	receivedAt: string;
	inputTokens: number;
	outputTokens: number;
	inputTokensUncached: number;
	cacheCreation: number;
	cacheRead: number;
	contextTokens: number;
	contextWindow: number;
	contextPct: number;
	model: string | null;
	turns: number;
	includesSubagents: boolean;
	compacted: boolean;
	costUsd: number | null;
}

/** A workflow's spend: the latest snapshot per session, plus their totals. */
export interface WorkflowUsage {
	inputTokens: number;
	outputTokens: number;
	sessions: UsageSession[];
}

/** `GET /api/workflows/:id`. */
export interface WorkflowDetailResponse {
	workflow: WorkflowRow;
	steps: WorkflowStep[];
	/** Optional only for servers older than the usage readout. */
	usage?: WorkflowUsage;
	events: EventRow[];
}

export interface InstancesResponse {
	instances: InstanceRow[];
}
export interface UsersResponse {
	users: UserRow[];
}
export interface EventsResponse {
	events: EventRow[];
}
/**
 * `GET /api/workflows?limit=&offset=` — ONE PAGE of the list plus the unpaged
 * match count the pager reads "of N" from.
 */
export interface WorkflowsResponse {
	workflows: WorkflowRow[];
	total: number;
	limit: number;
	offset: number;
}

/** `GET /api/workflows/names` — every match, id+name only, for the dropdown. */
export interface WorkflowNamesResponse {
	workflows: Pick<WorkflowRow, "workflowId" | "name">[];
}

/** The dashboard filter state, mapped 1:1 onto the API's query params. */
export type RangeId = "all" | "1h" | "24h" | "7d" | "30d" | "custom";

export interface Filters {
	range: RangeId;
	/** `datetime-local` values (local time), only used when `range === "custom"`. */
	from: string;
	to: string;
	user: string;
	instance: string;
	workflow: string;
	kind: string;
	agent: string;
	sandbox: string;
}

export const EMPTY_FILTERS: Filters = {
	range: "all",
	from: "",
	to: "",
	user: "",
	instance: "",
	workflow: "",
	kind: "",
	agent: "",
	sandbox: "",
};

/** Human account (dashboard operator), from /api/auth/*. */
export interface AuthUser {
	id: string;
	email: string;
	role: string;
	permissions: string[];
	createdAt: string;
	lastLoginAt: string | null;
	status: "pending" | "active";
	usesDefaultPassword?: boolean;
	inviteAllowPassword?: boolean;
	inviteAllowGoogle?: boolean;
}

export type PermissionScope = "server" | "client";

export interface PermissionCatalogEntry {
	id: string;
	label: string;
	description: string;
}

export interface PermissionCatalogGroup {
	id: string;
	scope: PermissionScope;
	label: string;
	description: string;
	permissions: PermissionCatalogEntry[];
}

/** Closed RBAC vocabulary from GET /api/auth/me — presentation only, not authorization. */
export interface PermissionCatalog {
	groups: PermissionCatalogGroup[];
}

export interface AuthSession {
	user: AuthUser;
	catalog: PermissionCatalog;
}

export interface AuthRole {
	id: string;
	name: string;
	isSystem: boolean;
	permissions: string[];
	userCount: number;
	createdAt: string;
	updatedAt: string;
}

export type InviteActivation = {
	password: boolean;
	google: boolean;
};

export type InviteLinks = {
	url?: string;
	setupUrl?: string;
	loginUrl?: string;
	expiresAt?: string;
};

export interface FieldError {
	field: string;
	code: string;
	message: string;
}

/** Sync client registered for remote control (`GET /api/sync/clients`). */
export interface SyncClientRow {
	id: string;
	name: string | null;
	status: string;
	availability: "idle" | "busy" | null;
	capabilities: {
		commands: string[];
		version: string | null;
		instance_id: string | null;
		runners?: { id: string; installed: boolean }[];
		resources?: {
			version: number;
			templates: boolean;
			tcp_tools: boolean;
			resource_sets: boolean;
		} | null;
	} | null;
	last_seen_at: string | null;
	created_at: string;
}

export interface SyncClientsResponse {
	clients: SyncClientRow[];
}

/** Safe dashboard projection of a linked hub; credentials and keys never appear here. */
export interface LinkedDevice {
	id: string;
	ownerUserId: string;
	name: string;
	hubVersion: string | null;
	scopes: string[];
	status: "active" | "rotating" | "revoked";
	/** Reachability derived server-side from last use and the configured TTL. */
	operationalStatus: "online" | "offline" | "revoked";
	credentialVersion: number;
	createdAt: string;
	updatedAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
	revocationReason: string | null;
}

export interface LinkedDevicesResponse {
	devices: LinkedDevice[];
}

/** Server-managed workflow on a client machine. */
export interface SyncRemoteWorkflowRow {
	id: string;
	client_id: string;
	name: string | null;
	status: string | null;
	local_id: string | null;
	sandbox: string | null;
	agent: string | null;
	conversation_context: string | null;
	step_count: number;
	steps_pending_sync: number;
	tcp_selections?: TcpSelection[];
	resource_selections?: ResourceSelection[];
	created_at: string;
}

/** Planned step mirrored on the server (operator view). */
export interface SyncRemoteStepRow {
	step_key: string;
	order_index: number;
	description: string;
	acceptance_criteria: string | null;
	manual_review: boolean;
	use_subagent: boolean;
	max_retries: number;
	retry_interval_seconds: number;
	status: string;
	on_client: boolean;
	run_selected: boolean;
}

export interface SyncCommand {
	id: string;
	type: string;
	remote_id: string | null;
	sequence: number;
	payload: Record<string, unknown>;
	status: string;
	created_at: string;
}

export interface SyncRemoteWorkflowDetailResponse {
	remote_workflow: SyncRemoteWorkflowRow;
	steps: SyncRemoteStepRow[];
	pending_commands: SyncCommand[];
}

export interface SyncRemoteWorkflowsResponse {
	remote_workflows: SyncRemoteWorkflowRow[];
}

export interface SyncCreateRemoteWorkflowResponse {
	remote_workflow: SyncRemoteWorkflowRow;
	command: SyncCommand;
}

export interface SyncEventRow {
	id: string;
	client_id: string;
	remote_id: string | null;
	type: string;
	payload: Record<string, unknown>;
	received_at: string;
}

export interface SyncEventsResponse {
	events: SyncEventRow[];
}

export type RemoteResourceDomain = "templates" | "tcp-tools" | "resource-sets";

export interface RemoteResource {
	clientId: string;
	domain: "templates" | "tcp_tools" | "resource_sets";
	id: string;
	name: string;
	data: Record<string, unknown>;
	revision: number;
	updatedAt: string;
}

export interface RemoteResourcesResponse {
	contract_version: "sync/v2";
	resources: RemoteResource[];
}

export interface RemoteResourceActions {
	create: boolean;
	edit: boolean;
	delete: boolean;
	import: boolean;
	export: boolean;
}

export interface RemoteResourceBundle {
	contract_version?: "sync/v2";
	domain?: "templates" | "tcp_tools" | "resource_sets";
	resources: Array<{ id: string; name: string; data?: Record<string, unknown> }>;
}

/** Server-owned catalog (Agent Resources tab) — same shapes as the hub, stored on this server. */
export interface TemplateStepNote {
	id: string;
	content: string;
	theme: StepNoteTheme;
}

export interface TemplateStep {
	description: string;
	acceptanceCriteria: string | null;
	manualReview: boolean;
	useSubagent: boolean;
	maxRetries: number;
	retryIntervalSeconds: number;
	notes?: TemplateStepNote[];
}

export interface TcpSelection {
	tcpId: string;
	toolNames?: string[] | null;
}

export interface ResourceSelection {
	resourceSetId: string;
	resourceNames?: string[] | null;
}

export interface Template {
	id: string;
	name: string;
	tags: string[];
	steps: TemplateStep[];
	tcpIds: string[];
	tcpSelections: TcpSelection[];
	resourceSelections: ResourceSelection[];
	createdAt: string;
	updatedAt: string;
}

export interface TemplateInput {
	name: string;
	tags: string[];
	steps: TemplateStep[];
	tcpIds?: string[];
	tcpSelections?: TcpSelection[];
	resourceSelections?: ResourceSelection[];
}

export interface TemplatesResponse {
	templates: Template[];
}

export interface TemplateResponse {
	template: Template;
}

export interface TcpToolInput {
	name: string;
	placeholder: string;
	description: string;
	required?: boolean;
}

export interface TcpTool {
	name: string;
	description: string;
	requestTemplate: string;
	inputs: TcpToolInput[];
	tokens: Record<string, string>;
}

export interface Tcp {
	id: string;
	name: string;
	tags: string[];
	tools: TcpTool[];
	createdAt: string;
	updatedAt: string;
}

export interface TcpInput {
	name: string;
	tags: string[];
	tools: TcpTool[];
}

export interface TcpsResponse {
	tcps: Tcp[];
}

export interface TcpResponse {
	tcp: Tcp;
}

export type ResourceKind = "skill" | "agent" | "doc";

export interface ResourceFile {
	path: string;
	content: string;
}

export interface Resource {
	name: string;
	description: string;
	kind: ResourceKind;
	entryFile: string;
	content: string;
	files: ResourceFile[];
}

export interface ResourceSet {
	id: string;
	name: string;
	tags: string[];
	resources: Resource[];
	createdAt: string;
	updatedAt: string;
}

export interface ResourceSetInput {
	name: string;
	tags: string[];
	resources: Resource[];
}

export interface ResourceSetsResponse {
	resourceSets: ResourceSet[];
}

export interface ResourceSetResponse {
	resourceSet: ResourceSet;
}

export interface CatalogActions {
	read: boolean;
	create: boolean;
	edit: boolean;
	delete: boolean;
	import: boolean;
	export: boolean;
}
