/**
 * Process-wide control plane (one SQLite file, not per-org).
 *
 * Holds organization registry, global user/token/device directories, pairing
 * requests whose org is unknown until approval, platform audit, and the JWT
 * signing secret. Org DBs stay tenant-scoped; request code must not pick an
 * org from the body or Host header.
 *
 * Path: `TARGET_CONTROL_DB`, or `control.db` next to `TARGET_SERVER_DB`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CONTROL_SCHEMA_VERSION = 2;
export const DEFAULT_ORG_ID = "default";

let controlDb = null;
let jwtSecretCache = null;
let jwtSecretAdopter = null;

export function isMultiOrg() {
	return process.env.TARGET_MULTI_ORG === "1";
}

export function deviceLinkingMode() {
	return process.env.TARGET_DEVICE_LINKING_MODE ?? "legacy";
}

/** `TARGET_MULTI_ORG=1` is refused unless pairing is mandatory. */
export function assertMultiOrgDeviceLinkingMode() {
	if (!isMultiOrg()) return;
	if (deviceLinkingMode() !== "required") {
		throw new Error("TARGET_MULTI_ORG=1 requires TARGET_DEVICE_LINKING_MODE=required");
	}
}

export function defaultOrgSlug() {
	const raw = process.env.TARGET_DEFAULT_ORG_SLUG;
	if (raw == null || String(raw).trim() === "") return "default";
	const slug = String(raw).trim().toLowerCase();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) {
		throw new Error("TARGET_DEFAULT_ORG_SLUG must be a lowercase kebab-case slug (max 64 characters)");
	}
	return slug;
}

export function defaultOrgDbPath() {
	return process.env.TARGET_SERVER_DB ?? "./target-server.db";
}

export function controlDbPath() {
	if (process.env.TARGET_CONTROL_DB) return process.env.TARGET_CONTROL_DB;
	return join(dirname(defaultOrgDbPath()), "control.db");
}

function controlError(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

function parseJsonArray(json) {
	try {
		const value = JSON.parse(json);
		return Array.isArray(value) ? value : [];
	} catch {
		return [];
	}
}

export function openControlDb() {
	if (controlDb) return controlDb;
	controlDb = new DatabaseSync(controlDbPath());
	controlDb.exec("PRAGMA journal_mode = WAL;");
	migrateControlSchema(controlDb);
	return controlDb;
}

function migrateControlSchema(database) {
	database.exec(`
		CREATE TABLE IF NOT EXISTS organizations (
			id         TEXT PRIMARY KEY,
			slug       TEXT NOT NULL UNIQUE,
			name       TEXT NOT NULL,
			status     TEXT NOT NULL DEFAULT 'active',
			db_path    TEXT NOT NULL,
			created_at TEXT NOT NULL,
			created_by TEXT
		);
		CREATE TABLE IF NOT EXISTS superusers (
			id             TEXT PRIMARY KEY,
			email          TEXT NOT NULL UNIQUE,
			password_hash  TEXT,
			google_sub     TEXT,
			token_version  INTEGER NOT NULL DEFAULT 1,
			created_at     TEXT NOT NULL,
			activated_at   TEXT,
			last_login_at  TEXT
		);
		CREATE TABLE IF NOT EXISTS identities (
			id             TEXT PRIMARY KEY,
			email          TEXT NOT NULL UNIQUE,
			password_hash  TEXT,
			google_sub     TEXT,
			token_version  INTEGER NOT NULL DEFAULT 1,
			created_at     TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS user_directory (
			email   TEXT NOT NULL,
			org_id  TEXT NOT NULL REFERENCES organizations(id),
			user_id TEXT NOT NULL,
			PRIMARY KEY (email, org_id)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_user_directory_org_user ON user_directory(org_id, user_id);
		CREATE TABLE IF NOT EXISTS token_directory (
			token_hash TEXT PRIMARY KEY,
			org_id     TEXT REFERENCES organizations(id),
			subject_id TEXT NOT NULL,
			kind       TEXT NOT NULL,
			expires_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_token_directory_org_subject ON token_directory(org_id, subject_id, kind);
		CREATE TABLE IF NOT EXISTS device_directory (
			device_id TEXT PRIMARY KEY,
			org_id    TEXT NOT NULL REFERENCES organizations(id)
		);
		CREATE INDEX IF NOT EXISTS idx_device_directory_org ON device_directory(org_id);
		CREATE TABLE IF NOT EXISTS device_link_requests (
			id                       TEXT PRIMARY KEY,
			org_id                   TEXT REFERENCES organizations(id),
			idempotency_key          TEXT UNIQUE,
			idempotency_fingerprint  TEXT,
			device_name              TEXT NOT NULL,
			hub_version              TEXT,
			public_key               TEXT NOT NULL,
			scopes_json              TEXT NOT NULL,
			polling_credential_hash  TEXT NOT NULL UNIQUE,
			owner_user_id            TEXT,
			status                   TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
			created_at               TEXT NOT NULL,
			expires_at               TEXT NOT NULL,
			decided_at               TEXT,
			consumed_at              TEXT,
			device_id                TEXT UNIQUE
		);
		CREATE INDEX IF NOT EXISTS idx_control_link_requests_state ON device_link_requests(status, expires_at);
		CREATE TABLE IF NOT EXISTS platform_audit (
			id          TEXT PRIMARY KEY,
			actor       TEXT,
			action      TEXT NOT NULL,
			detail_json TEXT,
			created_at  TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit(created_at DESC);
		CREATE TABLE IF NOT EXISTS jwt_secret (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			secret TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`);
	const row = database.prepare("PRAGMA user_version").get();
	const version = Number(row?.user_version ?? 0);
	if (version < 2) migrateUserDirectoryToMemberships(database);
	if (version < CONTROL_SCHEMA_VERSION) {
		database.exec(`PRAGMA user_version = ${CONTROL_SCHEMA_VERSION}`);
	}
}

function userDirectoryHasEmailPrimaryKey(database) {
	const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_directory'").get();
	if (!row?.sql) return false;
	return /email\s+TEXT PRIMARY KEY/i.test(row.sql) || /PRIMARY KEY\s*\(\s*email\s*\)/i.test(row.sql);
}

/** v1 `email` PK → memberships `(email, org_id)` plus `identities`. Existing rows copy 1:1. */
function migrateUserDirectoryToMemberships(database) {
	database.exec(`
		CREATE TABLE IF NOT EXISTS identities (
			id             TEXT PRIMARY KEY,
			email          TEXT NOT NULL UNIQUE,
			password_hash  TEXT,
			google_sub     TEXT,
			token_version  INTEGER NOT NULL DEFAULT 1,
			created_at     TEXT NOT NULL
		);
	`);
	if (!userDirectoryHasEmailPrimaryKey(database)) return;
	database.exec(`
		CREATE TABLE user_directory_v2 (
			email   TEXT NOT NULL,
			org_id  TEXT NOT NULL REFERENCES organizations(id),
			user_id TEXT NOT NULL,
			PRIMARY KEY (email, org_id)
		);
		INSERT INTO user_directory_v2 (email, org_id, user_id) SELECT email, org_id, user_id FROM user_directory;
		DROP TABLE user_directory;
		ALTER TABLE user_directory_v2 RENAME TO user_directory;
		CREATE UNIQUE INDEX IF NOT EXISTS idx_user_directory_org_user ON user_directory(org_id, user_id);
	`);
}

export function writePlatformAudit({ actor = null, action, detail = null, createdAt = null }) {
	openControlDb()
		.prepare(
			`INSERT INTO platform_audit (id, actor, action, detail_json, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.run(
			randomUUID(),
			actor,
			action,
			detail == null ? null : JSON.stringify(detail),
			createdAt ?? new Date().toISOString(),
		);
}

function rowToOrganization(row) {
	if (!row) return null;
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		status: row.status,
		dbPath: row.db_path,
		createdAt: row.created_at,
		createdBy: row.created_by,
	};
}

export function getOrganizationBySlug(slug) {
	if (!slug) return null;
	return rowToOrganization(openControlDb().prepare("SELECT * FROM organizations WHERE slug = ?").get(slug));
}

export function getOrganization(id) {
	if (!id) return null;
	return rowToOrganization(openControlDb().prepare("SELECT * FROM organizations WHERE id = ?").get(id));
}

export function listOrganizations() {
	return openControlDb().prepare("SELECT * FROM organizations ORDER BY created_at ASC").all().map(rowToOrganization);
}

export function createOrganization({
	id = randomUUID(),
	slug,
	name,
	dbPath,
	status = "active",
	createdBy = null,
}) {
	if (!slug?.trim() || !name?.trim() || !dbPath) {
		throw new Error("createOrganization requires slug, name, and dbPath");
	}
	const now = new Date().toISOString();
	openControlDb()
		.prepare(
			`INSERT INTO organizations (id, slug, name, status, db_path, created_at, created_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(id, slug.trim(), name.trim(), status, dbPath, now, createdBy);
	writePlatformAudit({ actor: createdBy ?? "system", action: "organization.created", detail: { id, slug: slug.trim(), dbPath } });
	return getOrganization(id);
}

export function ensureDefaultOrganization({ dbPath = defaultOrgDbPath(), name = "Default" } = {}) {
	const existing = getOrganization(DEFAULT_ORG_ID);
	if (existing) return existing;
	try {
		return createOrganization({
			id: DEFAULT_ORG_ID,
			slug: defaultOrgSlug(),
			name,
			dbPath,
			createdBy: "system",
		});
	} catch (err) {
		if (!/UNIQUE/.test(String(err.message))) throw err;
		return getOrganization(DEFAULT_ORG_ID);
	}
}

function rowToMembership(row) {
	if (!row) return null;
	return { email: row.email, orgId: row.org_id, userId: row.user_id };
}

/** First membership for this email (stable order). Prefer `listMembershipsByEmail`. */
export function getUserDirectoryByEmail(email) {
	if (!email) return null;
	const row = openControlDb()
		.prepare("SELECT email, org_id, user_id FROM user_directory WHERE email = ? ORDER BY org_id ASC LIMIT 1")
		.get(email);
	return rowToMembership(row);
}

export function listMembershipsByEmail(email) {
	if (!email) return [];
	return openControlDb()
		.prepare("SELECT email, org_id, user_id FROM user_directory WHERE email = ? ORDER BY org_id ASC")
		.all(email)
		.map(rowToMembership);
}

export function getMembership(email, orgId) {
	if (!email || !orgId) return null;
	const row = openControlDb()
		.prepare("SELECT email, org_id, user_id FROM user_directory WHERE email = ? AND org_id = ?")
		.get(email, orgId);
	return rowToMembership(row);
}

export function getUserDirectoryByOrgUser(orgId, userId) {
	if (!orgId || !userId) return null;
	const row = openControlDb()
		.prepare("SELECT email, org_id, user_id FROM user_directory WHERE org_id = ? AND user_id = ?")
		.get(orgId, userId);
	return rowToMembership(row);
}

export function upsertUserDirectory({ email, orgId, userId }) {
	const existing = getMembership(email, orgId);
	if (existing) {
		if (existing.userId === userId) return existing;
		openControlDb().prepare("UPDATE user_directory SET user_id = ? WHERE email = ? AND org_id = ?").run(userId, email, orgId);
		return getMembership(email, orgId);
	}
	openControlDb().prepare("INSERT INTO user_directory (email, org_id, user_id) VALUES (?, ?, ?)").run(email, orgId, userId);
	return getMembership(email, orgId);
}

export function deleteUserDirectoryMembership({ email, orgId }) {
	openControlDb().prepare("DELETE FROM user_directory WHERE email = ? AND org_id = ?").run(email, orgId);
}

/** @deprecated memberships are per org; use deleteUserDirectoryMembership */
export function deleteUserDirectoryByEmail(email) {
	openControlDb().prepare("DELETE FROM user_directory WHERE email = ?").run(email);
}

function rowToIdentity(row) {
	if (!row) return null;
	return {
		id: row.id,
		email: row.email,
		passwordHash: row.password_hash,
		googleSub: row.google_sub ?? null,
		tokenVersion: row.token_version,
		createdAt: row.created_at,
	};
}

export function getIdentityByEmail(email) {
	if (!email) return null;
	return rowToIdentity(openControlDb().prepare("SELECT * FROM identities WHERE email = ?").get(email));
}

export function getIdentityById(id) {
	if (!id) return null;
	return rowToIdentity(openControlDb().prepare("SELECT * FROM identities WHERE id = ?").get(id));
}

export function upsertIdentity({ email, passwordHash = undefined, googleSub = undefined }) {
	const normalized = String(email ?? "").trim().toLowerCase();
	if (!normalized) return null;
	const existing = getIdentityByEmail(normalized);
	const now = new Date().toISOString();
	if (!existing) {
		const id = randomUUID();
		openControlDb()
			.prepare(
				`INSERT INTO identities (id, email, password_hash, google_sub, token_version, created_at)
				 VALUES (?, ?, ?, ?, 1, ?)`,
			)
			.run(id, normalized, passwordHash ?? null, googleSub ?? null, now);
		return getIdentityById(id);
	}
	if (passwordHash !== undefined) {
		openControlDb().prepare("UPDATE identities SET password_hash = ? WHERE id = ?").run(passwordHash, existing.id);
	}
	if (googleSub !== undefined) {
		openControlDb().prepare("UPDATE identities SET google_sub = ? WHERE id = ?").run(googleSub, existing.id);
	}
	return getIdentityById(existing.id);
}

export function bumpIdentityTokenVersion(email) {
	openControlDb().prepare("UPDATE identities SET token_version = token_version + 1 WHERE email = ?").run(email);
	return getIdentityByEmail(email);
}

export function membershipOrgSummaries(email) {
	const out = [];
	for (const m of listMembershipsByEmail(email)) {
		const org = getOrganization(m.orgId);
		if (org) out.push({ id: org.id, slug: org.slug, name: org.name });
	}
	return out;
}

export function getTokenDirectory(tokenHash) {
	if (!tokenHash) return null;
	const row = openControlDb().prepare("SELECT * FROM token_directory WHERE token_hash = ?").get(tokenHash);
	if (!row) return null;
	return {
		tokenHash: row.token_hash,
		orgId: row.org_id,
		subjectId: row.subject_id,
		kind: row.kind,
		expiresAt: row.expires_at,
	};
}

export function upsertTokenDirectory({ tokenHash, orgId, subjectId, kind, expiresAt }) {
	openControlDb()
		.prepare(
			`INSERT INTO token_directory (token_hash, org_id, subject_id, kind, expires_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(token_hash) DO UPDATE SET
				org_id = excluded.org_id,
				subject_id = excluded.subject_id,
				kind = excluded.kind,
				expires_at = excluded.expires_at`,
		)
		.run(tokenHash, orgId, subjectId, kind, expiresAt);
}

export function deleteTokenDirectory(tokenHash) {
	openControlDb().prepare("DELETE FROM token_directory WHERE token_hash = ?").run(tokenHash);
}

export function deleteTokenDirectoryForSubject(orgId, subjectId, kind) {
	if (orgId == null) {
		openControlDb()
			.prepare("DELETE FROM token_directory WHERE org_id IS NULL AND subject_id = ? AND kind = ?")
			.run(subjectId, kind);
		return;
	}
	openControlDb()
		.prepare("DELETE FROM token_directory WHERE org_id = ? AND subject_id = ? AND kind = ?")
		.run(orgId, subjectId, kind);
}

function rowToSuperuser(row) {
	if (!row) return null;
	return {
		id: row.id,
		email: row.email,
		passwordHash: row.password_hash,
		googleSub: row.google_sub ?? null,
		tokenVersion: row.token_version,
		createdAt: row.created_at,
		activatedAt: row.activated_at,
		lastLoginAt: row.last_login_at,
		superuser: true,
		permissions: [],
	};
}

export function getSuperuserByEmail(email) {
	if (!email) return null;
	return rowToSuperuser(openControlDb().prepare("SELECT * FROM superusers WHERE email = ?").get(email));
}

export function getSuperuserById(id) {
	if (!id) return null;
	return rowToSuperuser(openControlDb().prepare("SELECT * FROM superusers WHERE id = ?").get(id));
}

/** Idempotent pending superuser. Never sets a password. */
export function ensurePendingSuperuser(email) {
	const normalized = String(email ?? "").trim().toLowerCase();
	if (!normalized) return null;
	const existing = getSuperuserByEmail(normalized);
	if (existing) return existing;
	if (listMembershipsByEmail(normalized).length > 0) throw controlError("email_taken", "email is already in use");
	const now = new Date().toISOString();
	const id = randomUUID();
	openControlDb()
		.prepare(
			`INSERT INTO superusers (id, email, password_hash, token_version, created_at)
			 VALUES (?, ?, NULL, 1, ?)`,
		)
		.run(id, normalized, now);
	writePlatformAudit({ actor: "system", action: "superuser.created", detail: { email: normalized } });
	return getSuperuserById(id);
}

export function setSuperuserPassword(id, passwordHash) {
	const now = new Date().toISOString();
	openControlDb()
		.prepare("UPDATE superusers SET password_hash = ?, activated_at = COALESCE(activated_at, ?) WHERE id = ?")
		.run(passwordHash, now, id);
	return getSuperuserById(id);
}

export function recordSuperuserLogin(id) {
	const now = new Date().toISOString();
	openControlDb().prepare("UPDATE superusers SET last_login_at = ? WHERE id = ?").run(now, id);
	return getSuperuserById(id);
}

export function bumpSuperuserTokenVersion(id) {
	openControlDb().prepare("UPDATE superusers SET token_version = token_version + 1 WHERE id = ?").run(id);
	return getSuperuserById(id);
}

export function getDeviceDirectory(deviceId) {
	if (!deviceId) return null;
	const row = openControlDb().prepare("SELECT device_id, org_id FROM device_directory WHERE device_id = ?").get(deviceId);
	if (!row) return null;
	return { deviceId: row.device_id, orgId: row.org_id };
}

export function upsertDeviceDirectory({ deviceId, orgId }) {
	openControlDb()
		.prepare(
			`INSERT INTO device_directory (device_id, org_id) VALUES (?, ?)
			 ON CONFLICT(device_id) DO UPDATE SET org_id = excluded.org_id`,
		)
		.run(deviceId, orgId);
}

export function rowToControlLinkRequest(row) {
	if (!row) return null;
	return {
		id: row.id,
		orgId: row.org_id ?? null,
		deviceName: row.device_name,
		hubVersion: row.hub_version,
		scopes: parseJsonArray(row.scopes_json),
		ownerUserId: row.owner_user_id,
		status: row.status,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		decidedAt: row.decided_at,
		consumedAt: row.consumed_at,
		deviceId: row.device_id,
		idempotencyKey: row.idempotency_key,
		idempotencyFingerprint: row.idempotency_fingerprint,
		publicKey: row.public_key,
		pollingCredentialHash: row.polling_credential_hash,
		scopesJson: row.scopes_json,
	};
}

export function getControlLinkRequest(id) {
	return openControlDb().prepare("SELECT * FROM device_link_requests WHERE id = ?").get(id);
}

export function getControlLinkRequestByIdempotencyKey(idempotencyKey) {
	if (!idempotencyKey) return null;
	return openControlDb().prepare("SELECT * FROM device_link_requests WHERE idempotency_key = ?").get(idempotencyKey);
}

export function insertControlLinkRequest(row) {
	openControlDb()
		.prepare(
			`INSERT INTO device_link_requests
			 (id, org_id, idempotency_key, idempotency_fingerprint, device_name, hub_version, public_key, scopes_json,
			  polling_credential_hash, status, created_at, expires_at)
			 VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
		)
		.run(
			row.id,
			row.idempotencyKey,
			row.idempotencyFingerprint,
			row.deviceName,
			row.hubVersion,
			row.publicKey,
			row.scopesJson,
			row.pollingCredentialHash,
			row.createdAt,
			row.expiresAt,
		);
}

export function updateControlLinkRequestDecision({ requestId, decision, ownerUserId, orgId, decidedAt }) {
	return openControlDb()
		.prepare(
			`UPDATE device_link_requests SET status = ?, owner_user_id = ?, org_id = ?, decided_at = ?
			 WHERE id = ? AND status = 'pending'`,
		)
		.run(decision, ownerUserId, orgId, decidedAt, requestId);
}

export function expireControlLinkRequest(requestId) {
	openControlDb()
		.prepare("UPDATE device_link_requests SET status = 'expired' WHERE id = ? AND status IN ('pending', 'approved')")
		.run(requestId);
}

export function consumeControlLinkRequest({ requestId, pollingCredentialHash, deviceId, consumedAt }) {
	return openControlDb()
		.prepare(
			`UPDATE device_link_requests SET status = 'consumed', consumed_at = ?, device_id = ?
			 WHERE id = ? AND status = 'approved' AND polling_credential_hash = ?`,
		)
		.run(consumedAt, deviceId, requestId, pollingCredentialHash);
}

export function expireDueControlLinkRequests(now) {
	const rows = openControlDb()
		.prepare("SELECT id FROM device_link_requests WHERE status IN ('pending', 'approved') AND expires_at <= ?")
		.all(now);
	if (rows.length === 0) return [];
	openControlDb()
		.prepare("UPDATE device_link_requests SET status = 'expired' WHERE status IN ('pending', 'approved') AND expires_at <= ?")
		.run(now);
	return rows;
}

export function authenticateControlLinkRequest({ requestId, pollingCredentialHash }) {
	return openControlDb()
		.prepare("SELECT * FROM device_link_requests WHERE id = ? AND polling_credential_hash = ?")
		.get(requestId, pollingCredentialHash);
}

function controlHasJwtSecret() {
	return Boolean(openControlDb().prepare("SELECT secret FROM jwt_secret WHERE id = 1").get());
}

function persistControlJwtSecret(secret) {
	openControlDb()
		.prepare("INSERT INTO jwt_secret (id, secret, created_at) VALUES (1, ?, ?)")
		.run(secret, new Date().toISOString());
}

/** One-time copy of a pre-control-plane org `auth_meta.jwt_secret`. */
export function adoptJwtSecretFromOrgHandle(handle) {
	if (process.env.TARGET_AUTH_SECRET || controlHasJwtSecret()) return;
	let row;
	try {
		row = handle.prepare("SELECT jwt_secret FROM auth_meta WHERE id = 1").get();
	} catch {
		return;
	}
	if (row?.jwt_secret) persistControlJwtSecret(row.jwt_secret);
}

export function registerJwtSecretAdopter(fn) {
	jwtSecretAdopter = fn;
}

export function getJwtSecret() {
	const env = process.env.TARGET_AUTH_SECRET;
	if (env) return env;
	if (jwtSecretCache) return jwtSecretCache;
	openControlDb();
	if (typeof jwtSecretAdopter === "function") jwtSecretAdopter();
	const row = openControlDb().prepare("SELECT secret FROM jwt_secret WHERE id = 1").get();
	if (row) {
		jwtSecretCache = row.secret;
		return jwtSecretCache;
	}
	const secret = randomBytes(32).toString("base64url");
	persistControlJwtSecret(secret);
	console.warn("[target-server] generated JWT secret and persisted it in the control-plane database (set TARGET_AUTH_SECRET to override)");
	jwtSecretCache = secret;
	return jwtSecretCache;
}
