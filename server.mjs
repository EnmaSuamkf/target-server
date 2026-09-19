#!/usr/bin/env node
/**
 * The Target Project — central report server.
 *
 * Receives activity batches from Target instances and serves a React dashboard.
 * JWT auth guards /api/* (except /api/auth/*); ingest keeps its own token.
 */
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
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
	requirePermission,
	signInUser,
	userIsActive,
	verifyPassword,
	hashPassword,
} from "./auth.mjs";
import {
	buildGoogleAuthUrl,
	clearOAuthStateCookie,
	createOAuthState,
	exchangeGoogleCode,
	fetchGoogleUserInfo,
	isGoogleOAuthConfigured,
	setOAuthStateCookie,
	verifyOAuthState,
} from "./google-oauth.mjs";
import { validate, validateSyncEventBatch } from "./blueprint.mjs";
import {
	DEFAULT_ADMIN_EMAIL,
	DEFAULT_ADMIN_PASSWORD,
	adminHasDefaultPassword,
	bumpTokenVersion,
	consumeResetToken,
	countAuthUsers,
	createAuthUser,
	createRole,
	deleteAuthUser,
	deleteRole,
	findResetToken,
	activateAuthUserWithGoogle,
	getAuthUserByEmail,
	getAuthUserByGoogleSub,
	getAuthUserById,
	getAuthUserInviteMethods,
	invalidateResetTokens,
	isPublishedRenderDeploy,
	insertResetToken,
	listAuthUsers,
	listRoles,
	open,
	publicUrl,
	recordLogin,
	setUserPassword,
	reassignAuthUserRole,
	sweepExpiredResets,
	touchInvitedAt,
	updateRole,
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
	upsertClient,
	getClientByTokenHash,
	claimPendingCommands,
	ackCommand,
	insertSyncEvent,
	listSyncEvents,
	updateRemoteWorkflowLocalId,
	updateRemoteWorkflowContext,
	listClients,
	listOnlineClients,
	getClientById,
	listRemoteWorkflows,
	getRemoteWorkflowById,
	getRemoteWorkflowDetail,
	getRunSelectedStepKeys,
	updateRemoteStepRunSelection,
	createRemoteWorkflow,
	updateRemoteWorkflowStatus,
	mirrorCommandToPlan,
	mirrorSyncEventToPlan,
	applyCommandAckToPlan,
	enqueueCommand,
	getCommandById,
	listRemoteResources,
	upsertRemoteResource,
	deleteRemoteResource,
	remoteResourceChannelId,
	mirrorResourceSyncEvent,
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

function sendRedirect(res, location) {
	res.writeHead(302, { location, "cache-control": "no-store" });
	res.end();
}

function authOrigin() {
	return publicUrl({ host: HOST, port: PORT }).replace(/\/$/, "");
}

function loginRedirect(query) {
	const params = new URLSearchParams(query);
	const q = params.toString();
	return q ? `${authOrigin()}/login?${q}` : `${authOrigin()}/login`;
}

function sendJson(res, status, body, extraHeaders = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders });
	res.end(payload);
}

async function requireCapability(req, res, permission) {
	// The explicit loopback-only development escape hatch preserves its existing
	// behaviour; deployed servers always evaluate the DB-backed guard.
	if (AUTH_DISABLED) return { id: "auth-disabled", permissions: ["*"] };
	return requirePermission(req, res, permission);
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

/** Defaults match dashboard invite form (see docs/invite-activation-methods.md). */
function resolveInviteActivationForCreate(activation) {
	if (activation === undefined) {
		const googleConfigured = isGoogleOAuthConfigured();
		return { inviteAllowPassword: true, inviteAllowGoogle: googleConfigured };
	}
	return {
		inviteAllowPassword: activation.password === true,
		inviteAllowGoogle: activation.google === true,
	};
}

async function issueInvite(user) {
	sweepExpiredResets();
	invalidateResetTokens(user.id, "invite");
	const { allowPassword, allowGoogle } = getAuthUserInviteMethods(user);
	const origin = publicUrl({ host: HOST, port: PORT }).replace(/\/$/, "");
	const loginUrl = `${origin}/login`;

	let raw = null;
	let expiresAt = null;
	if (allowPassword) {
		raw = randomTokenBytes().toString("hex");
		const tokenHash = hashToken(raw);
		expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
		insertResetToken({ tokenHash, userId: user.id, kind: "invite", expiresAt });
	}
	touchInvitedAt(user.id);

	const setupUrl = raw ? `${origin}/setup?token=${raw}` : undefined;
	let mailBody = inviteMail({
		publicUrl: origin,
		email: user.email,
		allowPassword,
		allowGoogle,
		setupUrl: allowPassword ? setupUrl : undefined,
		loginUrl: allowGoogle ? loginUrl : undefined,
	});
	if (raw) mailBody = withToken(mailBody, raw);

	let mail;
	try {
		mail = await sendMail({ to: user.email, ...mailBody });
	} catch (err) {
		mail = { sent: false, transport: mailTransportName(), error: String(err?.message ?? err) };
	}

	const invite = {};
	if (setupUrl) {
		invite.setupUrl = setupUrl;
		invite.url = setupUrl;
		invite.expiresAt = expiresAt;
	}
	if (allowGoogle) invite.loginUrl = loginUrl;
	return { invite, mail };
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

async function handleAuthRoute(req, res, pathname, url) {
	const pubOpts = { host: HOST, port: PORT };

	if (req.method === "GET" && pathname === "/api/auth/providers") {
		return sendJson(res, 200, { google: isGoogleOAuthConfigured() });
	}

	if (req.method === "GET" && pathname === "/api/auth/google") {
		if (!isGoogleOAuthConfigured()) return sendJson(res, 404, { error: "google_oauth_disabled" });
		const state = createOAuthState();
		setOAuthStateCookie(res, state);
		return sendRedirect(res, buildGoogleAuthUrl(state, pubOpts));
	}

	if (req.method === "GET" && pathname === "/api/auth/google/callback") {
		if (!isGoogleOAuthConfigured()) return sendRedirect(res, loginRedirect({ auth_error: "oauth_failed" }));
		const oauthError = url.searchParams.get("error");
		if (oauthError) {
			clearOAuthStateCookie(res);
			const code = oauthError === "access_denied" ? "oauth_denied" : "oauth_failed";
			return sendRedirect(res, loginRedirect({ auth_error: code }));
		}
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") ?? "";
		if (!code || !verifyOAuthState(req, state)) {
			clearOAuthStateCookie(res);
			return sendRedirect(res, loginRedirect({ auth_error: "oauth_failed" }));
		}
		clearOAuthStateCookie(res);
		let profile;
		try {
			const tokens = await exchangeGoogleCode(code, pubOpts);
			profile = await fetchGoogleUserInfo(tokens.access_token);
		} catch (err) {
			log(`google oauth callback failed: ${String(err?.message ?? err)}`);
			return sendRedirect(res, loginRedirect({ auth_error: "oauth_failed" }));
		}

		const byEmail = getAuthUserByEmail(profile.email);
		if (!byEmail) return sendRedirect(res, loginRedirect({ auth_error: "not_invited" }));

		const bySub = getAuthUserByGoogleSub(profile.sub);
		if (bySub && bySub.id !== byEmail.id) {
			return sendRedirect(res, loginRedirect({ auth_error: "oauth_failed" }));
		}
		if (byEmail.googleSub && byEmail.googleSub !== profile.sub) {
			return sendRedirect(res, loginRedirect({ auth_error: "oauth_failed" }));
		}

		const active = byEmail.googleSub ? byEmail : activateAuthUserWithGoogle(byEmail.id, profile.sub);
		recordLogin(active.id);
		signInUser(active, res);
		return sendRedirect(res, `${authOrigin()}/`);
	}

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
		if (userIsActive(user)) return sendJson(res, 409, { error: "already_activated" });
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
		const user = await requirePermission(req, res, "users.read");
		if (!user) return;
		const users = listAuthUsers().map((u) => publicUser(u));
		return sendJson(res, 200, { users });
	}

	if (req.method === "POST" && pathname === "/api/auth/users") {
		const actor = await requirePermission(req, res, "users.manage");
		if (!actor) return;
		const body = await readJson(req, res);
		if (!body) return;
		const v = validate("user.create", body);
		if (!v.ok) return sendJson(res, 422, { errors: v.errors });
		if (getAuthUserByEmail(v.value.email)) {
			return sendJson(res, 409, { errors: [{ field: "email", code: "email_taken", message: "Email is already in use" }] });
		}
		const inviteMethods = resolveInviteActivationForCreate(v.value.activation);
		if (inviteMethods.inviteAllowGoogle && !isGoogleOAuthConfigured()) {
			return sendJson(res, 422, {
				errors: [
					{
						field: "activation.google",
						code: "google_oauth_disabled",
						message: "Google sign-in is not configured on this server",
					},
				],
			});
		}
		let created;
		try {
			created = createAuthUser({
				email: v.value.email,
				createdBy: actor.id,
				roleId: v.value.role_id ?? "admin",
				inviteAllowPassword: inviteMethods.inviteAllowPassword,
				inviteAllowGoogle: inviteMethods.inviteAllowGoogle,
			});
		} catch (err) {
			if (err.code === "role_not_found") {
				return sendJson(res, 422, { errors: [{ field: "role_id", code: "role_not_found", message: "Role does not exist" }] });
			}
			throw err;
		}
		const { invite, mail } = await issueInvite(created);
		return sendJson(res, 201, { user: publicUser(created), invite, mail });
	}

	if (req.method === "GET" && pathname === "/api/auth/roles") {
		const actor = await requirePermission(req, res, "users.manage");
		if (!actor) return;
		return sendJson(res, 200, { roles: listRoles() });
	}

	if (req.method === "POST" && pathname === "/api/auth/roles") {
		const actor = await requirePermission(req, res, "users.manage");
		if (!actor) return;
		const body = await readJson(req, res);
		if (!body) return;
		const v = validate("role.create", body);
		if (!v.ok) return sendJson(res, 422, { errors: v.errors });
		try {
			return sendJson(res, 201, { role: createRole({ ...v.value, actorUserId: actor.id }) });
		} catch (err) {
			if (err.code === "invalid_permission") return sendJson(res, 422, { error: err.code });
			if (err.code === "invalid_role_name") return sendJson(res, 422, { error: err.code });
			if (String(err.message).includes("UNIQUE")) return sendJson(res, 409, { error: "role_name_taken" });
			throw err;
		}
	}

	const roleMatch = pathname.match(/^\/api\/auth\/roles\/([A-Za-z0-9-]+)$/);
	if (req.method === "PATCH" && roleMatch) {
		const actor = await requirePermission(req, res, "users.manage");
		if (!actor) return;
		const body = await readJson(req, res);
		if (!body) return;
		const v = validate("role.update", body);
		if (!v.ok) return sendJson(res, 422, { errors: v.errors });
		try {
			return sendJson(res, 200, { role: updateRole(roleMatch[1], { ...v.value, actorUserId: actor.id }) });
		} catch (err) {
			if (["role_not_found", "system_role_protected"].includes(err.code)) return sendJson(res, 409, { error: err.code });
			if (["invalid_permission", "invalid_role_name"].includes(err.code)) return sendJson(res, 422, { error: err.code });
			if (String(err.message).includes("UNIQUE")) return sendJson(res, 409, { error: "role_name_taken" });
			throw err;
		}
	}

	if (req.method === "DELETE" && roleMatch) {
		const actor = await requirePermission(req, res, "users.manage");
		if (!actor) return;
		try {
			deleteRole(roleMatch[1], { actorUserId: actor.id });
			res.writeHead(204);
			return res.end();
		} catch (err) {
			if (["role_not_found", "system_role_protected", "role_assigned"].includes(err.code)) {
				return sendJson(res, err.code === "role_not_found" ? 404 : 409, { error: err.code });
			}
			throw err;
		}
	}

	const inviteMatch = pathname.match(/^\/api\/auth\/users\/([A-Za-z0-9-]+)\/invite$/);
	if (req.method === "POST" && inviteMatch) {
		const actor = await requirePermission(req, res, "users.manage");
		if (!actor) return;
		const target = getAuthUserById(inviteMatch[1]);
		if (!target) return sendJson(res, 404, { error: "not_found" });
		if (userIsActive(target)) return sendJson(res, 409, { error: "already_activated" });
		const { invite, mail } = await issueInvite(target);
		return sendJson(res, 200, { invite, mail });
	}

	const userMatch = pathname.match(/^\/api\/auth\/users\/([A-Za-z0-9-]+)$/);
	if (req.method === "PATCH" && userMatch) {
		const actor = await requirePermission(req, res, "users.manage");
		if (!actor) return;
		const targetId = userMatch[1];
		if (targetId === actor.id) return sendJson(res, 409, { error: "self_role_change" });
		const body = await readJson(req, res);
		if (!body) return;
		const v = validate("user.role", body);
		if (!v.ok) return sendJson(res, 422, { errors: v.errors });
		try {
			const user = reassignAuthUserRole({ userId: targetId, roleId: v.value.role_id, actorUserId: actor.id });
			return sendJson(res, 200, { user: publicUser(user) });
		} catch (err) {
			if (err.code === "user_not_found" || err.code === "role_not_found") return sendJson(res, 404, { error: err.code });
			if (err.code === "last_administrator") return sendJson(res, 409, { error: err.code });
			throw err;
		}
	}

	const deleteMatch = pathname.match(/^\/api\/auth\/users\/([A-Za-z0-9-]+)$/);
	if (req.method === "DELETE" && deleteMatch) {
		const actor = await requirePermission(req, res, "users.manage");
		if (!actor) return;
		const targetId = deleteMatch[1];
		const target = getAuthUserById(targetId);
		if (!target) return sendJson(res, 404, { error: "not_found" });
		if (countAuthUsers() <= 1) return sendJson(res, 409, { error: "last_user" });
		if (targetId === actor.id) return sendJson(res, 409, { error: "self_delete" });
		try {
			bumpTokenVersion(targetId);
			deleteAuthUser(targetId);
		} catch (err) {
			if (err.code === "last_administrator") return sendJson(res, 409, { error: err.code });
			throw err;
		}
		res.writeHead(204);
		return res.end();
	}

	return false;
}

function syncCommandToApi(cmd) {
	return {
		id: cmd.id,
		type: cmd.type,
		remote_id: cmd.remoteId,
		sequence: cmd.sequence,
		payload: cmd.payload,
		status: cmd.status,
		created_at: cmd.createdAt,
	};
}

function normalizeClientRunners(raw) {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((r) => r && typeof r.id === "string")
		.map((r) => ({
			id: r.id,
			installed: r.installed === true,
		}));
}

function syncClientToApi(client) {
	const caps = client.capabilities ?? null;
	return {
		id: client.id,
		name: client.name,
		status: client.status,
		availability: caps?.availability ?? null,
		capabilities: caps
			? {
					commands: Array.isArray(caps.commands) ? caps.commands : [],
					version: typeof caps.version === "string" ? caps.version : null,
					instance_id: typeof caps.instance_id === "string" ? caps.instance_id : null,
					runners: normalizeClientRunners(caps.runners),
					resources: caps.resources ?? null,
				}
			: null,
		last_seen_at: client.lastSeenAt,
		created_at: client.createdAt,
	};
}

function validateClientAgent(client, agent) {
	if (!agent) return null;
	const runners = normalizeClientRunners(client.capabilities?.runners);
	if (!runners.length) return null;
	const match = runners.find((r) => r.id === agent);
	if (!match) {
		return {
			field: "agent",
			code: "unknown_runner",
			message: `Client has not reported runner “${agent}”`,
		};
	}
	if (!match.installed) {
		return {
			field: "agent",
			code: "runner_not_installed",
			message: `Runner “${agent}” is not installed on the client`,
		};
	}
	return null;
}

const RESOURCE_DOMAINS = {
	templates: { capability: "templates", permission: "remote.templates.manage", command: "template" },
	"tcp-tools": { capability: "tcp_tools", permission: "remote.tcp-tools.manage", command: "tcp-tool" },
	"resource-sets": { capability: "resource_sets", permission: "remote.rci.manage", command: "resource-set" },
};

function resourceDomainInfo(pathDomain) {
	return RESOURCE_DOMAINS[pathDomain] ?? null;
}

function clientSupportsResourceCommand(client, info, type) {
	const resources = client.capabilities?.resources;
	const commands = client.capabilities?.commands;
	return resources?.version === 2 && resources?.[info.capability] === true && Array.isArray(commands) && commands.includes(type);
}

function stableResourceCommandId(clientId, domain, idempotencyKey) {
	return `resource_${createHash("sha256").update(`${clientId}\0${domain}\0${idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

function syncEventToApi(event) {
	return {
		id: event.id,
		client_id: event.clientId,
		remote_id: event.remoteId,
		type: event.type,
		payload: event.payload,
		received_at: event.receivedAt,
	};
}

function remoteWorkflowToApi(rwf) {
	return {
		id: rwf.id,
		client_id: rwf.clientId,
		name: rwf.name,
		status: rwf.status,
		local_id: rwf.localId,
		sandbox: rwf.sandbox ?? "docker",
		conversation_context: rwf.conversationContext ?? null,
		step_count: rwf.stepCount ?? 0,
		steps_pending_sync: rwf.stepsPendingSync ?? 0,
		agent: rwf.agent ?? null,
		created_at: rwf.createdAt,
	};
}

function remoteStepToApi(step) {
	return {
		step_key: step.stepKey,
		order_index: step.orderIndex,
		description: step.description,
		acceptance_criteria: step.acceptanceCriteria,
		manual_review: step.manualReview,
		use_subagent: step.useSubagent,
		max_retries: step.maxRetries,
		retry_interval_seconds: step.retryIntervalSeconds,
		status: step.status,
		on_client: step.onClient,
		run_selected: step.runSelected !== false,
	};
}

const RUN_WORKFLOW_COMMANDS = new Set(["workflow.start", "workflow.resume", "workflow.restart"]);

function resolveRunCommandPayload(remoteId, type, payload = {}) {
	if (!RUN_WORKFLOW_COMMANDS.has(type)) return payload;
	const next = { ...payload };
	if (Array.isArray(next.step_keys) && next.step_keys.length > 0) {
		updateRemoteStepRunSelection(remoteId, next.step_keys);
		return next;
	}
	const saved = getRunSelectedStepKeys(remoteId);
	if (saved.length) return { ...next, step_keys: saved };
	return next;
}

function isOperatorSyncPath(pathname, method) {
	if (method === "GET" && pathname === "/api/sync/clients") return true;
	if (method === "GET" && pathname === "/api/sync/events") return true;
	if (pathname === "/api/sync/remote-workflows" && (method === "GET" || method === "POST")) return true;
	if (method === "GET" && /^\/api\/sync\/remote-workflows\/[^/]+$/.test(pathname)) return true;
	if (method === "PATCH" && /^\/api\/sync\/remote-workflows\/[^/]+$/.test(pathname)) return true;
	if (method === "PATCH" && /^\/api\/sync\/remote-workflows\/[^/]+\/run-selection$/.test(pathname)) return true;
	if (method === "POST" && /^\/api\/sync\/remote-workflows\/[^/]+\/commands$/.test(pathname)) return true;
	if (method === "DELETE" && /^\/api\/sync\/remote-workflows\/[^/]+$/.test(pathname)) return true;
	if (/^\/api\/sync\/clients\/[^/]+\/(templates|tcp-tools|resource-sets)(\/[^/]+)?$/.test(pathname)) return true;
	return false;
}

async function requireSyncClient(req, res) {
	const auth = req.headers.authorization ?? "";
	if (!auth.startsWith("Bearer ")) {
		sendJson(res, 401, { error: "unauthorized" });
		return null;
	}
	const client = getClientByTokenHash(hashToken(auth.slice(7)));
	if (!client || client.status !== "active") {
		sendJson(res, 401, { error: "unauthorized" });
		return null;
	}
	return client;
}

async function handleSyncRoute(req, res, pathname, url) {
	if (isOperatorSyncPath(pathname, req.method)) return false;

	if (req.method === "POST" && pathname === "/api/sync/register") {
		const body = await readJson(req, res);
		if (!body) return true;
		const v = validate("sync.register", body);
		if (!v.ok) return sendJson(res, 400, { errors: v.errors });
		const clientId = randomUUID();
		const clientToken = `sync_${randomTokenBytes().toString("hex")}`;
		const tokenHash = hashToken(clientToken);
		const now = new Date().toISOString();
		const capabilities = { ...(v.value.capabilities ?? {}) };
		if (v.value.instance_id) capabilities.instance_id = v.value.instance_id;
		if (v.value.version) capabilities.version = v.value.version;
		const client = upsertClient({
			id: clientId,
			name: v.value.name ?? v.value.display_name ?? null,
			tokenHash,
			capabilities: Object.keys(capabilities).length ? capabilities : null,
			lastSeenAt: now,
			createdAt: now,
		});
		return sendJson(res, 201, {
			client_id: client.id,
			client_token: clientToken,
			created_at: client.createdAt,
		});
	}

	const client = await requireSyncClient(req, res);
	if (!client) return true;

	if (req.method === "POST" && pathname === "/api/sync/heartbeat") {
		const body = await readJson(req, res);
		if (!body) return true;
		const v = validate("sync.heartbeat", body);
		if (!v.ok) return sendJson(res, 400, { errors: v.errors });
		const now = new Date().toISOString();
		const capabilities = {
			...(client.capabilities ?? {}),
			...(v.value.capabilities ?? {}),
			availability: v.value.status,
		};
		const version = v.value.version ?? v.value.hub_version;
		if (version) capabilities.version = version;
		upsertClient({
			id: client.id,
			tokenHash: client.tokenHash,
			capabilities,
			lastSeenAt: now,
		});
		return sendJson(res, 200, { ok: true, server_time: now });
	}

	if (req.method === "GET" && pathname === "/api/sync/commands") {
		let limit = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
		if (!Number.isFinite(limit) || limit < 1) limit = 10;
		if (limit > 50) limit = 50;
		const commands = claimPendingCommands(client.id, { limit }).map(syncCommandToApi);
		return sendJson(res, 200, { commands });
	}

	const ackMatch = pathname.match(/^\/api\/sync\/commands\/([^/]+)\/ack$/);
	if (req.method === "POST" && ackMatch) {
		const body = await readJson(req, res);
		if (!body) return true;
		const v = validate("sync.command_ack", body);
		if (!v.ok) return sendJson(res, 400, { errors: v.errors });
		const ackStatus = v.value.status === "applied" ? "acked" : "failed";
		const result = ackCommand({
			commandId: ackMatch[1],
			clientId: client.id,
			status: ackStatus,
		});
		if (!result.ok) {
			if (!result.command) return sendJson(res, 404, { error: "command_not_found" });
			return sendJson(res, 409, { error: "invalid_command_state" });
		}
		if (ackStatus === "acked" && v.value.local_id && v.value.remote_id) {
			updateRemoteWorkflowLocalId({
				remoteId: v.value.remote_id,
				clientId: client.id,
				localId: v.value.local_id,
			});
		}
		if (
			result.command &&
			(ackStatus === "acked" || (ackStatus === "failed" && result.command.type === "workflow.delete"))
		) {
			applyCommandAckToPlan({
				...result.command,
				status: ackStatus,
				ackError: typeof v.value.error?.message === "string" ? v.value.error.message : undefined,
			});
		}
		return sendJson(res, 200, {
			command_id: ackMatch[1],
			status: ackStatus,
			already_recorded: result.alreadyRecorded,
		});
	}

	if (req.method === "POST" && pathname === "/api/sync/events") {
		const body = await readJson(req, res);
		if (!body) return true;
		const v = validateSyncEventBatch(body);
		if (!v.ok) return sendJson(res, 400, { errors: v.errors });
		const accepted = [];
		const duplicates = [];
		for (const event of v.value.events) {
			const outcome = insertSyncEvent({
				id: event.id,
				clientId: client.id,
				remoteId: event.remote_id || null,
				type: event.type,
				payload: event.payload ?? {},
				receivedAt: event.created_at,
			});
			if (outcome === "inserted") {
				accepted.push(event.id);
				mirrorSyncEventToPlan({
					remoteId: event.remote_id || null,
					type: event.type,
					payload: event.payload ?? {},
				});
				mirrorResourceSyncEvent({
					clientId: client.id,
					type: event.type,
					payload: event.payload ?? {},
				});
			} else duplicates.push(event.id);
		}
		return sendJson(res, 200, { accepted, rejected: [], duplicates });
	}

	return false;
}

async function handleOperatorSyncRoute(req, res, pathname, url) {
	if (!isOperatorSyncPath(pathname, req.method)) return false;

	const resourceMatch = pathname.match(/^\/api\/sync\/clients\/([^/]+)\/(templates|tcp-tools|resource-sets)(?:\/([^/]+))?$/);
	if (resourceMatch) {
		const [, clientId, pathDomain, resourceId] = resourceMatch;
		const info = resourceDomainInfo(pathDomain);
		const client = getClientById(clientId);
		if (!client) return sendJson(res, 404, { error: "client_not_found" });
		if (req.method === "GET" && !resourceId) {
			if (!(await requireCapability(req, res, "remote.read"))) return true;
			return sendJson(res, 200, {
				contract_version: "sync/v2",
				resources: listRemoteResources(clientId, info.capability),
			});
		}
		if (!["POST", "PATCH", "DELETE"].includes(req.method) || (req.method === "POST" && resourceId)) return false;
		if (!(await requireCapability(req, res, info.permission))) return true;
		const operation = req.method === "DELETE" ? "delete" : "upsert";
		const commandType = `${info.command}.${operation}`;
		if (!clientSupportsResourceCommand(client, info, commandType)) {
			return sendJson(res, 409, {
				error: "capability_unsupported",
				detail: `Client does not support sync/v2 ${commandType}`,
				required: { resources_version: 2, domain: info.capability, command: commandType },
			});
		}
		let resource = null;
		if (operation === "upsert") {
			const body = await readJson(req, res);
			if (!body) return true;
			const v = validate("sync.resource.upsert", body);
			if (!v.ok) return sendJson(res, 422, { errors: v.errors });
			resource = v.value.resource;
			if (resourceId && resource.id !== resourceId) {
				return sendJson(res, 422, { errors: [{ field: "resource.id", code: "mismatch", message: "Resource id must match URL" }] });
			}
		}
		const effectiveResourceId = resourceId ?? resource?.id;
		if (!effectiveResourceId) return sendJson(res, 422, { error: "resource_id_required" });
		const headerKey = req.headers["idempotency-key"];
		const idempotencyKey = typeof headerKey === "string" && headerKey.trim() ? headerKey.trim() : null;
		const commandId = idempotencyKey ? stableResourceCommandId(clientId, pathDomain, idempotencyKey) : null;
		let command = commandId ? getCommandById(commandId) : null;
		if (command) {
			if (command.clientId !== clientId || command.type !== commandType) {
				return sendJson(res, 409, { error: "idempotency_key_conflict" });
			}
			return sendJson(res, 200, { command: syncCommandToApi(command), idempotent: true });
		}
		try {
			command = enqueueCommand({
				id: commandId,
				clientId,
				remoteId: remoteResourceChannelId(clientId, info.capability),
				type: commandType,
				payload: operation === "upsert" ? { resource } : { resource_id: effectiveResourceId },
			});
		} catch (err) {
			if (err.statusCode === 400) return sendJson(res, 422, { errors: err.errors });
			// Concurrent requests using the same idempotency key resolve to the
			// command already written by the winner, without applying a second change.
			if (commandId && getCommandById(commandId)) return sendJson(res, 200, { command: syncCommandToApi(getCommandById(commandId)), idempotent: true });
			throw err;
		}
		if (operation === "upsert") upsertRemoteResource({ clientId, domain: info.capability, resource });
		else deleteRemoteResource(clientId, info.capability, effectiveResourceId);
		return sendJson(res, operation === "upsert" ? 201 : 200, { command: syncCommandToApi(command), idempotent: false });
	}

	if (req.method === "GET" && pathname === "/api/sync/clients") {
		if (!(await requireCapability(req, res, "remote.read"))) return true;
		return sendJson(res, 200, { clients: listOnlineClients().map(syncClientToApi) });
	}

	if (req.method === "GET" && pathname === "/api/sync/events") {
		if (!(await requireCapability(req, res, "remote.read"))) return true;
		const clientId = url.searchParams.get("client_id") || null;
		const remoteId = url.searchParams.get("remote_id") || null;
		let limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
		if (!Number.isFinite(limit) || limit < 1) limit = 50;
		const events = listSyncEvents({ clientId, remoteId, limit }).map(syncEventToApi);
		return sendJson(res, 200, { events });
	}

	if (req.method === "GET" && pathname === "/api/sync/remote-workflows") {
		if (!(await requireCapability(req, res, "remote.read"))) return true;
		const clientId = url.searchParams.get("client_id") || null;
		const workflows = listRemoteWorkflows({ clientId }).map(remoteWorkflowToApi);
		return sendJson(res, 200, { remote_workflows: workflows });
	}

	const remoteDetailMatch = pathname.match(/^\/api\/sync\/remote-workflows\/([^/]+)$/);
	if (req.method === "GET" && remoteDetailMatch) {
		if (!(await requireCapability(req, res, "remote.read"))) return true;
		const detail = getRemoteWorkflowDetail(remoteDetailMatch[1]);
		if (!detail) return sendJson(res, 404, { error: "remote_workflow_not_found" });
		return sendJson(res, 200, {
			remote_workflow: remoteWorkflowToApi(detail.workflow),
			steps: detail.steps.map(remoteStepToApi),
			pending_commands: detail.pendingCommands.map(syncCommandToApi),
		});
	}

	if (req.method === "PATCH" && remoteDetailMatch) {
		if (!(await requireCapability(req, res, "remote.workflows.manage"))) return true;
		const body = await readJson(req, res);
		if (!body) return true;
		const remoteWorkflow = getRemoteWorkflowById(remoteDetailMatch[1]);
		if (!remoteWorkflow) return sendJson(res, 404, { error: "remote_workflow_not_found" });
		const context =
			typeof body.conversation_context === "string" ? body.conversation_context.trim() : null;
		if (context === null) return sendJson(res, 400, { error: "conversation_context_required" });
		const updated = updateRemoteWorkflowContext(remoteWorkflow.id, context);
		let contextCommand = null;
		try {
			contextCommand = enqueueCommand({
				clientId: remoteWorkflow.clientId,
				remoteId: remoteWorkflow.id,
				type: "workflow.set_context",
				payload: { conversation_context: context },
			});
			mirrorCommandToPlan({
				remoteId: remoteWorkflow.id,
				type: "workflow.set_context",
				payload: { conversation_context: context },
			});
		} catch (err) {
			if (err.statusCode === 400) return sendJson(res, 400, { errors: err.errors });
			throw err;
		}
		return sendJson(res, 200, {
			remote_workflow: remoteWorkflowToApi(updated),
			command: syncCommandToApi(contextCommand),
		});
	}

	if (req.method === "POST" && pathname === "/api/sync/remote-workflows") {
		if (!(await requireCapability(req, res, "remote.workflows.manage"))) return true;
		const body = await readJson(req, res);
		if (!body) return true;
		const v = validate("sync.remote_workflow.create", body);
		if (!v.ok) return sendJson(res, 400, { errors: v.errors });
		const client = getClientById(v.value.client_id);
		if (!client || client.status !== "active") {
			return sendJson(res, 404, { error: "client_not_found" });
		}
		const agentError = validateClientAgent(client, v.value.agent);
		if (agentError) return sendJson(res, 422, { errors: [agentError] });
		const remoteId = randomUUID();
		const conversationContext = v.value.conversation_context?.trim() || null;
		const remoteWorkflow = createRemoteWorkflow({
			id: remoteId,
			clientId: client.id,
			name: v.value.name,
			status: "pending",
			conversationContext,
			sandbox: "docker",
			agent: v.value.agent ?? null,
		});
		const payload = { name: v.value.name, sandbox: "docker" };
		if (v.value.agent) payload.agent = v.value.agent;
		let command;
		let contextCommand = null;
		try {
			command = enqueueCommand({
				clientId: client.id,
				remoteId,
				type: "workflow.create",
				payload,
			});
			if (conversationContext) {
				contextCommand = enqueueCommand({
					clientId: client.id,
					remoteId,
					type: "workflow.set_context",
					payload: { conversation_context: conversationContext },
				});
			}
		} catch (err) {
			if (err.statusCode === 400) return sendJson(res, 400, { errors: err.errors });
			throw err;
		}
		return sendJson(res, 201, {
			remote_workflow: remoteWorkflowToApi(remoteWorkflow),
			command: syncCommandToApi(command),
			context_command: contextCommand ? syncCommandToApi(contextCommand) : null,
		});
	}

	const runSelectionMatch = pathname.match(/^\/api\/sync\/remote-workflows\/([^/]+)\/run-selection$/);
	if (req.method === "PATCH" && runSelectionMatch) {
		if (!(await requireCapability(req, res, "remote.workflows.manage"))) return true;
		const body = await readJson(req, res);
		if (!body) return true;
		const v = validate("sync.remote_workflow.run_selection", body);
		if (!v.ok) return sendJson(res, 400, { errors: v.errors });
		const remoteWorkflow = getRemoteWorkflowById(runSelectionMatch[1]);
		if (!remoteWorkflow) return sendJson(res, 404, { error: "remote_workflow_not_found" });
		const stepKeys = updateRemoteStepRunSelection(remoteWorkflow.id, v.value.step_keys);
		const detail = getRemoteWorkflowDetail(remoteWorkflow.id);
		return sendJson(res, 200, {
			step_keys: stepKeys,
			steps: detail.steps.map(remoteStepToApi),
		});
	}

	const commandMatch = pathname.match(/^\/api\/sync\/remote-workflows\/([^/]+)\/commands$/);
	if (req.method === "POST" && commandMatch) {
		const body = await readJson(req, res);
		if (!body) return true;
		const v = validate("sync.remote_workflow.enqueue_command", body);
		if (!v.ok) return sendJson(res, 400, { errors: v.errors });
		const permission = RUN_WORKFLOW_COMMANDS.has(v.value.type) || ["step.run", "step.abort", "step.continue"].includes(v.value.type)
			? "remote.workflows.execute"
			: "remote.workflows.manage";
		if (!(await requireCapability(req, res, permission))) return true;
		const remoteWorkflow = getRemoteWorkflowById(commandMatch[1]);
		if (!remoteWorkflow) return sendJson(res, 404, { error: "remote_workflow_not_found" });
		const payload = resolveRunCommandPayload(remoteWorkflow.id, v.value.type, v.value.payload ?? {});
		if (RUN_WORKFLOW_COMMANDS.has(v.value.type) && (!Array.isArray(payload.step_keys) || !payload.step_keys.length)) {
			return sendJson(res, 422, {
				errors: [{ field: "payload.step_keys", code: "required", message: "Select at least one step to run" }],
			});
		}
		let command;
		try {
			command = enqueueCommand({
				clientId: remoteWorkflow.clientId,
				remoteId: remoteWorkflow.id,
				type: v.value.type,
				payload,
			});
			mirrorCommandToPlan({
				remoteId: remoteWorkflow.id,
				type: v.value.type,
				payload,
			});
		} catch (err) {
			if (err.statusCode === 400) return sendJson(res, 400, { errors: err.errors });
			throw err;
		}
		return sendJson(res, 201, { command: syncCommandToApi(command) });
	}

	const deleteMatch = pathname.match(/^\/api\/sync\/remote-workflows\/([^/]+)$/);
	if (req.method === "DELETE" && deleteMatch) {
		if (!(await requireCapability(req, res, "remote.workflows.manage"))) return true;
		const remoteWorkflow = getRemoteWorkflowById(deleteMatch[1]);
		if (!remoteWorkflow) return sendJson(res, 404, { error: "remote_workflow_not_found" });
		let body = {};
		if (req.headers["content-type"]?.includes("application/json")) {
			const parsed = await readJson(req, res);
			if (!parsed) return true;
			body = parsed;
		}
		const payload = body.force === true ? { force: true } : {};
		let command;
		try {
			command = enqueueCommand({
				clientId: remoteWorkflow.clientId,
				remoteId: remoteWorkflow.id,
				type: "workflow.delete",
				payload,
			});
		} catch (err) {
			if (err.statusCode === 400) return sendJson(res, 400, { errors: err.errors });
			throw err;
		}
		updateRemoteWorkflowStatus(remoteWorkflow.id, "deleting");
		return sendJson(res, 200, { command: syncCommandToApi(command) });
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
			const handled = await handleAuthRoute(req, res, pathname, url);
			if (handled !== false) return;
		}

		if (pathname.startsWith("/api/sync/")) {
			const handled = await handleSyncRoute(req, res, pathname, url);
			if (handled !== false) return;
		}

		if (pathname.startsWith("/api/") && !AUTH_DISABLED) {
			const user = await requireAuth(req, res);
			if (!user) return;
		}

		if (pathname.startsWith("/api/sync/")) {
			const handled = await handleOperatorSyncRoute(req, res, pathname, url);
			if (handled !== false) return;
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

		if (req.method === "GET" && pathname === "/api/stats") {
			if (!(await requireCapability(req, res, "activity.read"))) return;
			return sendJson(res, 200, stats(filters));
		}
		if (req.method === "GET" && pathname === "/api/instances") {
			if (!(await requireCapability(req, res, "activity.read"))) return;
			return sendJson(res, 200, { instances: listInstances() });
		}
		if (req.method === "GET" && pathname === "/api/users") {
			if (!(await requireCapability(req, res, "activity.read"))) return;
			return sendJson(res, 200, { users: listUsers() });
		}
		if (req.method === "GET" && pathname === "/api/events") {
			if (!(await requireCapability(req, res, "activity.read"))) return;
			return sendJson(res, 200, {
				events: recentEvents({
					limit: Number.parseInt(url.searchParams.get("limit") ?? "100", 10),
					...filters,
				}),
			});
		}
		const listFilters = (({ instanceId, user, agent, sandbox, from, to }) => ({ instanceId, user, agent, sandbox, from, to }))(filters);

		if (req.method === "GET" && pathname === "/api/workflows") {
			if (!(await requireCapability(req, res, "activity.read"))) return;
			return sendJson(res, 200, listWorkflows({ ...listFilters, ...pageParams(url) }));
		}
		if (req.method === "GET" && pathname === "/api/workflows/names") {
			if (!(await requireCapability(req, res, "activity.read"))) return;
			return sendJson(res, 200, { workflows: listWorkflowNames(listFilters) });
		}
		const workflowMatch = pathname.match(/^\/api\/workflows\/([A-Za-z0-9-]+)$/);
		if (req.method === "GET" && workflowMatch) {
			if (!(await requireCapability(req, res, "activity.read"))) return;
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
