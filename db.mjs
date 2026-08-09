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
	const failures = d
		.prepare(`SELECT COUNT(*) AS n FROM events ${and("kind = 'step.failed'")}`)
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
	const usage = d
		.prepare(
			`SELECT
			   COALESCE(SUM(json_extract(data,'$.input_tokens')),0)  AS input,
			   COALESCE(SUM(json_extract(data,'$.output_tokens')),0) AS output
			 FROM events ${and("kind = 'usage.snapshot'")}`,
		)
		.get(...ev.params);
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
// The hub reports a workflow as a STREAM of events (§7): workflow.created
// opens it, step.added records the plan (the step list), step.started/done/
// failed/judged track execution. The views below fold that stream back into
// one row per workflow (the list) or one row per step (the detail).

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
			        COALESCE(SUM(CASE WHEN e.kind = 'usage.snapshot' THEN json_extract(e.data, '$.input_tokens') END), 0)  AS tokensIn,
			        COALESCE(SUM(CASE WHEN e.kind = 'usage.snapshot' THEN json_extract(e.data, '$.output_tokens') END), 0) AS tokensOut,
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
	if (rows.length > 0) {
		const life = d
			.prepare(
				`SELECT workflow_id AS wf, json_extract(data, '$.step_id') AS sid, kind, received_at AS at
				 FROM events
				 WHERE kind IN ('step.added', 'step.started', 'step.done', 'step.failed')
				   AND workflow_id IN (${rows.map(() => "?").join(",")})
				   AND json_extract(data, '$.step_id') IS NOT NULL
				 ORDER BY received_at ASC, rowid ASC`,
			)
			.all(...rows.map((r) => r.workflowId));
		const latest = new Map(); // workflowId → Map(stepId → {kind, at})
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

	return rows.map((r) => ({
		workflowId: r.workflowId,
		name: r.name ?? r.workflowId.slice(0, 8),
		user: (r.instanceId && displayNames.get(r.instanceId)) || null,
		instanceId: r.instanceId,
		agent: r.agent ?? null,
		sandbox: r.sandbox ?? null,
		image: r.image ?? null,
		firstSeenAt: r.firstSeenAt,
		lastActivityAt: r.lastActivityAt,
		stepsAdded: r.stepsAdded,
		stepsStarted: r.stepsStarted,
		stepsDone: r.stepsDone,
		stepsFailed: r.stepsFailed,
		// The plan size the progress bar divides by. step.added only exists for
		// steps created after the hub reported them, and started/done only cover
		// steps that already ran — but any step event's order_index pins the list
		// length from below (order 4 ⇒ at least 5 steps), which also covers a
		// pending step whose lifecycle events haven't arrived yet.
		stepsTotal: Math.max(r.stepsAdded, (r.maxOrder ?? -1) + 1, r.stepsStarted, r.stepsDone + r.stepsFailed),
		tokens: { input: r.tokensIn, output: r.tokensOut },
		status: running.has(r.workflowId) ? "running" : reopened.has(r.workflowId) ? "draft" : (r.statusTo ?? "draft"),
	}));
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
 * The workflow-centric detail: the step list folded from the event stream, the
 * workflow's summary row (full history), and its recent events.
 *
 * Step reconstruction: the latest step.added per step_id carries the plan
 * (description, order_index, review flags); the latest lifecycle event carries
 * the run state — failed if step.failed, done if step.done, running if
 * step.started with no settle after it, pending when only step.added exists.
 * Steps known only from lifecycle events (created before the hub reported
 * step.added) are included with whatever those events say about them.
 */
export function workflowDetail(workflowId) {
	const d = open();
	const summary = workflowAggregates({ workflowId })[0];
	if (!summary) return null;
	const rows = d
		.prepare(
			`SELECT kind, data, created_at AS createdAt
			 FROM events
			 WHERE workflow_id = ?
			   AND kind IN ('step.added', 'step.started', 'step.done', 'step.failed', 'step.judged')
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
				orderIndex: null,
				description: null,
				status: "pending",
				statusAt: null,
				durationMs: null,
				retryCount: null,
				startedAt: null,
				finishedAt: null,
				judged: null,
				manualReview: false,
				hasAcceptanceCriteria: false,
				seq: steps.size,
			};
			steps.set(stepId, acc);
		}
		if (typeof data.order_index === "number") acc.orderIndex = data.order_index;
		// Rows arrive oldest-first, so each kind overwrites what it knows and the
		// latest event of that kind wins.
		if (r.kind === "step.added") {
			if (typeof data.description === "string") acc.description = data.description;
			acc.manualReview = data.manual_review === true;
			acc.hasAcceptanceCriteria = data.has_acceptance_criteria === true;
		} else if (r.kind === "step.started") {
			acc.status = "running";
			acc.statusAt = r.createdAt;
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
		}
	}

	const orderedSteps = [...steps.values()]
		.sort((a, b) => (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER) || a.seq - b.seq)
		.map(({ seq, ...step }) => step);

	return {
		workflow: summary,
		steps: orderedSteps,
		events: recentEvents({ workflowId, limit: 50 }),
	};
}
