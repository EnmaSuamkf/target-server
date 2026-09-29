import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { DEFAULT_ADMIN_EMAIL, login } from "./helpers.mjs";
import { outboxDir } from "../mailer.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-platform-orgs-"));
process.env.TARGET_SERVER_DB = path.join(tmpDir, "t.db");
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");
process.env.TARGET_MULTI_ORG = "1";
process.env.TARGET_DEVICE_LINKING_MODE = "required";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_PUBLIC_URL = "http://127.0.0.1:8900";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";
process.env.TARGET_SUPERUSER_EMAIL = "platform-su@example.com";

const { server } = await import("../server.mjs");
const control = await import("../control-plane.mjs");
const { PERMISSIONS, ADMIN_ROLE_ID } = await import("../db.mjs");
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

function decodeJwt(cookieHeader) {
	const jwt = decodeURIComponent(cookieHeader.match(/target_auth=([^;]+)/)?.[1] ?? "");
	return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
}

async function superuserCookie() {
	const token = setupTokenFromMail("platform-su@example.com");
	assert.ok(token, "superuser setup token missing from mail");
	const setup = await fetch(
		`${base}/api/auth/setup`,
		json("POST", { token, password: "super-password-12" }),
	);
	if (setup.status === 409) {
		return login(base, { email: "platform-su@example.com", password: "super-password-12" });
	}
	assert.equal(setup.status, 200, await setup.text());
	return (setup.headers.get("set-cookie") ?? "").split(";")[0];
}

let suCookie;
async function su() {
	if (!suCookie) suCookie = await superuserCookie();
	return suCookie;
}

test("non-superuser is 403 on all /api/platform/* routes", async () => {
	const admin = await login(base);
	assert.equal((await fetch(`${base}/api/platform/orgs`, { headers: { cookie: admin } })).status, 403);
	assert.equal((await fetch(`${base}/api/platform/organizations`, { headers: { cookie: admin } })).status, 403);
	assert.equal(
		(await fetch(`${base}/api/platform/orgs`, json("POST", { name: "Nope", slug: "nope", admin_email: "x@example.com" }, admin))).status,
		403,
	);
	assert.equal((await fetch(`${base}/api/platform/orgs/x/admin-invite`, json("POST", {}, admin))).status, 403);
});

test("superuser creates an org with invite; duplicate slug/email 409; list; resend", async () => {
	const cookie = await su();
	const created = await fetch(
		`${base}/api/platform/orgs`,
		json("POST", { name: "Acme Co", slug: "acme-co", admin_email: "admin@acme.example.com" }, cookie),
	);
	assert.equal(created.status, 201);
	const body = await created.json();
	assert.equal(body.org.slug, "acme-co");
	assert.equal(body.org.name, "Acme Co");
	assert.equal(body.org.userCount, 1);
	assert.equal(body.admin.email, "admin@acme.example.com");
	assert.equal(body.admin.role, ADMIN_ROLE_ID);
	assert.equal(body.admin.status, "pending");
	assert.ok(body.invite.setupUrl);
	assert.ok(body.mail.sent);

	const listed = control.getOrganization(body.org.id);
	assert.ok(listed?.dbPath);
	assert.equal(fs.existsSync(listed.dbPath), true);
	const handle = new DatabaseSync(listed.dbPath, { readOnly: true });
	try {
		const role = handle.prepare("SELECT is_system FROM auth_roles WHERE id = ?").get("admin");
		assert.equal(role.is_system, 1);
		const perms = handle.prepare("SELECT COUNT(*) AS n FROM auth_role_permissions WHERE role_id = 'admin'").get().n;
		assert.equal(perms, PERMISSIONS.length);
	} finally {
		handle.close();
	}

	const eml = mailForEmail("admin@acme.example.com")[0];
	assert.ok(eml.includes("Acme Co"));

	const listedRes = await fetch(`${base}/api/platform/orgs`, { headers: { cookie } });
	assert.equal(listedRes.status, 200);
	const listedBody = await listedRes.json();
	assert.ok(listedBody.orgs.some((o) => o.slug === "acme-co" && o.userCount === 1));

	const dupSlug = await fetch(
		`${base}/api/platform/orgs`,
		json("POST", { name: "Acme 2", slug: "acme-co", admin_email: "other@acme.example.com" }, cookie),
	);
	assert.equal(dupSlug.status, 409);
	assert.ok((await dupSlug.json()).errors.some((e) => e.field === "slug"));

	const dupEmail = await fetch(
		`${base}/api/platform/orgs`,
		json("POST", { name: "Beta", slug: "beta-co", admin_email: "admin@acme.example.com" }, cookie),
	);
	assert.equal(dupEmail.status, 201);
	assert.equal((await dupEmail.json()).org.slug, "beta-co");

	const dupSu = await fetch(
		`${base}/api/platform/orgs`,
		json("POST", { name: "Gamma", slug: "gamma-co", admin_email: "platform-su@example.com" }, cookie),
	);
	assert.equal(dupSu.status, 409);
	assert.ok((await dupSu.json()).errors.some((e) => e.field === "admin_email"));

	const resend = await fetch(`${base}/api/platform/orgs/${body.org.id}/admin-invite`, json("POST", {}, cookie));
	assert.equal(resend.status, 200);
	const resendBody = await resend.json();
	assert.ok(resendBody.invite.setupUrl);

	const token = new URL(resendBody.invite.setupUrl).searchParams.get("token");
	const setup = await fetch(`${base}/api/auth/setup`, json("POST", { token, password: "acme-admin-pass-12" }));
	const setupBody = await setup.json();
	assert.equal(setup.status, 200, JSON.stringify(setupBody));
	assert.equal(setupBody.user.email, "admin@acme.example.com");
	assert.ok(setupBody.user.permissions.includes("users.manage"));
	assert.deepEqual([...setupBody.user.permissions].sort(), [...PERMISSIONS].sort());
	const orgCookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];
	assert.equal(decodeJwt(orgCookie).org, body.org.id);

	const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: orgCookie } });
	assert.equal(me.status, 200);
	const meBody = await me.json();
	assert.ok(!meBody.user.superuser);
	assert.ok(meBody.user.permissions.includes("users.manage"));

	assert.equal((await fetch(`${base}/api/platform/orgs`, { headers: { cookie: orgCookie } })).status, 403);

	const users = await (await fetch(`${base}/api/auth/users`, { headers: { cookie: orgCookie } })).json();
	assert.equal(users.users.length, 1);
	assert.equal(users.users[0].email, "admin@acme.example.com");
	assert.equal(
		users.users.some((u) => u.email === DEFAULT_ADMIN_EMAIL),
		false,
	);

	const resendActive = await fetch(`${base}/api/platform/orgs/${body.org.id}/admin-invite`, json("POST", {}, cookie));
	assert.equal(resendActive.status, 409);
	assert.equal((await resendActive.json()).error, "already_activated");
});

test("retry with the same slug succeeds after a leftover file without an org row", async () => {
	const cookie = await su();
	const leftover = path.join(tmpDir, "org-delta-co.db");
	fs.writeFileSync(leftover, "not-a-db");
	const created = await fetch(
		`${base}/api/platform/orgs`,
		json("POST", { name: "Delta", slug: "delta-co", admin_email: "admin@delta.example.com" }, cookie),
	);
	const leftoverBody = await created.json();
	assert.equal(created.status, 201, JSON.stringify(leftoverBody));
	assert.equal(leftoverBody.org.slug, "delta-co");
});
