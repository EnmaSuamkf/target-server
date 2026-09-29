/**
 * First boot against a pre-multi-org SQLite file: the existing TARGET_SERVER_DB
 * becomes organization "default" (slug from TARGET_DEFAULT_ORG_SLUG), users and
 * devices are backfilled, and login / Activity / linked devices keep working.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-upgrade-default-"));
const dbPath = path.join(tmpDir, "legacy.db");
const controlPath = path.join(tmpDir, "control.db");
const PASSWORD = "legacy-owner-pass-12";
const DEVICE_SECRET = "legacy-device-secret";
const JWT_SECRET = randomBytes(32).toString("base64url");
const NOW = "2026-01-15T12:00:00.000Z";

function hashPassword(plain) {
	const salt = randomBytes(16);
	const hash = scryptSync(plain, salt, 64, { N: 16384, r: 8, p: 1 });
	return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function hashToken(raw) {
	return createHash("sha256").update(raw).digest("hex");
}

const legacy = new DatabaseSync(dbPath);
legacy.exec(`
	CREATE TABLE instances (
		instance_id   TEXT PRIMARY KEY,
		display_name  TEXT,
		version       TEXT,
		first_seen_at TEXT NOT NULL,
		last_seen_at  TEXT NOT NULL,
		events_count  INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE events (
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
	CREATE TABLE auth_users (
		id             TEXT PRIMARY KEY,
		email          TEXT NOT NULL UNIQUE,
		password_hash  TEXT,
		role           TEXT NOT NULL DEFAULT 'admin',
		token_version  INTEGER NOT NULL DEFAULT 1,
		created_at     TEXT NOT NULL,
		created_by     TEXT,
		invited_at     TEXT,
		activated_at   TEXT,
		last_login_at  TEXT
	);
	CREATE TABLE auth_meta (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		jwt_secret TEXT NOT NULL,
		created_at TEXT NOT NULL
	);
	CREATE TABLE clients (
		id                 TEXT PRIMARY KEY,
		name               TEXT,
		token_hash         TEXT NOT NULL,
		status             TEXT NOT NULL DEFAULT 'active',
		capabilities_json  TEXT,
		last_seen_at       TEXT,
		created_at         TEXT NOT NULL
	);
	CREATE TABLE linked_devices (
		id                 TEXT PRIMARY KEY,
		owner_user_id      TEXT NOT NULL REFERENCES auth_users(id),
		name               TEXT NOT NULL,
		hub_version        TEXT,
		public_key         TEXT NOT NULL,
		scopes_json        TEXT NOT NULL,
		status             TEXT NOT NULL CHECK (status IN ('active', 'rotating', 'revoked')),
		credential_version INTEGER NOT NULL DEFAULT 1,
		created_at         TEXT NOT NULL,
		updated_at         TEXT NOT NULL,
		last_used_at       TEXT,
		revoked_at         TEXT,
		revoked_by_user_id TEXT REFERENCES auth_users(id),
		revocation_reason  TEXT
	);
	CREATE TABLE device_credentials (
		device_id    TEXT NOT NULL REFERENCES linked_devices(id),
		version      INTEGER NOT NULL,
		secret_hash  TEXT NOT NULL UNIQUE,
		issued_at    TEXT NOT NULL,
		expires_at   TEXT,
		revoked_at   TEXT,
		PRIMARY KEY (device_id, version)
	);
`);
legacy.prepare(
	`INSERT INTO auth_users (id, email, password_hash, role, token_version, created_at, activated_at)
	 VALUES (?, ?, ?, 'admin', 1, ?, ?)`,
).run("legacy-owner", "owner@legacy.example.com", hashPassword(PASSWORD), NOW, NOW);
legacy.prepare("INSERT INTO auth_meta (id, jwt_secret, created_at) VALUES (1, ?, ?)").run(JWT_SECRET, NOW);
legacy
	.prepare(
		`INSERT INTO instances (instance_id, display_name, version, first_seen_at, last_seen_at, events_count)
		 VALUES ('dev_legacy', 'Legacy hub', '0.8.0', ?, ?, 1)`,
	)
	.run(NOW, NOW);
legacy
	.prepare(
		`INSERT INTO events (id, instance_id, kind, workflow_id, created_at, received_at, data)
		 VALUES ('evt-legacy-1', 'dev_legacy', 'workflow.created', 'wf-legacy', ?, ?, ?)`,
	)
	.run(NOW, NOW, JSON.stringify({ name: "Legacy workflow" }));
legacy.prepare(
		"INSERT INTO clients (id, name, token_hash, last_seen_at, created_at) VALUES ('legacy-unlinked-client', 'Old client', 'legacy-client-hash', ?, ?)",
	).run(new Date().toISOString(), NOW);
legacy
	.prepare(
		`INSERT INTO linked_devices
		 (id, owner_user_id, name, hub_version, public_key, scopes_json, status, credential_version, created_at, updated_at)
		 VALUES ('dev_legacy', 'legacy-owner', 'Legacy hub', '0.8.0', 'ed25519-legacy', ?, 'active', 1, ?, ?)`,
	)
	.run(JSON.stringify(["ingest:write", "sync:write"]), NOW, NOW);
legacy
	.prepare(
		`INSERT INTO device_credentials (device_id, version, secret_hash, issued_at)
		 VALUES ('dev_legacy', 1, ?, ?)`,
	)
	.run(hashToken(DEVICE_SECRET), NOW);
legacy.close();

process.env.TARGET_SERVER_DB = dbPath;
process.env.TARGET_CONTROL_DB = controlPath;
process.env.TARGET_MULTI_ORG = "1";
process.env.TARGET_DEVICE_LINKING_MODE = "required";
process.env.TARGET_DEFAULT_ORG_SLUG = "legacy-prod";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
const control = await import("../control-plane.mjs");
const { signJwt } = await import("../auth.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const json = (method, body, cookie) => ({
	method,
	headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
	body: body == null ? undefined : JSON.stringify(body),
});

test("existing pre-change database boots as the default organization", async () => {
	const org = control.getOrganization("default");
	assert.ok(org);
	assert.equal(org.slug, "legacy-prod");
	assert.equal(org.dbPath, dbPath);
	const dir = control.getUserDirectoryByEmail("owner@legacy.example.com");
	assert.equal(dir?.orgId, "default");
	assert.equal(dir?.userId, "legacy-owner");
	assert.equal(control.listMembershipsByEmail("owner@legacy.example.com").length, 1);
	assert.equal(control.getDeviceDirectory("dev_legacy")?.orgId, "default");

	const login = await fetch(
		`${base}/api/auth/login`,
		json("POST", { email: "owner@legacy.example.com", password: PASSWORD }),
	);
	assert.equal(login.status, 200, await login.text());
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
	const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json();
	assert.equal(me.user.email, "owner@legacy.example.com");
	assert.equal(me.user.role, "admin");
	assert.ok(me.user.permissions.includes("activity.read"));
	assert.ok(!me.user.superuser);

	const events = await fetch(`${base}/api/events`, { headers: { cookie } });
	assert.equal(events.status, 200);
	const eventBody = await events.json();
	assert.ok(eventBody.events.some((e) => e.id === "evt-legacy-1" && e.workflowId === "wf-legacy"));
	const stats = await fetch(`${base}/api/stats`, { headers: { cookie } });
	assert.equal(stats.status, 200);
	assert.ok((await stats.json()).totalEvents >= 1);

	const devices = await fetch(`${base}/api/device-links/devices`, { headers: { cookie } });
	assert.equal(devices.status, 200);
	assert.ok((await devices.json()).devices.some((d) => d.id === "dev_legacy"));

	const clients = await fetch(`${base}/api/sync/clients`, { headers: { cookie } });
	assert.equal(clients.status, 200);
	assert.ok((await clients.json()).clients.some((c) => c.id === "legacy-unlinked-client"));

	const now = Math.floor(Date.now() / 1000);
	const priorSession = signJwt(
		{
			sub: "legacy-owner",
			email: "owner@legacy.example.com",
			role: "admin",
			tv: 1,
			iat: now,
			exp: now + 3600,
		},
		JWT_SECRET,
	);
	const sessionMe = await fetch(`${base}/api/auth/me`, { headers: { cookie: `target_auth=${priorSession}` } });
	const sessionBody = await sessionMe.json();
	assert.equal(sessionMe.status, 200, JSON.stringify(sessionBody));
	assert.equal(sessionBody.user.email, "owner@legacy.example.com");

	const ingest = await fetch(`${base}/ingest`, {
		method: "POST",
		headers: {
			authorization: `Target-Device v1 dev_legacy.${DEVICE_SECRET}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			instance_id: "dev_legacy",
			version: "0.8.0",
			events: [{ id: "evt-legacy-2", kind: "heartbeat", data: {} }],
		}),
	});
	assert.equal(ingest.status, 200, await ingest.text());
});
