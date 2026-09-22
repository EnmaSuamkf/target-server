import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-device-link-")), "legacy.db");
const legacy = new DatabaseSync(dbPath);
legacy.exec(`
	CREATE TABLE auth_users (
		id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'admin',
		token_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, created_by TEXT, invited_at TEXT,
		activated_at TEXT, last_login_at TEXT
	);
	CREATE TABLE auth_roles (
		id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, is_system INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL
	);
	CREATE TABLE auth_role_permissions (
		role_id TEXT NOT NULL,
		permission TEXT NOT NULL CHECK (permission IN (
			'activity.read', 'users.read', 'users.manage', 'remote.read', 'remote.workflows.manage',
			'remote.workflows.execute', 'remote.templates.manage', 'remote.tcp-tools.manage', 'remote.rci.manage'
		)),
		PRIMARY KEY (role_id, permission)
	);
	CREATE TABLE instances (instance_id TEXT PRIMARY KEY, display_name TEXT, version TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, events_count INTEGER NOT NULL DEFAULT 0);
	CREATE TABLE events (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, kind TEXT NOT NULL, workflow_id TEXT, session_id TEXT, version TEXT, created_at TEXT, received_at TEXT NOT NULL, data TEXT);
	CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT, token_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', capabilities_json TEXT, last_seen_at TEXT, created_at TEXT NOT NULL);
`);
legacy.prepare("INSERT INTO auth_users (id, email, role, token_version, created_at) VALUES ('owner', 'owner@example.test', 'admin', 1, ?)").run("2026-01-01T00:00:00.000Z");
legacy.prepare("INSERT INTO instances (instance_id, first_seen_at, last_seen_at) VALUES ('preserved-instance', ?, ?)").run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
legacy.prepare("INSERT INTO events (id, instance_id, kind, received_at) VALUES ('preserved-event', 'preserved-instance', 'heartbeat', ?)").run("2026-01-01T00:00:00.000Z");
legacy.prepare("INSERT INTO clients (id, token_hash, created_at) VALUES ('preserved-client', 'legacy-client-hash', ?)").run("2026-01-01T00:00:00.000Z");
legacy.close();

process.env.TARGET_SERVER_DB = dbPath;
const db = await import("../db.mjs");
db.open();

const hash = (value) => createHash("sha256").update(value).digest("hex");
const future = "2026-12-31T00:00:00.000Z";
const past = "2026-01-01T00:00:00.000Z";

test("additive migration preserves legacy rows and widens the closed RBAC catalogue", () => {
	assert.equal(db.getAuthUserById("owner").email, "owner@example.test");
	assert.equal(db.open().prepare("SELECT instance_id FROM instances WHERE instance_id = ?").get("preserved-instance").instance_id, "preserved-instance");
	assert.equal(db.open().prepare("SELECT id FROM events WHERE id = ?").get("preserved-event").id, "preserved-event");
	assert.equal(db.open().prepare("SELECT id FROM clients WHERE id = ?").get("preserved-client").id, "preserved-client");
	assert.ok(db.PERMISSIONS.includes("devices.link"));
	assert.ok(db.PERMISSIONS.includes("devices.manage"));
	assert.ok(db.PERMISSIONS.includes("remote.templates.create"));
	assert.equal(db.PERMISSIONS.includes("remote.templates.manage"), false);
	assert.deepEqual(db.getRoleById("admin").permissions, [...db.PERMISSIONS].sort());
	assert.equal(db.isValidPermission("devices.link"), true);
	assert.equal(db.isValidPermission("devices.escalate"), false);
	assert.throws(() => db.createRole({ name: "Bad device role", permissions: ["devices.escalate"] }), (err) => err.code === "invalid_permission");
});

test("link requests store only hashes, enforce owner existence and consume exactly once", () => {
	const request = db.createDeviceLinkRequest({
		id: "request-one",
		idempotencyKey: "idem-one",
		idempotencyFingerprint: "fingerprint-one",
		deviceName: "Ada workstation",
		hubVersion: "0.9.0",
		publicKey: "ed25519-public-key",
		scopes: ["sync:write", "ingest:write"],
		pollingCredentialHash: hash("poll-secret"),
		expiresAt: future,
		createdAt: past,
	});
	assert.equal(request.status, "pending");
	assert.equal(request.pollingCredentialHash, undefined);
	assert.equal(request.publicKey, undefined);
	const raw = db.open().prepare("SELECT * FROM device_link_requests WHERE id = ?").get("request-one");
	assert.equal(raw.polling_credential_hash, hash("poll-secret"));
	assert.equal(JSON.stringify(raw).includes("poll-secret"), false);
	assert.equal(Object.keys(raw).some((key) => key === "polling_credential"), false);

	assert.throws(
		() => db.decideDeviceLinkRequest({ requestId: "request-one", ownerUserId: "missing-user", decision: "approved", decidedAt: "2026-06-01T00:00:00.000Z" }),
		(err) => err.code === "owner_not_found",
	);
	const approved = db.decideDeviceLinkRequest({ requestId: "request-one", ownerUserId: "owner", decision: "approved", decidedAt: "2026-06-01T00:00:00.000Z" });
	assert.equal(approved.status, "approved");
	assert.equal(approved.ownerUserId, "owner");

	const device = db.consumeDeviceLinkRequest({
		requestId: "request-one",
		pollingCredentialHash: hash("poll-secret"),
		deviceId: "device-one",
		deviceSecretHash: hash("device-secret"),
		consumedAt: "2026-06-01T00:00:01.000Z",
	});
	assert.equal(device.status, "active");
	assert.equal(device.ownerUserId, "owner");
	assert.equal(device.publicKey, undefined);
	const rawCredential = db.open().prepare("SELECT secret_hash FROM device_credentials WHERE device_id = ?").get("device-one");
	assert.equal(rawCredential.secret_hash, hash("device-secret"));
	assert.equal(JSON.stringify(rawCredential).includes("device-secret"), false);
	assert.throws(
		() => db.consumeDeviceLinkRequest({ requestId: "request-one", pollingCredentialHash: hash("poll-secret"), deviceSecretHash: hash("another-secret") }),
		(err) => err.code === "already_consumed",
	);
});

test("credentials rotate and revoke without exposing or reusing a revoked credential", () => {
	const authenticated = db.authenticateDevice({ deviceId: "device-one", secretHash: hash("device-secret"), now: "2026-06-01T00:01:00.000Z" });
	assert.equal(authenticated.id, "device-one");
	assert.equal(authenticated.scopes.includes("sync:write"), true);
	assert.equal(authenticated.secretHash, undefined);

	const rotated = db.rotateDeviceCredential({
		deviceId: "device-one",
		currentSecretHash: hash("device-secret"),
		newSecretHash: hash("device-secret-v2"),
		rotatedAt: "2026-06-01T00:02:00.000Z",
	});
	assert.equal(rotated.credentialVersion, 2);
	assert.equal(db.authenticateDevice({ deviceId: "device-one", secretHash: hash("device-secret"), now: "2026-06-01T00:03:00.000Z" }), null);
	assert.equal(db.authenticateDevice({ deviceId: "device-one", secretHash: hash("device-secret-v2"), now: "2026-06-01T00:03:00.000Z" }).id, "device-one");
	assert.equal(db.DEVICE_ONLINE_TTL_MS, 30_000);
	assert.equal(db.listLinkedDevices({ nowMs: Date.parse("2026-06-01T00:03:15.000Z") }).find((d) => d.id === "device-one").operationalStatus, "online");
	assert.equal(db.listLinkedDevices({ nowMs: Date.parse("2026-06-01T00:03:45.000Z") }).find((d) => d.id === "device-one").operationalStatus, "offline");

	const revoked = db.revokeLinkedDevice({
		deviceId: "device-one",
		actorUserId: "owner",
		reason: "lost device",
		revokedAt: "2026-06-01T00:04:00.000Z",
	});
	assert.equal(revoked.status, "revoked");
	assert.equal(db.authenticateDevice({ deviceId: "device-one", secretHash: hash("device-secret-v2"), now: "2026-06-01T00:05:00.000Z" }), null);
	assert.ok(db.listDeviceAudit({ deviceId: "device-one" }).some((entry) => entry.action === "device.revoked"));
});

test("a clean reinstall creates a separate offline identity without name or owner grouping", () => {
	db.createDeviceLinkRequest({
		id: "request-reinstall", deviceName: "Ada workstation", publicKey: "new-ed25519-public-key",
		scopes: ["sync:write"], pollingCredentialHash: hash("reinstall-poll"), expiresAt: future,
	});
	db.decideDeviceLinkRequest({ requestId: "request-reinstall", ownerUserId: "owner", decision: "approved", decidedAt: "2026-06-02T00:00:00.000Z" });
	const replacement = db.consumeDeviceLinkRequest({
		requestId: "request-reinstall", pollingCredentialHash: hash("reinstall-poll"), deviceId: "device-reinstalled",
		deviceSecretHash: hash("reinstall-secret"), consumedAt: "2026-06-02T00:00:01.000Z",
	});
	assert.equal(replacement.operationalStatus, "offline");
	const history = db.listLinkedDevices({ includeArchived: true, nowMs: Date.parse("2026-06-02T00:01:00.000Z") });
	assert.equal(history.filter((d) => d.name === "Ada workstation" && d.ownerUserId === "owner").length, 2);
	assert.equal(history.find((d) => d.id === "device-one").operationalStatus, "revoked");
	assert.equal(history.find((d) => d.id === "device-reinstalled").operationalStatus, "offline");
	assert.ok(db.listDeviceAudit({ deviceId: "device-one" }).some((e) => e.action === "device.revoked"));
});

test("expiration is deterministic and idempotency keys do not silently change a request", () => {
	const original = db.createDeviceLinkRequest({
		id: "request-expiring",
		idempotencyKey: "idem-expiring",
		idempotencyFingerprint: "stable",
		deviceName: "Expired hub",
		publicKey: "ed25519-expired",
		scopes: ["ingest:write"],
		pollingCredentialHash: hash("expired-poll"),
		expiresAt: "2026-06-01T00:00:00.000Z",
	});
	const replay = db.createDeviceLinkRequest({
		id: "ignored-new-id",
		idempotencyKey: "idem-expiring",
		idempotencyFingerprint: "stable",
		deviceName: "Changed but ignored",
		publicKey: "ed25519-expired",
		scopes: ["ingest:write"],
		pollingCredentialHash: hash("different-poll"),
		expiresAt: future,
	});
	assert.equal(replay.id, original.id);
	assert.equal(replay.idempotent, true);
	assert.throws(
		() => db.createDeviceLinkRequest({
			idempotencyKey: "idem-expiring", idempotencyFingerprint: "different", deviceName: "Conflict",
			publicKey: "ed25519-conflict", scopes: ["ingest:write"], pollingCredentialHash: hash("conflict"), expiresAt: future,
		}),
		(err) => err.code === "idempotency_conflict",
	);
	assert.equal(db.expireDeviceLinkRequests("2026-06-01T00:00:01.000Z"), 1);
	assert.equal(db.getDeviceLinkRequest("request-expiring").status, "expired");
	assert.equal(db.expireDeviceLinkRequests("2026-06-01T00:00:01.000Z"), 0);
});
