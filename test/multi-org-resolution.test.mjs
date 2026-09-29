import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";

const ROOT = new URL("..", import.meta.url).pathname;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-multi-org-"));
const orgAPath = path.join(tmpDir, "org-a.db");
const orgBPath = path.join(tmpDir, "org-b.db");

process.env.TARGET_MULTI_ORG = "1";
process.env.TARGET_DEVICE_LINKING_MODE = "required";
process.env.TARGET_SERVER_DB = path.join(tmpDir, "default.db");
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");
process.env.TARGET_INGEST_TOKEN = "legacy-ingest-token";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
const db = await import("../db.mjs");
const control = await import("../control-plane.mjs");
const { hashPassword, hashToken } = await import("../auth.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

control.createOrganization({ id: "org_a", slug: "alpha", name: "Alpha", dbPath: orgAPath });
control.createOrganization({ id: "org_b", slug: "beta", name: "Beta", dbPath: orgBPath });
db.runWithOrg("org_a", () => db.open());
db.runWithOrg("org_b", () => db.open());

const passwordA = "org-a-password-123";
const passwordB = "org-b-password-123";
const hashA = await hashPassword(passwordA);
const hashB = await hashPassword(passwordB);
const userA = db.runWithOrg("org_a", () => db.createAuthUser({ email: "alice@org-a.example.com" }));
db.runWithOrg("org_a", () => db.setUserPassword(userA.id, hashA));
const userB = db.runWithOrg("org_b", () => db.createAuthUser({ email: "carol@org-b.example.com" }));
db.runWithOrg("org_b", () => db.setUserPassword(userB.id, hashB));

function decodeJwt(cookieHeader) {
	const jwt = decodeURIComponent(cookieHeader.match(/target_auth=([^;]+)/)?.[1] ?? "");
	return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
}

async function login(email, password) {
	const res = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	const body = await res.json();
	assert.equal(res.status, 200, JSON.stringify(body));
	const cookie = res.headers.get("set-cookie") ?? "";
	return { cookie: cookie.split(";")[0], payload: decodeJwt(cookie), body };
}

function countEvents(dbPath) {
	const handle = new DatabaseSync(dbPath);
	try {
		return handle.prepare("SELECT COUNT(*) AS n FROM events").get().n;
	} finally {
		handle.close();
	}
}

function eventIds(dbPath) {
	const handle = new DatabaseSync(dbPath);
	try {
		return handle.prepare("SELECT id FROM events ORDER BY id").all().map((row) => row.id);
	} finally {
		handle.close();
	}
}

function createLinkPayload(name = "Beta hub") {
	return {
		contract_version: "device-link/v1",
		device_name: name,
		hub_version: "0.9.0",
		public_key: { algorithm: "ed25519", value: "b".repeat(43) },
		requested_scopes: ["ingest:write", "sync:write"],
	};
}

test("org A login JWT carries org A", async () => {
	const { payload, body } = await login("alice@org-a.example.com", passwordA);
	assert.equal(payload.org, "org_a");
	assert.equal(payload.email, "alice@org-a.example.com");
	assert.equal(body.user.email, "alice@org-a.example.com");
});

test("setup token issued in org A resolves to org A", async () => {
	const { cookie } = await login("alice@org-a.example.com", passwordA);
	const created = await fetch(`${base}/api/auth/users`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ email: "bob@org-a.example.com", role_id: "admin" }),
	});
	const invite = await created.json();
	assert.equal(created.status, 201, JSON.stringify(invite));
	const token = new URL(invite.invite.setupUrl).searchParams.get("token");
	assert.ok(token);
	const dir = control.getTokenDirectory(hashToken(token));
	assert.equal(dir.orgId, "org_a");

	const setup = await fetch(`${base}/api/auth/setup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token, password: "bob-password-123" }),
	});
	const setupBody = await setup.json();
	assert.equal(setup.status, 200, JSON.stringify(setupBody));
	const setupCookie = setup.headers.get("set-cookie") ?? "";
	assert.equal(decodeJwt(setupCookie).org, "org_a");
	assert.equal(db.runWithOrg("org_a", () => db.getAuthUserByEmail("bob@org-a.example.com"))?.email, "bob@org-a.example.com");
	assert.equal(db.runWithOrg("org_b", () => db.getAuthUserByEmail("bob@org-a.example.com")), null);
});

test("device approved by org B lands in org B and ingest stays there", async () => {
	const { cookie } = await login("carol@org-b.example.com", passwordB);
	const created = await fetch(`${base}/api/device-links/requests`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(createLinkPayload()),
	});
	const link = await created.json();
	assert.equal(created.status, 201, JSON.stringify(link));

	const approved = await fetch(`${base}/api/device-links/requests/${link.request_id}/approve`, {
		method: "POST",
		headers: { cookie, "content-type": "application/json" },
		body: "{}",
	});
	const approvedBody = await approved.json();
	assert.equal(approved.status, 200, JSON.stringify(approvedBody));
	assert.equal(approvedBody.state, "approved");
	assert.equal(control.getControlLinkRequest(link.request_id).org_id, "org_b");

	const consumed = await fetch(`${base}/api/device-links/requests/${link.request_id}/consume`, {
		method: "POST",
		headers: { authorization: `Target-Link ${link.polling_credential}` },
	});
	const deviceBody = await consumed.json();
	assert.equal(consumed.status, 201, JSON.stringify(deviceBody));
	const deviceId = deviceBody.device.id;
	const deviceSecret = deviceBody.device_secret;
	assert.equal(control.getDeviceDirectory(deviceId).orgId, "org_b");
	assert.ok(db.runWithOrg("org_b", () => db.getLinkedDevice(deviceId)));
	assert.equal(db.runWithOrg("org_a", () => db.getLinkedDevice(deviceId)), null);

	const eventId = "evt-org-b-only";
	const ingest = await fetch(`${base}/ingest`, {
		method: "POST",
		headers: {
			authorization: `Target-Device v1 ${deviceId}.${deviceSecret}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			instance_id: deviceId,
			version: "1",
			events: [{ id: eventId, kind: "heartbeat", data: {} }],
		}),
	});
	const ingestBody = await ingest.json();
	assert.equal(ingest.status, 200, JSON.stringify(ingestBody));
	assert.deepEqual(eventIds(orgBPath), [eventId]);
	assert.deepEqual(eventIds(orgAPath), []);
	assert.equal(countEvents(path.join(tmpDir, "default.db")), 0);
});

test("token ingest and anonymous register return device_link_required", async () => {
	const ingest = await fetch(`${base}/ingest`, {
		method: "POST",
		headers: { authorization: "Bearer legacy-ingest-token", "content-type": "application/json" },
		body: JSON.stringify({ instance_id: "attacker", events: [] }),
	});
	assert.equal(ingest.status, 401);
	assert.deepEqual(await ingest.json(), { error: "device_link_required" });

	const register = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "attacker" }),
	});
	assert.equal(register.status, 401);
	assert.deepEqual(await register.json(), { error: "device_link_required" });
});

test("booting with TARGET_MULTI_ORG=1 and linking mode other than required exits with a clear error", () => {
	const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-multi-org-boot-"));
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import("./server.mjs");`], {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 15000,
		env: {
			...process.env,
			TARGET_MULTI_ORG: "1",
			TARGET_DEVICE_LINKING_MODE: "optional",
			TARGET_SERVER_DB: path.join(bootDir, "t.db"),
			TARGET_CONTROL_DB: path.join(bootDir, "control.db"),
			HOST: "127.0.0.1",
			PORT: "0",
			TARGET_MAIL_TRANSPORT: "file",
			TARGET_SKIP_UI_STALE_CHECK: "1",
		},
	});
	assert.notEqual(result.status, 0, result.stdout);
	assert.match(result.stderr, /TARGET_MULTI_ORG=1 requires TARGET_DEVICE_LINKING_MODE=required/);
});
