import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { login } from "./helpers.mjs";
import { outboxDir } from "../mailer.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-users-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_PUBLIC_URL = "http://127.0.0.1:8900";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

let adminCookie = null;
async function adminSession() {
	if (!adminCookie) adminCookie = await login(base);
	return adminCookie;
}

after(() => server.close());

function mailForEmail(email) {
	return readdirSync(outboxDir())
		.filter((f) => f.endsWith(".eml"))
		.map((f) => readFileSync(path.join(outboxDir(), f), "utf8"))
		.find((t) => t.includes(email));
}

function withGoogleOAuth(fn) {
	const prevId = process.env.TARGET_GOOGLE_CLIENT_ID;
	const prevSec = process.env.TARGET_GOOGLE_CLIENT_SECRET;
	process.env.TARGET_GOOGLE_CLIENT_ID = "test-client-id";
	process.env.TARGET_GOOGLE_CLIENT_SECRET = "test-client-secret";
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			if (prevId === undefined) delete process.env.TARGET_GOOGLE_CLIENT_ID;
			else process.env.TARGET_GOOGLE_CLIENT_ID = prevId;
			if (prevSec === undefined) delete process.env.TARGET_GOOGLE_CLIENT_SECRET;
			else process.env.TARGET_GOOGLE_CLIENT_SECRET = prevSec;
		});
}

test("create user returns invite url and writes mail without password", async () => {
	const cookie = await adminSession();
	const res = await fetch(`${base}/api/auth/users`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ email: "invited@example.com" }),
	});
	assert.equal(res.status, 201);
	const body = await res.json();
	assert.equal(body.user.email, "invited@example.com");
	assert.equal(body.user.status, "pending");
	assert.equal(body.user.inviteAllowPassword, true);
	assert.equal(body.user.inviteAllowGoogle, false);
	assert.ok(body.invite.url.includes("/setup?token="));
	assert.ok(body.mail.sent);

	const eml = mailForEmail("invited@example.com");
	assert.ok(eml);
	assert.ok(eml.includes("/setup?token="));
	assert.ok(!/password:/i.test(eml));
});

test("duplicate email 409", async () => {
	const cookie = await adminSession();
	const res = await fetch(`${base}/api/auth/users`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ email: "invited@example.com" }),
	});
	assert.equal(res.status, 409);
});

test("google-only invite rejected when OAuth not configured", async () => {
	const cookie = await adminSession();
	const res = await fetch(`${base}/api/auth/users`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({
			email: "google-only@example.com",
			activation: { google: true },
		}),
	});
	assert.equal(res.status, 422);
	const body = await res.json();
	assert.ok(body.errors.some((e) => e.field === "activation.google" && e.code === "google_oauth_disabled"));
});

test("google-only invite: API and mail without setup token", async () => {
	await withGoogleOAuth(async () => {
		const cookie = await adminSession();
		const res = await fetch(`${base}/api/auth/users`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({
				email: "google-mail@example.com",
				activation: { google: true },
			}),
		});
		assert.equal(res.status, 201);
		const body = await res.json();
		assert.equal(body.user.inviteAllowPassword, false);
		assert.equal(body.user.inviteAllowGoogle, true);
		assert.equal(body.invite.setupUrl, undefined);
		assert.ok(body.invite.loginUrl?.includes("/login"));
		assert.equal(body.invite.url, undefined);

		const eml = mailForEmail("google-mail@example.com");
		assert.ok(eml);
		assert.match(eml, /Continue with Google/i);
		assert.match(eml, /\/login/);
		assert.doesNotMatch(eml, /\/setup\?token=/);
		assert.doesNotMatch(eml, /Choose your password/i);
	});
});

test("password-only invite: API and mail with setup token, no Google", async () => {
	const cookie = await adminSession();
	const res = await fetch(`${base}/api/auth/users`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({
			email: "password-only@example.com",
			activation: { password: true, google: false },
		}),
	});
	assert.equal(res.status, 201);
	const body = await res.json();
	assert.equal(body.user.inviteAllowPassword, true);
	assert.equal(body.user.inviteAllowGoogle, false);
	assert.ok(body.invite.setupUrl?.includes("/setup?token="));
	assert.equal(body.invite.loginUrl, undefined);

	const eml = mailForEmail("password-only@example.com");
	assert.ok(eml);
	assert.match(eml, /Choose your password/i);
	assert.match(eml, /\/setup\?token=/);
	assert.doesNotMatch(eml, /Continue with Google/i);
});

test("both activation: API and mail include setup and Google", async () => {
	await withGoogleOAuth(async () => {
		const cookie = await adminSession();
		const res = await fetch(`${base}/api/auth/users`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({
				email: "both-methods@example.com",
				activation: { password: true, google: true },
			}),
		});
		assert.equal(res.status, 201);
		const body = await res.json();
		assert.equal(body.user.inviteAllowPassword, true);
		assert.equal(body.user.inviteAllowGoogle, true);
		assert.ok(body.invite.setupUrl?.includes("/setup?token="));
		assert.ok(body.invite.loginUrl?.includes("/login"));

		const eml = mailForEmail("both-methods@example.com");
		assert.ok(eml);
		assert.match(eml, /Choose your password/i);
		assert.match(eml, /\/setup\?token=/);
		assert.match(eml, /Continue with Google/i);
		assert.match(eml, /\/login/);
	});
});

test("resend preserves google-only methods without setup token", async () => {
	await withGoogleOAuth(async () => {
		const cookie = await adminSession();
		const created = await (
			await fetch(`${base}/api/auth/users`, {
				method: "POST",
				headers: { "content-type": "application/json", cookie },
				body: JSON.stringify({
					email: "resend-google@example.com",
					activation: { google: true },
				}),
			})
		).json();
		const userId = created.user.id;

		const resend = await fetch(`${base}/api/auth/users/${userId}/invite`, {
			method: "POST",
			headers: { cookie },
		});
		assert.equal(resend.status, 200);
		const body = await resend.json();
		assert.equal(body.invite.setupUrl, undefined);
		assert.ok(body.invite.loginUrl?.includes("/login"));

		const list = await (await fetch(`${base}/api/auth/users`, { headers: { cookie } })).json();
		const row = list.users.find((u) => u.id === userId);
		assert.equal(row.inviteAllowPassword, false);
		assert.equal(row.inviteAllowGoogle, true);

		const eml = mailForEmail("resend-google@example.com");
		assert.ok(eml);
		assert.doesNotMatch(eml, /\/setup\?token=/);
	});
});

test("resend preserves password-only methods with new setup token", async () => {
	const cookie = await adminSession();
	const created = await (
		await fetch(`${base}/api/auth/users`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({
				email: "resend-password@example.com",
				activation: { password: true, google: false },
			}),
		})
	).json();
	const userId = created.user.id;
	const firstToken = new URL(created.invite.setupUrl).searchParams.get("token");

	const resend = await fetch(`${base}/api/auth/users/${userId}/invite`, {
		method: "POST",
		headers: { cookie },
	});
	assert.equal(resend.status, 200);
	const body = await resend.json();
	assert.ok(body.invite.setupUrl?.includes("/setup?token="));
	assert.equal(body.invite.loginUrl, undefined);
	const secondToken = new URL(body.invite.setupUrl).searchParams.get("token");
	assert.notEqual(firstToken, secondToken);

	const list = await (await fetch(`${base}/api/auth/users`, { headers: { cookie } })).json();
	const row = list.users.find((u) => u.id === userId);
	assert.equal(row.inviteAllowPassword, true);
	assert.equal(row.inviteAllowGoogle, false);
});

test("invalid email 422", async () => {
	const cookie = await adminSession();
	const res = await fetch(`${base}/api/auth/users`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ email: "not-valid" }),
	});
	assert.equal(res.status, 422);
	assert.ok(Array.isArray((await res.json()).errors));
});

test("setup completes invitation and signs in", async () => {
	const cookie = await adminSession();
	const created = await (
		await fetch(`${base}/api/auth/users`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ email: "fresh@example.com" }),
		})
	).json();
	const token = new URL(created.invite.url).searchParams.get("token");
	assert.ok(token);

	const badLogin = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: "fresh@example.com", password: "anything" }),
	});
	assert.equal(badLogin.status, 401);

	const setup = await fetch(`${base}/api/auth/setup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token, password: "secure-pass-12" }),
	});
	assert.equal(setup.status, 200);
	const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: setup.headers.get("set-cookie")?.split(";")[0] ?? "" } });
	assert.equal(me.status, 200);
});

test("cannot delete last user", async () => {
	const cookie = await adminSession();
	const list = await (await fetch(`${base}/api/auth/users`, { headers: { cookie } })).json();
	for (const u of list.users.filter((x) => x.email !== "admin@admin.com")) {
		await fetch(`${base}/api/auth/users/${u.id}`, { method: "DELETE", headers: { cookie } });
	}
	const only = await (await fetch(`${base}/api/auth/users`, { headers: { cookie } })).json();
	assert.equal(only.users.length, 1);
	const res = await fetch(`${base}/api/auth/users/${only.users[0].id}`, { method: "DELETE", headers: { cookie } });
	assert.equal(res.status, 409);
	assert.equal((await res.json()).error, "last_user");
});
