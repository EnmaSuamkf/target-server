#!/usr/bin/env node
/**
 * The Target Project — central report server.
 *
 * Receives activity batches from Target instances (the report-to-server client
 * built in the target repo; wire contract: docs/report-server.es.html §7) and
 * serves a React dashboard that visualises them.
 *
 * Zero external dependencies: Node builtins + node:sqlite. Run with `npm start`
 * (or `node server.mjs`). Config via env:
 *   PORT                (default 8900)
 *   HOST                (default 127.0.0.1)
 *   TARGET_INGEST_TOKEN (optional; if set, POST /ingest requires a matching
 *                        `Authorization: Bearer <token>`)
 *   TARGET_SERVER_DB    (default ./target-server.db)
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import {
	bumpInstanceCount,
	insertEvent,
	listInstances,
	listUsers,
	listWorkflowNames,
	listWorkflows,
	open,
	recentEvents,
	stats,
	upsertInstance,
	workflowDetail,
} from "./db.mjs";

const PORT = Number.parseInt(process.env.PORT ?? "8900", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const INGEST_TOKEN = process.env.TARGET_INGEST_TOKEN ?? "";
// The dashboard is a Vite build (see ui/): `npm run build` emits it here.
const PUBLIC_DIR = fileURLToPath(new URL("./public/dist", import.meta.url));
const MAX_BODY_BYTES = 5 * 1024 * 1024;

open(); // initialise the schema up front

function log(msg) {
	console.log(`[target-server] ${msg}`);
}

function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(payload);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				reject(Object.assign(new Error("payload too large"), { statusCode: 413 }));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** POST /ingest — the endpoint Target instances report to (§7). */
async function handleIngest(req, res) {
	if (INGEST_TOKEN) {
		const auth = req.headers["authorization"] ?? "";
		if (auth !== `Bearer ${INGEST_TOKEN}`) return sendJson(res, 401, { error: "unauthorized" });
	}

	let raw;
	try {
		raw = await readBody(req);
	} catch (err) {
		return sendJson(res, err.statusCode ?? 400, { error: err.message });
	}

	let batch;
	try {
		batch = JSON.parse(raw);
	} catch {
		return sendJson(res, 400, { error: "invalid JSON" });
	}
	if (!batch || typeof batch.instance_id !== "string" || !Array.isArray(batch.events)) {
		return sendJson(res, 422, { error: "missing instance_id or events[]" });
	}

	const now = new Date().toISOString();
	upsertInstance(batch, now);

	const accepted = [];
	const rejected = [];
	let added = 0;
	for (const event of batch.events) {
		const result = insertEvent(batch.instance_id, batch.version, event, now);
		if (result === "rejected") {
			rejected.push({ id: event?.id ?? null, reason: "schema", detail: "event needs a string id and kind" });
		} else {
			// Both freshly-inserted and duplicate ids are acknowledged (idempotency, §7.4).
			accepted.push(event.id);
			if (result === "inserted") added++;
		}
	}
	bumpInstanceCount(batch.instance_id, added);
	log(`ingest from ${batch.instance_id.slice(0, 8)} v${batch.version}: +${added} new (${accepted.length} acked, ${rejected.length} rejected)`);
	return sendJson(res, 200, { accepted, rejected });
}

/** Page size the workflow list defaults to, and the ceiling it will honour. */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

/** `?limit=&offset=`, clamped — a client asking for everything gets a page. */
function pageParams(url) {
	const asInt = (name, fallback) => {
		const n = Number.parseInt(url.searchParams.get(name) ?? "", 10);
		return Number.isFinite(n) ? n : fallback;
	};
	return {
		limit: Math.min(MAX_PAGE_SIZE, Math.max(1, asInt("limit", DEFAULT_PAGE_SIZE))),
		offset: Math.max(0, asInt("offset", 0)),
	};
}

const STATIC_TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".jsx": "text/babel; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".map": "application/json",
	".svg": "image/svg+xml",
};

/** The dashboard ships as source; without a build there is nothing to serve. */
function dashboardIsBuilt() {
	return existsSync(path.join(PUBLIC_DIR, "index.html"));
}

async function serveStatic(res, urlPath) {
	const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
	// Contain path traversal within PUBLIC_DIR.
	const filePath = path.resolve(PUBLIC_DIR, rel);
	if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "forbidden" });
	if (!dashboardIsBuilt()) {
		// The API is up and ingest works; only the UI is missing. Say so in the
		// browser instead of a bare 404 nobody can act on.
		res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(
			"<!doctype html><meta charset=utf-8><title>Dashboard not built</title>" +
				'<body style="font:16px/1.6 system-ui;margin:3rem auto;max-width:40rem;padding:0 1rem">' +
				"<h1>Dashboard not built</h1><p>The API is running — only the UI bundle is missing. Build it once:</p>" +
				'<pre style="background:#f4f4f5;padding:1rem;border-radius:6px">npm run ui:install\nnpm run build</pre>' +
				"<p>Then reload this page.</p>",
		);
		return;
	}
	try {
		const buf = await readFile(filePath);
		const ext = path.extname(filePath).toLowerCase();
		res.writeHead(200, { "content-type": STATIC_TYPES[ext] ?? "application/octet-stream" });
		res.end(buf);
	} catch {
		sendJson(res, 404, { error: "not found" });
	}
}

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host ?? HOST}`);
		const { pathname } = url;

		if (req.method === "POST" && pathname === "/ingest") return void (await handleIngest(req, res));
		if (req.method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true });

		// Dashboard filters shared by /api/stats and /api/events: date range on
		// received_at plus user (instance display name) / instance / workflow and
		// the workflow metadata filters agent (runner) / sandbox (host|docker).
		const filters = {
			kind: url.searchParams.get("kind"),
			instanceId: url.searchParams.get("instance"),
			workflowId: url.searchParams.get("workflow"),
			user: url.searchParams.get("user"),
			agent: url.searchParams.get("agent"),
			sandbox: url.searchParams.get("sandbox"),
			from: url.searchParams.get("from"),
			to: url.searchParams.get("to"),
		};

		if (req.method === "GET" && pathname === "/api/stats") return sendJson(res, 200, stats(filters));
		if (req.method === "GET" && pathname === "/api/instances") return sendJson(res, 200, { instances: listInstances() });
		if (req.method === "GET" && pathname === "/api/users") return sendJson(res, 200, { users: listUsers() });
		if (req.method === "GET" && pathname === "/api/events") {
			return sendJson(res, 200, {
				events: recentEvents({
					limit: Number.parseInt(url.searchParams.get("limit") ?? "100", 10),
					...filters,
				}),
			});
		}
		// Only the identity/date filters apply to the workflow list: narrowing it
		// by event kind or by workflow would filter the list itself away (the
		// detail route below answers that question).
		const listFilters = (({ instanceId, user, agent, sandbox, from, to }) => ({ instanceId, user, agent, sandbox, from, to }))(filters);

		if (req.method === "GET" && pathname === "/api/workflows") {
			// One aggregate row per workflow, one page at a time. The list is
			// unbounded by nature — a busy fleet has thousands of workflows — so
			// `limit` is clamped rather than trusted, and always applied.
			return sendJson(res, 200, listWorkflows({ ...listFilters, ...pageParams(url) }));
		}
		// Before the /:id route below, which would otherwise swallow "names".
		if (req.method === "GET" && pathname === "/api/workflows/names") {
			return sendJson(res, 200, { workflows: listWorkflowNames(listFilters) });
		}
		const workflowMatch = pathname.match(/^\/api\/workflows\/([A-Za-z0-9-]+)$/);
		if (req.method === "GET" && workflowMatch) {
			const detail = workflowDetail(workflowMatch[1]);
			if (!detail) return sendJson(res, 404, { error: "unknown_workflow" });
			return sendJson(res, 200, detail);
		}

		if (req.method === "GET") return void (await serveStatic(res, pathname));
		sendJson(res, 405, { error: "method not allowed" });
	} catch (err) {
		log(`request error: ${String(err)}`);
		if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
	}
});

server.listen(PORT, HOST, () => {
	log(`listening on http://${HOST}:${PORT}`);
	log(`dashboard:  http://${HOST}:${PORT}/`);
	log(`ingest:     POST http://${HOST}:${PORT}/ingest`);
	log(INGEST_TOKEN ? "ingest auth: Bearer token REQUIRED" : "ingest auth: open (set TARGET_INGEST_TOKEN to require one)");
	if (!dashboardIsBuilt()) log("WARNING: dashboard not built — run `npm run ui:install && npm run build` (the API works regardless)");
});

export { server };
