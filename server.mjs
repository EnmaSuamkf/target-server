#!/usr/bin/env node
/**
 * The Target Project — central report server.
 *
 * Receives activity batches from Target instances and serves a React dashboard.
 * JWT auth guards /api/* (except /api/auth/*); ingest keeps its own token.
 */
import { createServer } from "node:http";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import {
	DUMMY_PASSWORD_HASH,
	authenticate,
	clearAuthCookie,
	hashToken,
	publicUser,
	randomTokenBytes,
	requireAuth,
	signInUser,
	verifyPassword,
	hashPassword,
} from "./auth.mjs";
import { validate } from "./blueprint.mjs";
import {
	DEFAULT_ADMIN_EMAIL,
	DEFAULT_ADMIN_PASSWORD,
	adminHasDefaultPassword,
	bumpTokenVersion,
	consumeResetToken,
	countAuthUsers,
	createAuthUser,
	deleteAuthUser,
	findResetToken,
	getAuthUserByEmail,
	getAuthUserById,
	invalidateResetTokens,
	isPublishedRenderDeploy,
	insertResetToken,
	listAuthUsers,
	open,
	publicUrl,
	recordLogin,
	setUserPassword,
	sweepExpiredResets,
	touchInvitedAt,
	bumpInstanceCount,
	insertEvent,
	listInstances,
	listUsers,
	listWorkflowNames,
	listWorkflows,
	recentEvents,
	stats,
	upsertInstance,
	workflowDetail,
} from "./db.mjs";
import { initMailer, isDeliveringTransport, mailTransportName, sendMail } from "./mailer.mjs";
import { inviteMail, resetMail, withToken } from "./mail-templates.mjs";
import { isLoopbackHost } from "./boot-guards.mjs";

const PORT = Number.parseInt(process.env.PORT ?? "8900", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const INGEST_TOKEN = process.env.TARGET_INGEST_TOKEN ?? "";
const AUTH_DISABLED = process.env.TARGET_AUTH_DISABLED === "1";
const PUBLIC_DIR = fileURLToPath(new URL("./public/dist", import.meta.url));
const UI_DIR = fileURLToPath(new URL("./ui", import.meta.url));
const UI_SOURCES = ["src", "index.html", "vite.config.ts", "package.json"];
const SKIP_STALE_CHECK = Boolean(process.env.TARGET_SKIP_UI_STALE_CHECK);
const MAX_BODY_BYTES = 5 * 1024 * 1024;

open();

function log(msg) {
	console.log(`[target-server] ${msg}`);
}

async function assertBootGuards() {
	if (isLoopbackHost(HOST)) return;
	if (AUTH_DISABLED) {
		throw new Error("TARGET_AUTH_DISABLED=1 is refused on a non-loopback bind — the dashboard would be public");
	}
	if (!process.env.TARGET_PUBLIC_URL && !process.env.RENDER_EXTERNAL_URL) {
		throw new Error("TARGET_PUBLIC_URL is required when HOST is not loopback — emailed links would point at the internal bind");
	}
	const allowFileMail =
		process.env.TARGET_ALLOW_FILE_MAIL === "1" ||
		isPublishedRenderDeploy();
	if (!isDeliveringTransport() && !allowFileMail) {
		throw new Error("TARGET_SMTP_URL is required when HOST is not loopback — invitations would never be delivered (override with TARGET_ALLOW_FILE_MAIL=1)");
	}
	if (!isDeliveringTransport() && allowFileMail) {
		log("WARNING: mail uses file outbox — set TARGET_SMTP_URL for delivered invitations on this host");
	}
	if (await adminHasDefaultPassword()) {
		const explicitSeed = process.env.TARGET_SEED_ADMIN_PASSWORD?.trim();
		if (explicitSeed === DEFAULT_ADMIN_PASSWORD || process.env.TARGET_USE_PUBLISHED_ADMIN === "1" || isPublishedRenderDeploy()) {
			log(
				"WARNING: admin@admin.com uses the published default password — TARGET_SEED_ADMIN_PASSWORD was explicitly set for this deployment",
			);
		} else {
			throw new Error(
				"admin@admin.com still has the published default password — set TARGET_SEED_ADMIN_PASSWORD before first boot on a public bind",
			);
		}
	}
	if (!process.env.TARGET_AUTH_SECRET) {
		log("WARNING: TARGET_AUTH_SECRET is not set — sessions depend on the DB-persisted secret");
	}
	if (!INGEST_TOKEN) {
		log("WARNING: TARGET_INGEST_TOKEN is not set — anyone who can reach the port can POST /ingest");
	}
}

function sendJson(res, status, body, extraHeaders = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders });
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

async function readJson(req, res) {
	const ct = req.headers["content-type"] ?? "";
	if (!ct.includes("application/json")) {
		sendJson(res, 415, { error: "content-type must be application/json" });
		return null;
	}
	let raw;
	try {
		raw = await readBody(req);
	} catch (err) {
		sendJson(res, err.statusCode ?? 400, { error: err.message });
		return null;
	}
	try {
		return JSON.parse(raw || "{}");
	} catch {
		sendJson(res, 400, { error: "invalid JSON" });
		return null;
	}
}

const rateBuckets = new Map();

function clientIp(req) {
	if (process.env.TARGET_TRUST_PROXY === "1") {
		const xff = req.headers["x-forwarded-for"];
		if (typeof xff === "string" && xff) return xff.split(",").pop().trim();
	}
	return req.socket.remoteAddress ?? "unknown";
}

function checkRateLimit(req, route) {
	const key = `${clientIp(req)}:${route}`;
	const now = Date.now();
	const windowMs = 15 * 60 * 1000;
	const max = 10;
	let bucket = rateBuckets.get(key);
	if (!bucket || now > bucket.resetAt) {
		bucket = { count: 0, resetAt: now + windowMs };
		rateBuckets.set(key, bucket);
	}
	bucket.count++;
	if (bucket.count > max) return { limited: true, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
	return { limited: false };
}

function rateLimited(res, retryAfter) {
	sendJson(res, 429, { error: "too_many_requests" }, { "retry-after": String(retryAfter) });
}

async function handleIngest(req, res) {
	if (INGEST_TOKEN) {
		const auth = req.headers.authorization ?? "";
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
			accepted.push(event.id);
			if (result === "inserted") added++;
		}
	}
	bumpInstanceCount(batch.instance_id, added);
	log(`ingest from ${batch.instance_id.slice(0, 8)} v${batch.version}: +${added} new (${accepted.length} acked, ${rejected.length} rejected)`);
	return sendJson(res, 200, { accepted, rejected });
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

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

function dashboardIsBuilt() {
	return existsSync(path.join(PUBLIC_DIR, "index.html"));
}

function newestMtime(target) {
	const pending = [target];
	let newest = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		let info;
		try {
			info = statSync(current);
		} catch {
			continue;
		}
		if (info.isDirectory()) {
			for (const entry of readdirSync(current)) pending.push(path.join(current, entry));
		} else if (info.mtimeMs > newest) {
			newest = info.mtimeMs;
		}
	}
	return newest;
}

const STALE_MEMO_MS = 2000;
let staleMemo = { checkedAt: 0, stale: false };

function dashboardIsStale() {
	if (SKIP_STALE_CHECK) return false;
	const now = Date.now();
	if (now - staleMemo.checkedAt < STALE_MEMO_MS) return staleMemo.stale;
	const builtAt = newestMtime(path.join(PUBLIC_DIR, "index.html"));
	const sourceAt = Math.max(...UI_SOURCES.map((rel) => newestMtime(path.join(UI_DIR, rel))));
	staleMemo = { checkedAt: now, stale: builtAt > 0 && sourceAt > builtAt };
	return staleMemo.stale;
}

function sendUiNotice(res, { title, lead, commands }) {
	res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(
		`<!doctype html><meta charset=utf-8><title>${title}</title>` +
			'<body style="font:16px/1.6 system-ui;margin:3rem auto;max-width:40rem;padding:0 1rem">' +
			`<h1>${title}</h1><p>${lead}</p>` +
			`<pre style="background:#f4f4f5;padding:1rem;border-radius:6px">${commands}</pre>` +
			"<p>Then reload this page.</p>" +
			"<p><small>The JSON API requires a signed-in session.</small></p>",
	);
}

async function serveStatic(res, urlPath) {
	const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
	const filePath = path.resolve(PUBLIC_DIR, rel);
	if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "forbidden" });
	if (!dashboardIsBuilt()) {
		sendUiNotice(res, {
			title: "Dashboard not built",
			lead: "The API is running — only the UI bundle is missing. Build it once:",
			commands: "npm run ui:install",
		});
		return;
	}
	if (dashboardIsStale()) {
		sendUiNotice(res, {
			title: "Dashboard out of date",
			lead: "public/dist was built before the current ui/ sources. Rebuild it:",
			commands: "npm run build",
		});
		return;
	}

	const tryPath = async (target) => {
		try {
			const buf = await readFile(target);
			const ext = path.extname(target).toLowerCase();
			res.writeHead(200, { "content-type": STATIC_TYPES[ext] ?? "application/octet-stream" });
			res.end(buf);
			return true;
		} catch {
			return false;
		}
	};

	if (await tryPath(filePath)) return;

	const noExt = !path.extname(urlPath);
	const notAsset = !urlPath.startsWith("/assets/");
	if (noExt && notAsset) {
		const indexPath = path.join(PUBLIC_DIR, "index.html");
		if (await tryPath(indexPath)) return;
	}
	sendJson(res, 404, { error: "not found" });
}

async function userResponse(user) {
	const usesDefaultPassword =
		user.email === DEFAULT_ADMIN_EMAIL && (await adminHasDefaultPassword());
	return { ...publicUser(user), usesDefaultPassword };
}

async function issueInvite(user) {
	sweepExpiredResets();
	invalidateResetTokens(user.id, "invite");
	const raw = randomTokenBytes().toString("hex");
	const tokenHash = hashToken(raw);
	const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
	insertResetToken({ tokenHash, userId: user.id, kind: "invite", expiresAt });
	touchInvitedAt(user.id);
	const body = withToken(inviteMail({ publicUrl: publicUrl({ host: HOST, port: PORT }), email: user.email }), raw);
	let mail;
	try {
		mail = await sendMail({ to: user.email, ...body });
	} catch (err) {
		mail = { sent: false, transport: mailTransportName(), error: String(err?.message ?? err) };
	}
	const origin = publicUrl({ host: HOST, port: PORT });
	return { invite: { url: `${origin}/setup?token=${raw}`, expiresAt }, mail };
}

async function issueReset(user) {
	sweepExpiredResets();
	invalidateResetTokens(user.id, "reset");
	const raw = randomTokenBytes().toString("hex");
	const tokenHash = hashToken(raw);
	const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
	insertResetToken({ tokenHash, userId: user.id, kind: "reset", expiresAt });
	const body = withToken(resetMail({ publicUrl: publicUrl({ host: HOST, port: PORT }), email: user.email }), raw);
	try {
		await sendMail({ to: user.email, ...body });
	} catch (err) {
		log(`reset mail failed for ${user.email}: ${String(err?.message ?? err)}`);
	}
}

async function handleAuthRoute(req, res, pathname) {
	if (req.method === "POST" && pathname === "/api/auth/login") {
		const lim = checkRateLimit(req, "login");
		if (lim.limited) return rateLimited(res, lim.retryAfter);
		const body = await readJson(req, res);
		if (!body) return;
		const v = validate("auth.login", body);
		if (!v.ok) return sendJson(res, 422, { errors: v.errors });
		const user = getAuthUserByEmail(v.value.email);
		const stored = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
		const ok = await verifyPassword(v.value.password, stored);
		if (!user || !user.passwordHash || !ok) return sendJson(res, 401, { error: "invalid_credentials" });
		recordLogin(user.id);
		signInUser(user, res);
		return sendJson(res, 200, { user: await userResponse(user) });
	}

	if (req.method === "POST" && pathname === "/api/auth/logout") {
		const user = await requireAuth(req, res);
		if (!user) return;
		bumpTokenVersion(user.id);
		clearAuthCookie(res);
		res.writeHead(204);
		return res.end();
	}

	if (req.method === "GET" && pathname === "/api/auth/me") {
		const user = await authenticate(req, res);
		if (!user) return sendJson(res, 401, { error: "unauthorized" });
		return sendJson(res, 200, { user: await userResponse(user) });
	}

	if (req.method === "POST" && pathname === "/api/auth/forgot-password") {
		const lim = checkRateLimit(req, "forgot");
		if (lim.limited) return rateLimited(res, lim.retryAfter);
		const body = await readJson(req, res);
		if (!body) return;
		const v = validate("auth.forgot", body);
		if (!v.ok) return sendJson(res, 422, { errors: v.errors });
		const user = getAuthUserByEmail(v.value.email);
		if (user?.passwordHash) await issueReset(user);
		return sendJson(res, 202, { ok: true });
	}

	if (req.method === "POST" && pathname === "/api/auth/setup") {
		const lim = checkRateLimit(req, "setup");
		if (lim.limited) return rateLimited(res, lim.retryAfter);
		const body = await readJson(req, res);
		if (!body) return;
		const v = validate("auth.setup", body);
		if (!v.ok) return sendJson(res, 422, { errors: v.errors });
		sweepExpiredResets();
		const row = findResetToken(hashToken(v.value.token));
		const now = new Date().toISOString();
		if (!row || row.kind !== "invite" || row.usedAt || row.expiresAt < now) {
			return sendJson(res, 400, { error: "invalid_or_expired" });
		}
		const user = getAuthUserById(row.userId);
		if (!user) return sendJson(res, 400, { error: "invalid_or_expired" });
		if (user.passwordHash) return sendJson(res, 409, { error: "already_activated" });
		if (!consumeResetToken(row.tokenHash)) return sendJson(res, 400, { error: "invalid_or_expired" });
		const pw = await hashPassword(v.value.password);
		setUserPassword(user.id, pw);
		bumpTokenVersion(user.id);
		const fresh = getAuthUserById(user.id);
		recordLogin(fresh.id);
		signInUser(fresh, res);
		return sendJson(res, 200, { user: await userResponse(fresh) });
	}

	if (req.method === "POST" && pathname === "/api/auth/reset-password") {
		const lim = checkRateLimit(req, "reset");
		if (lim.limited) return rateLimited(res, lim.retryAfter);
		const body = await readJson(req, res);
		if (!body) return;
		const v = validate("auth.reset", body);
		if (!v.ok) return sendJson(res, 422, { errors: v.errors });
		sweepExpiredResets();
		const row = findResetToken(hashToken(v.value.token));
		const now = new Date().toISOString();
		if (!row || row.kind !== "reset" || row.usedAt || row.expiresAt < now) {
			return sendJson(res, 400, { error: "invalid_or_expired" });
		}
		const user = getAuthUserById(row.userId);
		if (!user?.passwordHash) return sendJson(res, 400, { error: "invalid_or_expired" });
		if (!consumeResetToken(row.tokenHash)) return sendJson(res, 400, { error: "invalid_or_expired" });
		const pw = await hashPassword(v.value.password);
		setUserPassword(user.id, pw);
		const fresh = bumpTokenVersion(user.id);
		recordLogin(fresh.id);
		signInUser(fresh, res);
		return sendJson(res, 200, { user: await userResponse(fresh) });
	}

	if (req.method === "GET" && pathname === "/api/auth/users") {
		const user = await requireAuth(req, res);
		if (!user) return;
		const users = listAuthUsers().map((u) => publicUser(u));
		return sendJson(res, 200, { users });
	}

	if (req.method === "POST" && pathname === "/api/auth/users") {
		const actor = await requireAuth(req, res);
		if (!actor) return;
		const body = await readJson(req, res);
		if (!body) return;
		const v = validate("user.create", body);
		if (!v.ok) return sendJson(res, 422, { errors: v.errors });
		if (getAuthUserByEmail(v.value.email)) {
			return sendJson(res, 409, { errors: [{ field: "email", code: "email_taken", message: "Email is already in use" }] });
		}
		const created = createAuthUser({ email: v.value.email, createdBy: actor.id });
		const { invite, mail } = await issueInvite(created);
		return sendJson(res, 201, { user: publicUser(created), invite, mail });
	}

	const inviteMatch = pathname.match(/^\/api\/auth\/users\/([A-Za-z0-9-]+)\/invite$/);
	if (req.method === "POST" && inviteMatch) {
		const actor = await requireAuth(req, res);
		if (!actor) return;
		const target = getAuthUserById(inviteMatch[1]);
		if (!target) return sendJson(res, 404, { error: "not_found" });
		if (target.passwordHash) return sendJson(res, 409, { error: "already_activated" });
		const { invite, mail } = await issueInvite(target);
		return sendJson(res, 200, { invite, mail });
	}

	const deleteMatch = pathname.match(/^\/api\/auth\/users\/([A-Za-z0-9-]+)$/);
	if (req.method === "DELETE" && deleteMatch) {
		const actor = await requireAuth(req, res);
		if (!actor) return;
		const targetId = deleteMatch[1];
		const target = getAuthUserById(targetId);
		if (!target) return sendJson(res, 404, { error: "not_found" });
		if (countAuthUsers() <= 1) return sendJson(res, 409, { error: "last_user" });
		if (targetId === actor.id) return sendJson(res, 409, { error: "self_delete" });
		bumpTokenVersion(targetId);
		deleteAuthUser(targetId);
		res.writeHead(204);
		return res.end();
	}

	return false;
}

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host ?? HOST}`);
		const { pathname } = url;

		if (req.method === "POST" && pathname === "/ingest") return void (await handleIngest(req, res));
		if (req.method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true });

		if (pathname.startsWith("/api/auth/")) {
			const handled = await handleAuthRoute(req, res, pathname);
			if (handled !== false) return;
		}

		if (pathname.startsWith("/api/") && !AUTH_DISABLED) {
			const user = await requireAuth(req, res);
			if (!user) return;
		}

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
		const listFilters = (({ instanceId, user, agent, sandbox, from, to }) => ({ instanceId, user, agent, sandbox, from, to }))(filters);

		if (req.method === "GET" && pathname === "/api/workflows") {
			return sendJson(res, 200, listWorkflows({ ...listFilters, ...pageParams(url) }));
		}
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

async function start() {
	if (AUTH_DISABLED) {
		if (!isLoopbackHost(HOST)) {
			console.error("[target-server] TARGET_AUTH_DISABLED=1 is refused on a non-loopback bind");
			process.exit(1);
		}
		log("WARNING: TARGET_AUTH_DISABLED=1 — /api/* is unauthenticated");
	}
	await initMailer();
	try {
		await assertBootGuards();
	} catch (err) {
		console.error(`[target-server] ${err.message}`);
		process.exit(1);
	}
	if (!server.listening) {
		server.listen(PORT, HOST, () => {
			log(`listening on http://${HOST}:${PORT}`);
			log(`dashboard:  http://${HOST}:${PORT}/`);
			log(`ingest:     POST http://${HOST}:${PORT}/ingest`);
			log(INGEST_TOKEN ? "ingest auth: Bearer token REQUIRED" : "ingest auth: open (set TARGET_INGEST_TOKEN to require one)");
			log(`mail:       ${mailTransportName()}`);
			if (!dashboardIsBuilt()) log("WARNING: dashboard not built — run `npm run ui:install`");
			else if (dashboardIsStale()) log("WARNING: dashboard bundle is older than ui/ — run `npm run build`");
		});
	}
}

await start();

export { server, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD };
