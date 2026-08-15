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
}

/** `GET /api/workflows/:id`. */
export interface WorkflowDetailResponse {
	workflow: WorkflowRow;
	steps: WorkflowStep[];
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
export interface WorkflowsResponse {
	workflows: WorkflowRow[];
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
