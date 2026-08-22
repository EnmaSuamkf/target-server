/**
 * Storage for the Target report server (node:sqlite, zero external deps — same
 * approach as the Target hub itself).
 *
 * Two tables:
 *  - `instances`: one row per reporting Target instance (identity + version +
 *    first/last seen), upserted on every batch.
 *  - `events`: one row per activity event. `id` is the event's own uuid and the
 *    PRIMARY KEY, so `INSERT OR IGNORE` gives us idempotent ingest for free — a
 *    re-sent batch (same ids) inserts nothing new but is still acknowledged, per
 *    the contract in docs/report-server.es.html §7.4.
 */
import { DatabaseSync } from "node:sqlite";

let db = null;

export function open(dbPath = process.env.TARGET_SERVER_DB ?? "./target-server.db") {
	if (db) return db;
	db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS instances (
			instance_id   TEXT PRIMARY KEY,
			display_name  TEXT,
			version       TEXT,
			first_seen_at TEXT NOT NULL,
			last_seen_at  TEXT NOT NULL,
			events_count  INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS events (
			id           TEXT PRIMARY KEY,
			instance_id  TEXT NOT NULL,
			kind         TEXT NOT NULL,
			workflow_id  TEXT,
			session_id   TEXT,
			version      TEXT,
			created_at   TEXT,
			received_at  TEXT NOT NULL,
			data         TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);
		CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
		CREATE INDEX IF NOT EXISTS idx_events_instance ON events(instance_id);
		CREATE INDEX IF NOT EXISTS idx_events_workflow ON events(workflow_id);
	`);
	return db;
}

/** Upsert the instance identity carried by a batch envelope. */
export function upsertInstance(batch, nowIso) {
	open()
		.prepare(
			`INSERT INTO instances (instance_id, display_name, version, first_seen_at, last_seen_at, events_count)
			 VALUES (?, ?, ?, ?, ?, 0)
			 ON CONFLICT(instance_id) DO UPDATE SET
			   display_name = COALESCE(excluded.display_name, instances.display_name),
			   version      = COALESCE(excluded.version, instances.version),
			   last_seen_at = excluded.last_seen_at`,
		)
		.run(
			batch.instance_id,
			batch.user?.display_name ?? null,
			batch.version ?? null,
			nowIso,
			nowIso,
		);
}

/**
 * Insert one event idempotently. Returns "inserted" | "duplicate" | "rejected".
 * A missing id is the only hard reject (we can't dedupe it); everything else is
 * stored as-is.
 */
export function insertEvent(instanceId, version, event, nowIso) {
	if (!event || typeof event.id !== "string" || typeof event.kind !== "string") return "rejected";
	const info = open()
		.prepare(
			`INSERT OR IGNORE INTO events (id, instance_id, kind, workflow_id, session_id, version, created_at, received_at, data)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			event.id,
			instanceId,
			event.kind,
			event.workflow_id ?? null,
			event.session_id ?? null,
			version ?? null,
			typeof event.created_at === "string" ? event.created_at : null,
			nowIso,
			JSON.stringify(event.data ?? {}),
		);
	return info.changes > 0 ? "inserted" : "duplicate";
}

/** Bump an instance's stored event counter by however many rows we actually added. */
export function bumpInstanceCount(instanceId, added) {
	if (added <= 0) return;
	open().prepare("UPDATE instances SET events_count = events_count + ? WHERE instance_id = ?").run(added, instanceId);
}

// --- Read side, for the dashboard API -------------------------------------

/**
 * Shared WHERE builder for the dashboard filters. `user` is the instance's
 * display name (what the operator recognises); it resolves to every instance
 * carrying that name, so two machines reporting as the same user filter
 * together. `from`/`to` bound `received_at` (ISO strings compare lexically).
 */
function eventFilterWhere({ kind = null, instanceId = null, workflowId = null, user = null, agent = null, sandbox = null, from = null, to = null } = {}) {
	const clauses = [];
	const params = [];
	if (kind) {
		clauses.push("kind = ?");
		params.push(kind);
	}
	if (instanceId) {
		clauses.push("instance_id = ?");
		params.push(instanceId);
	}
	if (workflowId) {
		clauses.push("workflow_id = ?");
		params.push(workflowId);
	}
	// Agent/sandbox live inside workflow-scoped event payloads (workflow.created/
	// workflow.updated), not in columns — so filtering by them means "events of
	// the workflows that reported this value". Instance-level events (heartbeat)
	// have no workflow and drop out, which is correct: they belong to no agent.
	if (agent) {
		clauses.push("workflow_id IN (SELECT workflow_id FROM events WHERE json_extract(data, '$.agent') = ?)");
		params.push(agent);
	}
	if (sandbox) {
		clauses.push("workflow_id IN (SELECT workflow_id FROM events WHERE json_extract(data, '$.sandbox') = ?)");
		params.push(sandbox);
	}
	if (user) {
		clauses.push("instance_id IN (SELECT instance_id FROM instances WHERE COALESCE(display_name, '') = ?)");
		params.push(user);
	}
	if (from) {
		clauses.push("received_at >= ?");
		params.push(from);
	}
	if (to) {
		clauses.push("received_at <= ?");
		params.push(to);
	}
	return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** The distinct reporting users (instance display names) for the filter dropdown. */
export function listUsers() {
	return open()
		.prepare(
			`SELECT COALESCE(NULLIF(display_name, ''), 'anonymous') AS name,
			        COUNT(*) AS instances,
			        SUM(events_count) AS events,
			        MAX(last_seen_at) AS last_seen_at
			 FROM instances GROUP BY name ORDER BY events DESC`,
		)
		.all()
		.map((r) => ({ name: r.name, instances: r.instances, events: r.events ?? 0, lastSeenAt: r.last_seen_at }));
}

export function listInstances() {
	return open()
		.prepare("SELECT * FROM instances ORDER BY last_seen_at DESC")
		.all()
		.map((r) => ({
			instanceId: r.instance_id,
			displayName: r.display_name,
			version: r.version,
			firstSeenAt: r.first_seen_at,
			lastSeenAt: r.last_seen_at,
			eventsCount: r.events_count,
		}));
}

export function recentEvents({ limit = 100, kind = null, instanceId = null, workflowId = null, user = null, agent = null, sandbox = null, from = null, to = null } = {}) {
	const { where, params } = eventFilterWhere({ kind, instanceId, workflowId, user, agent, sandbox, from, to });
	const rows = open()
		.prepare(`SELECT * FROM events ${where} ORDER BY received_at DESC, rowid DESC LIMIT ?`)
		.all(...params, Math.min(Math.max(1, limit), 1000));
	return rows.map(rowToEvent);
}

function rowToEvent(r) {
	let data = {};
	try {
		data = JSON.parse(r.data ?? "{}");
	} catch {
		data = { _unparsed: r.data };
	}
	return {
		id: r.id,
		instanceId: r.instance_id,
		kind: r.kind,
		workflowId: r.workflow_id,
		sessionId: r.session_id,
		version: r.version,
		createdAt: r.created_at,
		receivedAt: r.received_at,
		data,
	};
}

/**
 * Aggregate stats, honouring the same dashboard filters as recentEvents.
 * Event-derived numbers (totals, workflows, failures, byKind, usage) carry the
 * filters; instance-derived numbers (fleet size, versions) honour only the
 * user/instance side of them, which is what an operator narrowing to "Ada on
 * machine X last week" expects the fleet panels to answer.
 */
export function stats({ kind = null, instanceId = null, workflowId = null, user = null, agent = null, sandbox = null, from = null, to = null } = {}) {
	const d = open();
	const ev = eventFilterWhere({ kind, instanceId, workflowId, user, agent, sandbox, from, to });
	const and = (extra) => (ev.where ? `${ev.where} AND ${extra}` : `WHERE ${extra}`);

	const totalEvents = d.prepare(`SELECT COUNT(*) AS n FROM events ${ev.where}`).get(...ev.params).n;

	// Instances: filtered by the identity filters only (a date range must not
	// shrink the fleet list itself).
	const instClauses = [];
	const instParams = [];
	if (instanceId) {
		instClauses.push("instance_id = ?");
		instParams.push(instanceId);
	}
	if (user) {
		instClauses.push("COALESCE(display_name, '') = ?");
		instParams.push(user);
	}
	const instWhere = instClauses.length ? `WHERE ${instClauses.join(" AND ")}` : "";
	const totalInstances = d.prepare(`SELECT COUNT(*) AS n FROM instances ${instWhere}`).get(...instParams).n;

	const workflows = d
		.prepare(`SELECT COUNT(DISTINCT workflow_id) AS n FROM events ${and("workflow_id IS NOT NULL")}`)
		.get(...ev.params).n;
	// Steps that are failed NOW, not every failure ever recorded. A step that
	// failed and was then re-run successfully is not a standing failure, but
	// counting `step.failed` rows made it one permanently — the dashboard kept
	// reporting a failure for a workflow whose every step had since passed.
	// So: per step, keep only its latest lifecycle event, then count the failures.
	// A lifecycle event with no `step_id` can't be grouped with its siblings, so
	// it partitions by its own event id — it is its own one-event step, which
	// keeps the old counting for anything that doesn't identify its step.
	const failures = d
		.prepare(
			`SELECT COUNT(*) AS n FROM (
			   SELECT kind AS final_kind,
			          ROW_NUMBER() OVER (
			            PARTITION BY workflow_id, COALESCE(json_extract(data, '$.step_id'), id)
			            ORDER BY received_at DESC, rowid DESC
			          ) AS rn
			   FROM events
			   ${and("kind IN ('step.added','step.started','step.waiting','step.done','step.failed')")}
			 ) WHERE rn = 1 AND final_kind = 'step.failed'`,
		)
		.get(...ev.params).n;
	const byKind = d
		.prepare(`SELECT kind, COUNT(*) AS n FROM events ${ev.where} GROUP BY kind ORDER BY n DESC`)
		.all(...ev.params)
		.map((r) => ({ kind: r.kind, count: r.n }));
	const byVersion = d
		.prepare(`SELECT version, COUNT(*) AS n FROM instances ${instWhere} GROUP BY version ORDER BY n DESC`)
		.all(...instParams)
		.map((r) => ({ version: r.version ?? "unknown", count: r.n }));
	// The distinct agents/sandboxes ever reported, for the filter dropdowns.
	// Deliberately UNFILTERED: the options must stay put while one of them is
	// selected (same trick the UI pulls with an unfiltered /api/stats for kinds).
	const agents = d
		.prepare(`SELECT DISTINCT json_extract(data, '$.agent') AS a FROM events WHERE json_extract(data, '$.agent') IS NOT NULL ORDER BY a`)
		.all()
		.map((r) => r.a);
	const sandboxes = d
		.prepare(`SELECT DISTINCT json_extract(data, '$.sandbox') AS s FROM events WHERE json_extract(data, '$.sandbox') IS NOT NULL ORDER BY s`)
		.all()
		.map((r) => r.s);
	// Last snapshot per session, summed — see `latestUsageTotals` for why summing
	// the snapshots themselves multiplies the real spend.
	const usage = latestUsageTotals(and("kind = 'usage.snapshot'"), ev.params);
	return {
		totalEvents,
		totalInstances,
		workflows,
		failures,
		byKind,
		byVersion,
		agents,
		sandboxes,
		usage: { inputTokens: usage.input, outputTokens: usage.output },
	};
}

// --- Workflow aggregation (the workflow-centric dashboard views) ------------
//
// The hub reports a workflow two ways, and the difference matters:
//
//  - as a STREAM of events (§7): workflow.created opens it, step.added records
//    the plan, step.started/done/failed/judged track execution. The stream is
//    the TIMELINE — durations, token attribution, what happened when. It cannot
//    be trusted to describe the present, because a single dropped event leaves
//    its last word standing forever (a finished step stuck reading `running`),
//    and edits/removals/reorders were never in the stream at all.
//
//  - as a `workflow.plan` SNAPSHOT: the whole step list, with every field the
//    operator's canvas lays out from, re-sent whenever the plan changes. This
//    is the PRESENT, and it self-heals — a lost event is corrected by the next
//    snapshot rather than living forever.
//
// So: the snapshot wins wherever it exists, and the stream fold below stays as
// the fallback for a hub too old to send one.

/**
 * The newest `workflow.plan` per workflow id. Rows come oldest-first so the
 * last write per workflow IS the latest; a snapshot that won't parse is simply
 * not a snapshot, and that workflow falls back to the event fold.
 */
function latestPlans(workflowIds) {
	if (workflowIds.length === 0) return new Map();
	const rows = open()
		.prepare(
			`SELECT workflow_id AS wf, data, received_at AS at
			 FROM events
			 WHERE kind = 'workflow.plan' AND workflow_id IN (${workflowIds.map(() => "?").join(",")})
			 ORDER BY received_at ASC, rowid ASC`,
		)
		.all(...workflowIds);
	const out = new Map();
	for (const r of rows) {
		try {
			const data = JSON.parse(r.data ?? "{}");
			if (Array.isArray(data.steps)) out.set(r.wf, { ...data, receivedAt: r.at });
		} catch {
			// Unparseable snapshot: leave whatever earlier one we had.
		}
	}
	return out;
}

/** A plan's task steps — the context step is real, but it is not one of the N. */
function planTaskSteps(plan) {
	return plan ? plan.steps.filter((s) => s && s.kind !== "context") : null;
}

/**
 * A `usage.snapshot` payload, read the way the operator's own client reads it.
 *
 * The hub used to report only the bare `input_tokens` field, which counts the
 * UNCACHED input alone. With prompt caching on that is a rounding error: one
 * real session reported 416 there against 16,015,192 tokens actually sent, and
 * this dashboard's INPUT TOKENS tile duly said 416 where the client said
 * "in 16.0M". Newer hubs send the full total under `input_tokens` and keep the
 * parts beside it (`input_tokens_uncached` / `cache_creation` / `cache_read`),
 * plus the context window, the model and the turn count the client prints.
 *
 * The old rows already carry `cache_read` and `cache_creation`, so history is
 * correctable on READ — no migration, and nothing a client once sent is
 * rewritten:
 *
 *   old shape → input_tokens + cache_creation + cache_read
 *   new shape → input_tokens, untouched (re-adding the parts would count
 *               ~16M of it twice)
 *
 * A payload is new-shape when it carries a field only the new hub sends:
 * `input_tokens_uncached` or `context_window`.
 */
export function isNewUsageShape(data) {
	return !!data && (data.input_tokens_uncached != null || data.context_window != null);
}

/** One `usage.snapshot` payload → the camelCase shape the dashboard reads. */
export function normalizeUsageSnapshot(data) {
	const d = data ?? {};
	const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	const isNew = isNewUsageShape(d);
	const cacheCreation = num(d.cache_creation);
	const cacheRead = num(d.cache_read);
	const uncached = isNew ? num(d.input_tokens_uncached) : num(d.input_tokens);
	const inputTokens = isNew ? num(d.input_tokens) : uncached + cacheCreation + cacheRead;
	const contextTokens = num(d.context_tokens);
	const contextWindow = num(d.context_window);
	return {
		inputTokens,
		outputTokens: num(d.output_tokens),
		inputTokensUncached: uncached,
		cacheCreation,
		cacheRead,
		contextTokens,
		contextWindow,
		contextPct:
			typeof d.context_pct === "number" ? d.context_pct : contextWindow > 0 ? (100 * contextTokens) / contextWindow : 0,
		model: typeof d.model === "string" ? d.model : null,
		turns: num(d.turns),
		includesSubagents: d.includes_subagents === true,
		compacted: d.compacted === true,
		costUsd: typeof d.cost_usd === "number" ? d.cost_usd : null,
	};
}

/**
 * `normalizeUsageSnapshot`'s input rule as a SQL expression, so the aggregate
 * sums below correct history in the same place SQLite is already summing it.
 * Kept beside the JS version on purpose — `test/usage.test.mjs` asserts the two
 * agree on the same fixtures, which is what stops them drifting apart.
 */
const INPUT_TOKENS_SQL = `CASE
			            WHEN json_extract(data, '$.input_tokens_uncached') IS NOT NULL
			              OR json_extract(data, '$.context_window') IS NOT NULL
			            THEN COALESCE(json_extract(data, '$.input_tokens'), 0)
			            ELSE COALESCE(json_extract(data, '$.input_tokens'), 0)
			               + COALESCE(json_extract(data, '$.cache_creation'), 0)
			               + COALESCE(json_extract(data, '$.cache_read'), 0)
			          END`;

/**
 * Token totals, counted correctly.
 *
 * A `usage.snapshot` carries the RUNNING TOTAL of its Claude session, not that
 * step's own spend — the hub re-reads the whole transcript each time. Summing
 * the snapshots therefore counts every earlier turn again on every step: a
 * three-step workflow reporting 1600 → 1872 → 1932 was displayed as 5404 when
 * it had actually spent 1932, and the error grows with every step.
 *
 * The right total is the LAST snapshot per session, summed across sessions —
 * sessions are genuinely separate spends, snapshots within one are not.
 *
 * `extraWhere`/`params` scope it to whatever the caller is totalling (one
 * workflow, or a filtered dashboard).
 */
function latestUsageTotals(extraWhere, params) {
	const row = open()
		.prepare(
			`SELECT COALESCE(SUM(t.input), 0) AS input, COALESCE(SUM(t.output), 0) AS output
			 FROM (
			   SELECT ${INPUT_TOKENS_SQL} AS input,
			          COALESCE(json_extract(data, '$.output_tokens'), 0) AS output,
			          ROW_NUMBER() OVER (
			            PARTITION BY workflow_id, COALESCE(session_id, '')
			            ORDER BY received_at DESC, rowid DESC
			          ) AS rn
			   FROM events
			   ${extraWhere}
			 ) t
			 WHERE t.rn = 1`,
		)
		.get(...params);
	return { input: row?.input ?? 0, output: row?.output ?? 0 };
}

/**
 * One workflow's usage, per session, the way the client states it.
 *
 * Same counting rule as `latestUsageTotals` — the LAST snapshot of each session
 * — but it keeps the snapshots whole instead of summing them down to two
 * numbers, because the context meter, the turn count and the model belong to a
 * session and cannot be added up across several. Newest session first.
 */
export function workflowUsage(workflowId) {
	const rows = open()
		.prepare(
			`SELECT t.session_id AS sessionId, t.data AS data, t.received_at AS receivedAt
			 FROM (
			   SELECT session_id, data, received_at,
			          ROW_NUMBER() OVER (
			            PARTITION BY COALESCE(session_id, '')
			            ORDER BY received_at DESC, rowid DESC
			          ) AS rn
			   FROM events
			   WHERE kind = 'usage.snapshot' AND workflow_id = ?
			 ) t
			 WHERE t.rn = 1
			 ORDER BY t.received_at DESC`,
		)
		.all(workflowId);
	const sessions = rows.map((r) => {
		let data = {};
		try {
			data = JSON.parse(r.data ?? "{}");
		} catch {
			data = {};
		}
		return { sessionId: r.sessionId ?? null, receivedAt: r.receivedAt, ...normalizeUsageSnapshot(data) };
	});
	return {
		inputTokens: sessions.reduce((n, s) => n + s.inputTokens, 0),
		outputTokens: sessions.reduce((n, s) => n + s.outputTokens, 0),
		sessions,
	};
}

/** Per-workflow token totals, same counting rule as `latestUsageTotals`. */
function usageByWorkflow(workflowIds) {
	if (workflowIds.length === 0) return new Map();
	const rows = open()
		.prepare(
			`SELECT t.workflow_id AS wf,
			        COALESCE(SUM(t.input), 0)  AS input,
			        COALESCE(SUM(t.output), 0) AS output
			 FROM (
			   SELECT workflow_id,
			          ${INPUT_TOKENS_SQL} AS input,
			          COALESCE(json_extract(data, '$.output_tokens'), 0) AS output,
			          ROW_NUMBER() OVER (
			            PARTITION BY workflow_id, COALESCE(session_id, '')
			            ORDER BY received_at DESC, rowid DESC
			          ) AS rn
			   FROM events
			   WHERE kind = 'usage.snapshot'
			     AND workflow_id IN (${workflowIds.map(() => "?").join(",")})
			 ) t
			 WHERE t.rn = 1
			 GROUP BY t.workflow_id`,
		)
		.all(...workflowIds);
	return new Map(rows.map((r) => [r.wf, { input: r.input, output: r.output }]));
}

/**
 * One aggregate row per workflow_id over the events matching the identity/date
 * filters. Counts, first/last activity and token sums honour those filters —
 * they answer "what happened in this range". The name, the owning instance
 * and the derived status resolve from the workflow's FULL history instead, so
 * narrowing the range can never blank a workflow's identity or misread a run
 * that started before it.
 */
function workflowAggregates({ instanceId = null, user = null, agent = null, sandbox = null, from = null, to = null, workflowId = null } = {}) {
	const d = open();
	const ev = eventFilterWhere({ instanceId, user, agent, sandbox, from, to, workflowId });
	const and = (extra) => (ev.where ? `${ev.where} AND ${extra}` : `WHERE ${extra}`);
	const rows = d
		.prepare(
			`SELECT e.workflow_id AS workflowId,
			        MIN(e.received_at) AS firstSeenAt,
			        MAX(e.received_at) AS lastActivityAt,
			        SUM(e.kind = 'step.added')   AS stepsAdded,
			        SUM(e.kind = 'step.started') AS stepsStarted,
			        SUM(e.kind = 'step.done')    AS stepsDone,
			        SUM(e.kind = 'step.failed')  AS stepsFailed,
			        MAX(CASE WHEN e.kind LIKE 'step.%' THEN CAST(json_extract(e.data, '$.order_index') AS INTEGER) END) AS maxOrder,
			        (SELECT json_extract(c.data, '$.name') FROM events c
			          WHERE c.workflow_id = e.workflow_id AND c.kind IN ('workflow.created', 'workflow.updated')
			            AND json_extract(c.data, '$.name') IS NOT NULL
			          ORDER BY c.received_at DESC, c.rowid DESC LIMIT 1) AS name,
			        (SELECT json_extract(a.data, '$.agent') FROM events a
			          WHERE a.workflow_id = e.workflow_id AND json_extract(a.data, '$.agent') IS NOT NULL
			          ORDER BY a.received_at DESC, a.rowid DESC LIMIT 1) AS agent,
			        (SELECT json_extract(b.data, '$.sandbox') FROM events b
			          WHERE b.workflow_id = e.workflow_id AND json_extract(b.data, '$.sandbox') IS NOT NULL
			          ORDER BY b.received_at DESC, b.rowid DESC LIMIT 1) AS sandbox,
			        (SELECT json_extract(i.data, '$.image') FROM events i
			          WHERE i.workflow_id = e.workflow_id AND json_extract(i.data, '$.image') IS NOT NULL
			          ORDER BY i.received_at DESC, i.rowid DESC LIMIT 1) AS image,
			        (SELECT json_extract(s.data, '$.to') FROM events s
			          WHERE s.workflow_id = e.workflow_id AND s.kind = 'workflow.status_changed'
			            AND json_extract(s.data, '$.to') IS NOT NULL
			          ORDER BY s.received_at DESC, s.rowid DESC LIMIT 1) AS statusTo,
			        (SELECT l.instance_id FROM events l
			          WHERE l.workflow_id = e.workflow_id
			          ORDER BY l.received_at DESC, l.rowid DESC LIMIT 1) AS instanceId
			 FROM events e
			 ${and("e.workflow_id IS NOT NULL")}
			 GROUP BY e.workflow_id
			 ORDER BY lastActivityAt DESC`,
		)
		.all(...ev.params);

	// Status: the NEWEST signal wins. An explicit terminal transition
	// (workflow.status_changed) settles the workflow — unless a step started
	// AFTER it and is still unsettled (the hub drives manual per-step runs that
	// flip the workflow completed→running without a new status_changed, so an
	// old terminal event must not mask live work). Symmetrically, a step ADDED
	// after a terminal transition reopens the workflow — the hub flips it back
	// to draft in addStep, so a pending step newer than the last 'completed'
	// reads 'draft' here even if that status_changed event was lost (e.g. a hub
	// restart mid-run). With no terminal transition at all, any in-flight step
	// reads 'running', else 'draft'.
	const statusAt = new Map(); // workflowId → received_at of latest status_changed
	{
		const sc = d
			.prepare(
				`SELECT workflow_id AS wf, MAX(received_at) AS at
				 FROM events WHERE kind = 'workflow.status_changed' AND workflow_id IN (${rows.map(() => "?").join(",") || "NULL"})
				 GROUP BY workflow_id`,
			)
			.all(...rows.map((r) => r.workflowId));
		for (const r of sc) statusAt.set(r.wf, r.at);
	}
	const running = new Set();
	const reopened = new Set(); // terminal status + a newer pending step → draft
	const TERMINAL = new Set(["completed", "failed", "cancelled"]);
	const latest = new Map(); // workflowId → Map(stepId → {kind, at})
	if (rows.length > 0) {
		const life = d
			.prepare(
				`SELECT workflow_id AS wf, COALESCE(json_extract(data, '$.step_id'), id) AS sid, kind, received_at AS at
				 FROM events
				 WHERE kind IN ('step.added', 'step.started', 'step.waiting', 'step.done', 'step.failed')
				   AND workflow_id IN (${rows.map(() => "?").join(",")})
				 ORDER BY received_at ASC, rowid ASC`,
			)
			.all(...rows.map((r) => r.workflowId));
		for (const r of life) {
			let perStep = latest.get(r.wf);
			if (!perStep) latest.set(r.wf, (perStep = new Map()));
			// Ascending received_at/rowid (rowid breaks the same-flush timestamp
			// ties): the last write per step IS the latest.
			perStep.set(r.sid, { kind: r.kind, at: r.at });
		}
		for (const [wf, perStep] of latest) {
			const row = rows.find((r) => r.workflowId === wf);
			const changedAt = statusAt.get(wf) ?? "";
			for (const { kind, at } of perStep.values()) {
				if (kind === "step.started" && at > changedAt) {
					running.add(wf);
					break;
				}
				// step.added as a step's LATEST lifecycle row means "planned, never
				// ran" — pending work the terminal badge would otherwise hide.
				if (kind === "step.added" && at > changedAt && row && TERMINAL.has(row.statusTo)) reopened.add(wf);
			}
		}
	}

	// Instance display names, one lookup for the whole page of rows.
	const instIds = [...new Set(rows.map((r) => r.instanceId).filter(Boolean))];
	const displayNames = new Map();
	if (instIds.length > 0) {
		for (const r of d
			.prepare(`SELECT instance_id, display_name FROM instances WHERE instance_id IN (${instIds.map(() => "?").join(",")})`)
			.all(...instIds)) {
			displayNames.set(r.instance_id, r.display_name);
		}
	}

	const plans = latestPlans(rows.map((r) => r.workflowId));
	const usage = usageByWorkflow(rows.map((r) => r.workflowId));

	return rows.map((r) => {
		const plan = plans.get(r.workflowId) ?? null;
		const planSteps = planTaskSteps(plan);
		// Counting from the per-step LATEST lifecycle event, not from raw event
		// totals. A step that failed and was then re-run successfully is one done
		// step, not one done and one failed — summing `kind = 'step.failed'` rows
		// made an old, superseded failure permanent on the dashboard. Same reason
		// the plan length can't be a count of `step.started`: retries re-start the
		// same step, and that inflated the progress bar's denominator for good.
		const perStep = latest.get(r.workflowId) ?? new Map();
		const settled = { done: 0, failed: 0 };
		for (const { kind } of perStep.values()) {
			if (kind === "step.done") settled.done++;
			else if (kind === "step.failed") settled.failed++;
		}
		const stepsDone = planSteps ? planSteps.filter((s) => s.status === "done").length : settled.done;
		const stepsFailed = planSteps ? planSteps.filter((s) => s.status === "failed").length : settled.failed;
		return {
			workflowId: r.workflowId,
			name: plan?.name ?? r.name ?? r.workflowId.slice(0, 8),
			user: (r.instanceId && displayNames.get(r.instanceId)) || null,
			instanceId: r.instanceId,
			agent: r.agent ?? null,
			sandbox: r.sandbox ?? null,
			image: r.image ?? null,
			firstSeenAt: r.firstSeenAt,
			lastActivityAt: r.lastActivityAt,
			stepsAdded: r.stepsAdded,
			stepsStarted: r.stepsStarted,
			stepsDone,
			stepsFailed,
			// The plan size the progress bar divides by. A snapshot answers it
			// outright. Without one: distinct step ids seen in lifecycle events, and
			// any step's order_index pins the length from below (order 4 ⇒ at least
			// 5 steps), which covers a pending step that hasn't run yet.
			stepsTotal: planSteps
				? planSteps.length
				: Math.max(r.stepsAdded, (r.maxOrder ?? -1) + 1, perStep.size, stepsDone + stepsFailed),
			tokens: usage.get(r.workflowId) ?? { input: 0, output: 0 },
			// The snapshot is the present tense and wins outright: the hub emits it
			// after the status transition it reflects, so it is never staler.
			status: plan
				? plan.status
				: running.has(r.workflowId)
					? "running"
					: reopened.has(r.workflowId)
						? "draft"
						: (r.statusTo ?? "draft"),
			/** Whether this row's shape came from a snapshot — the canvas needs one. */
			hasPlan: !!planSteps,
		};
	});
}

/**
 * The workflow list for the dashboard, newest activity first. Honours the
 * identity/date filters only — narrowing by event kind or by workflow would
 * filter the list itself away, so those two are deliberately ignored here.
 */
export function listWorkflows({ instanceId = null, user = null, agent = null, sandbox = null, from = null, to = null } = {}) {
	return workflowAggregates({ instanceId, user, agent, sandbox, from, to });
}

/**
 * The workflow-centric detail: the step list, the workflow's summary row (full
 * history), and its recent events.
 *
 * The step list comes from the newest `workflow.plan` snapshot when there is
 * one, because that is the only source that describes the workflow as it IS —
 * including the steps that have never run, the ones that were edited or
 * reordered after the fact, the hub-owned context step, and the flags the
 * canvas draws from (subagent, acceptance criteria, retry budget, selection).
 *
 * The event fold still runs, and still supplies what a snapshot structurally
 * cannot: how long each step took, and what its judge said. The two are merged
 * per step id — plan for shape and state, events for history.
 *
 * With no snapshot (a hub too old to send one) the fold is the whole answer,
 * exactly as before: the latest step.added per step_id carries the plan; the
 * latest lifecycle event carries the run state.
 */
/** Fold sticky-note events into per-step note lists (latest state wins). */
function foldStepNotes(workflowId) {
	const rows = open()
		.prepare(
			`SELECT kind, data, created_at AS createdAt
			 FROM events
			 WHERE workflow_id = ?
			   AND kind IN ('step.note.added', 'step.note.modified', 'step.note.deleted')
			 ORDER BY received_at ASC, rowid ASC`,
		)
		.all(workflowId);
	/** stepId → noteId → note */
	const byStep = new Map();
	for (const r of rows) {
		let data;
		try {
			data = JSON.parse(r.data ?? "{}");
		} catch {
			continue;
		}
		const stepId = typeof data.step_id === "string" ? data.step_id : null;
		const noteId = typeof data.note_id === "string" ? data.note_id : null;
		if (!stepId || !noteId) continue;
		let notes = byStep.get(stepId);
		if (!notes) {
			notes = new Map();
			byStep.set(stepId, notes);
		}
		if (r.kind === "step.note.deleted") {
			notes.delete(noteId);
			continue;
		}
		const theme = data.theme === "warning" || data.theme === "success" ? data.theme : "neutral";
		let content = typeof data.content === "string" ? data.content : null;
		if (!content && typeof data.content_len === "number") {
			content = `(${data.content_len} characters — reported before note text was included)`;
		}
		notes.set(noteId, { id: noteId, theme, content: content ?? "", updatedAt: r.createdAt });
	}
	const out = new Map();
	for (const [stepId, notes] of byStep) {
		out.set(
			stepId,
			[...notes.values()].filter((n) => n.content !== ""),
		);
	}
	return out;
}

export function workflowDetail(workflowId) {
	const d = open();
	const summary = workflowAggregates({ workflowId })[0];
	if (!summary) return null;
	const rows = d
		.prepare(
			`SELECT kind, data, created_at AS createdAt
			 FROM events
			 WHERE workflow_id = ?
			   AND kind IN ('step.added', 'step.started', 'step.waiting', 'step.done', 'step.failed', 'step.judged')
			 ORDER BY received_at ASC, rowid ASC`,
		)
		.all(workflowId);

	const steps = new Map(); // stepId → accumulator, in first-seen order
	for (const r of rows) {
		let data;
		try {
			data = JSON.parse(r.data ?? "{}");
		} catch {
			continue;
		}
		const stepId = typeof data.step_id === "string" ? data.step_id : null;
		if (!stepId) continue;
		let acc = steps.get(stepId);
		if (!acc) {
			acc = {
				stepId,
				kind: "task",
				orderIndex: null,
				description: null,
				status: "pending",
				phase: "exec",
				statusAt: null,
				durationMs: null,
				retryCount: null,
				maxRetries: null,
				startedAt: null,
				finishedAt: null,
				judged: null,
				manualReview: false,
				hasAcceptanceCriteria: false,
				acceptanceCriteria: null,
				useSubagent: true,
				selected: true,
				seq: steps.size,
			};
			steps.set(stepId, acc);
		}
		if (typeof data.order_index === "number") acc.orderIndex = data.order_index;
		if (typeof data.max_retries === "number") acc.maxRetries = data.max_retries;
		// `use_subagent` has always ridden along in step.started and was simply
		// never read — the canvas needs it to know whether to draw the box.
		if (typeof data.use_subagent === "boolean") acc.useSubagent = data.use_subagent;
		// Rows arrive oldest-first, so each kind overwrites what it knows and the
		// latest event of that kind wins.
		if (r.kind === "step.added") {
			if (typeof data.description === "string") acc.description = data.description;
			acc.manualReview = data.manual_review === true;
			acc.hasAcceptanceCriteria = data.has_acceptance_criteria === true;
		} else if (r.kind === "step.started") {
			acc.status = "running";
			// Which job is in flight: exec, or the judge evaluating the result. This
			// is what lights the judge circle instead of the card.
			acc.phase = data.phase === "judge" ? "judge" : "exec";
			acc.statusAt = r.createdAt;
			if (typeof data.acceptance_criteria === "string" && data.acceptance_criteria) {
				acc.acceptanceCriteria = data.acceptance_criteria;
				acc.hasAcceptanceCriteria = true;
			}
		} else if (r.kind === "step.waiting") {
			// The manual-review gate: the run finished, a human has to sign it off.
			acc.status = "waiting";
			acc.statusAt = r.createdAt;
			acc.manualReview = true;
		} else if (r.kind === "step.done" || r.kind === "step.failed") {
			acc.status = r.kind === "step.done" ? "done" : "failed";
			acc.statusAt = r.createdAt;
			if (typeof data.duration_ms === "number") acc.durationMs = data.duration_ms;
			if (typeof data.retry_count === "number") acc.retryCount = data.retry_count;
			// started/finished timestamps ride at the top level or inside the
			// §7.3 error object, depending on the kind.
			if (typeof data.started_at === "string") acc.startedAt = data.started_at;
			if (typeof data.finished_at === "string") acc.finishedAt = data.finished_at;
			if (data.error && typeof data.error === "object") {
				if (typeof data.error.started_at === "string") acc.startedAt = data.error.started_at;
				if (typeof data.error.finished_at === "string") acc.finishedAt = data.error.finished_at;
			}
		} else if (r.kind === "step.judged") {
			acc.judged = data.ok === true ? "pass" : "fail";
			if (typeof data.acceptance_criteria === "string" && data.acceptance_criteria) {
				acc.acceptanceCriteria = data.acceptance_criteria;
				acc.hasAcceptanceCriteria = true;
			}
		}
	}

	const folded = [...steps.values()]
		.sort((a, b) => (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER) || a.seq - b.seq)
		.map(({ seq, ...step }) => step);

	const plan = latestPlans([workflowId]).get(workflowId) ?? null;
	const byId = new Map(folded.map((s) => [s.stepId, s]));
	// Plan for shape and present state; fold for the history a snapshot can't
	// carry (durations, the judge's verdict, when the status last moved).
	const orderedSteps = plan
		? plan.steps
				.filter((s) => s && typeof s.step_id === "string")
				.map((s) => {
					const past = byId.get(s.step_id) ?? {};
					return {
						stepId: s.step_id,
						kind: s.kind === "context" ? "context" : "task",
						orderIndex: typeof s.order_index === "number" ? s.order_index : null,
						description: s.description ?? past.description ?? null,
						status: s.status ?? "pending",
						phase: s.phase === "judge" ? "judge" : "exec",
						statusAt: past.statusAt ?? null,
						durationMs: past.durationMs ?? null,
						retryCount: typeof s.retry_count === "number" ? s.retry_count : (past.retryCount ?? null),
						maxRetries: typeof s.max_retries === "number" ? s.max_retries : (past.maxRetries ?? null),
						startedAt: s.started_at ?? past.startedAt ?? null,
						finishedAt: s.finished_at ?? past.finishedAt ?? null,
						judged: past.judged ?? null,
						manualReview: s.manual_review === true,
						hasAcceptanceCriteria: !!s.acceptance_criteria,
						acceptanceCriteria: s.acceptance_criteria ?? null,
						useSubagent: s.use_subagent !== false,
						manualRun: s.manual_run === true,
						selected: s.selected === true,
					};
				})
				.sort((a, b) => (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER))
		: folded;

	const notesByStep = foldStepNotes(workflowId);
	const stepsWithNotes = orderedSteps.map((s) => ({
		...s,
		notes: notesByStep.get(s.stepId) ?? [],
	}));

	return {
		workflow: summary,
		steps: stepsWithNotes,
		// The per-session readout the operator's own client prints. The tokens on
		// `summary` are the same spend rolled into two numbers; this is what lets
		// the two be compared line for line.
		usage: workflowUsage(workflowId),
		events: recentEvents({ workflowId, limit: 50 }),
	};
}
