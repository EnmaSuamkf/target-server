/**
 * One email may belong to many orgs. Org is chosen after auth, never from the body.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { outboxDir } from "../mailer.mjs";
import { login as loginHelper } from "./helpers.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-org-memberships-"));
process.env.TARGET_SERVER_DB = path.join(tmpDir, "t.db");
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");
process.env.TARGET_MULTI_ORG = "1";
process.env.TARGET_DEVICE_LINKING_MODE = "required";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_PUBLIC_URL = "http://127.0.0.1:8900";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";
process.env.TARGET_SUPERUSER_EMAIL = "mem-su@example.com";

const { server } = await import("../server.mjs");
const control = await import("../control-plane.mjs");
const { signJwt } = await import("../auth.mjs");
const { getJwtSecret } = await import("../db.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const json = (method, body, cookie) => ({
	method,
	headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
	body: body == null ? undefined : JSON.stringify(body),
});

function mailForEmail(email) {
	return readdirSync(outboxDir())
		.filter((f) => f.endsWith(".eml"))
		.sort()
		.reverse()
		.map((f) => readFileSync(path.join(outboxDir(), f), "utf8"))
		.filter((t) => t.includes(email));
}

function setupTokenFromMail(email) {
	for (const text of mailForEmail(email)) {
		const m = text.match(/\/setup\?token=([A-Fa-f0-9]+)/);
		if (m) return m[1];
	}
	return null;
}

async function superuserCookie() {
	const token = setupTokenFromMail("mem-su@example.com");
	assert.ok(token, "superuser setup token missing");
	const setup = await fetch(`${base}/api/auth/setup`, json("POST", { token, password: "super-password-12" }));
	if (setup.status === 409) {
		return loginHelper(base, { email: "mem-su@example.com", password: "super-password-12" });
	}
	assert.equal(setup.status, 200, await setup.text());
	return (setup.headers.get("set-cookie") ?? "").split(";")[0];
}

function insertOrgEvent(orgId, eventId, workflowId) {
	const org = control.getOrganization(orgId);
	const handle = new DatabaseSync(org.dbPath);
	const now = new Date().toISOString();
	try {
		handle.prepare(
			`INSERT OR IGNORE INTO instances (instance_id, display_name, version, first_seen_at, last_seen_at, events_count)
			 VALUES (?, 'hub', '1.0', ?, ?, 1)`,
		).run(`dev-${eventId}`, now, now);
		handle.prepare(
			`INSERT OR IGNORE INTO events (id, instance_id, kind, workflow_id, created_at, received_at, data)
			 VALUES (?, ?, 'workflow.created', ?, ?, ?, '{}')`,
		).run(eventId, `dev-${eventId}`, workflowId, now, now);
	} finally {
		handle.close();
	}
}

test("one email can admin two orgs with an explicit org switch", async () => {
	const su = await superuserCookie();
	const shared = "shared-admin@example.com";
	const alpha = await fetch(
		`${base}/api/platform/orgs`,
		json("POST", { name: "Alpha", slug: "mem-alpha", admin_email: shared }, su),
	);
	const alphaBody = await alpha.json();
	assert.equal(alpha.status, 201, JSON.stringify(alphaBody));
	const token = setupTokenFromMail(shared);
	assert.ok(token);
	const setup = await fetch(`${base}/api/auth/setup`, json("POST", { token, password: "shared-pass-12xx" }));
	assert.equal(setup.status, 200, await setup.text());

	const beta = await fetch(
		`${base}/api/platform/orgs`,
		json("POST", { name: "Beta", slug: "mem-beta", admin_email: shared }, su),
	);
	const betaBody = await beta.json();
	assert.equal(beta.status, 201, JSON.stringify(betaBody));
	assert.notEqual(betaBody.org.id, alphaBody.org.id);

	insertOrgEvent(alphaBody.org.id, "evt-alpha-only", "wf-alpha");
	insertOrgEvent(betaBody.org.id, "evt-beta-only", "wf-beta");

	const loginRes = await fetch(
		`${base}/api/auth/login`,
		json("POST", { email: shared, password: "shared-pass-12xx", org_id: betaBody.org.id }),
	);
	assert.equal(loginRes.status, 200);
	const loginBody = await loginRes.json();
	assert.equal(loginBody.selectOrg, true);
	assert.ok(loginBody.selectToken);
	assert.ok(loginBody.organizations.some((o) => o.id === alphaBody.org.id));
	assert.ok(loginBody.organizations.some((o) => o.id === betaBody.org.id));
	assert.ok(!(loginRes.headers.get("set-cookie") ?? "").includes("target_auth="));

	const forbidden = await fetch(
		`${base}/api/auth/select-org`,
		json("POST", { org_id: "not-a-member-org", token: loginBody.selectToken }),
	);
	assert.equal(forbidden.status, 403, await forbidden.text());

	const picked = await fetch(
		`${base}/api/auth/select-org`,
		json("POST", { org_id: alphaBody.org.id, token: loginBody.selectToken }),
	);
	const pickedBody = await picked.json();
	assert.equal(picked.status, 200, JSON.stringify(pickedBody));
	const alphaCookie = (picked.headers.get("set-cookie") ?? "").split(";")[0];
	const meAlpha = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: alphaCookie } })).json();
	assert.equal(meAlpha.user.org.id, alphaBody.org.id);
	assert.ok(meAlpha.user.permissions.includes("users.manage"));
	assert.equal(meAlpha.user.organizations.length, 2);

	const alphaEvents = await (await fetch(`${base}/api/events`, { headers: { cookie: alphaCookie } })).json();
	assert.ok(alphaEvents.events.some((e) => e.id === "evt-alpha-only"));
	assert.ok(!alphaEvents.events.some((e) => e.id === "evt-beta-only"));

	const invite = await fetch(
		`${base}/api/auth/users`,
		json("POST", { email: "only-in-alpha@example.com", role_id: "admin" }, alphaCookie),
	);
	assert.equal(invite.status, 201, JSON.stringify(await invite.json()));

	const usersAlpha = await (await fetch(`${base}/api/auth/users`, { headers: { cookie: alphaCookie } })).json();
	assert.ok(usersAlpha.users.some((u) => u.email === "only-in-alpha@example.com"));

	const switched = await fetch(
		`${base}/api/auth/select-org`,
		json("POST", { org_id: betaBody.org.id }, alphaCookie),
	);
	const switchedBody = await switched.json();
	assert.equal(switched.status, 200, JSON.stringify(switchedBody));
	const betaCookie = (switched.headers.get("set-cookie") ?? "").split(";")[0];
	const meBeta = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: betaCookie } })).json();
	assert.equal(meBeta.user.org.id, betaBody.org.id);

	const betaEvents = await (await fetch(`${base}/api/events`, { headers: { cookie: betaCookie } })).json();
	assert.ok(betaEvents.events.some((e) => e.id === "evt-beta-only"));
	assert.ok(!betaEvents.events.some((e) => e.id === "evt-alpha-only"));

	const usersBeta = await (await fetch(`${base}/api/auth/users`, { headers: { cookie: betaCookie } })).json();
	assert.ok(!usersBeta.users.some((u) => u.email === "only-in-alpha@example.com"));

	const tamper = signJwt(
		{
			sub: meBeta.user.id,
			email: shared,
			role: "admin",
			org: alphaBody.org.id,
			tv: 1,
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 3600,
		},
		getJwtSecret(),
	);
	const tampered = await fetch(`${base}/api/auth/me`, { headers: { cookie: `target_auth=${tamper}` } });
	assert.equal(tampered.status, 401);
});

test("single-membership login still sets a session cookie immediately", async () => {
	const cookie = await loginHelper(base);
	assert.ok(cookie.includes("target_auth="));
	const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json();
	assert.equal(me.user.email, "admin@admin.com");
	assert.ok(me.user.org);
	assert.ok(me.user.organizations.length >= 1);
});

test("v1 user_directory email primary key migrates without wiping", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "target-v1-control-"));
	const controlPath = path.join(dir, "control.db");
	const db = new DatabaseSync(controlPath);
	db.exec(`
		CREATE TABLE organizations (
			id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active', db_path TEXT NOT NULL,
			created_at TEXT NOT NULL, created_by TEXT
		);
		CREATE TABLE user_directory (
			email TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL
		);
		INSERT INTO organizations (id, slug, name, db_path, created_at)
		VALUES ('default', 'default', 'Default', 'x.db', '2026-01-01T00:00:00.000Z');
		INSERT INTO user_directory (email, org_id, user_id) VALUES ('legacy@example.com', 'default', 'u1');
		PRAGMA user_version = 1;
	`);
	db.close();
	const root = path.dirname(fileURLToPath(import.meta.url));
	const script = `
		process.env.TARGET_CONTROL_DB = ${JSON.stringify(controlPath)};
		process.env.TARGET_SERVER_DB = ${JSON.stringify(path.join(dir, "x.db"))};
		const c = await import(${JSON.stringify(path.join(root, "../control-plane.mjs"))});
		c.openControlDb();
		const rows = c.listMembershipsByEmail("legacy@example.com");
		if (rows.length !== 1 || rows[0].orgId !== "default") process.exit(1);
	`;
	execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
});
