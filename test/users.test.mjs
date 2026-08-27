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

after(() => server.close());

test("create user returns invite url and writes mail without password", async () => {
	const cookie = await login(base);
	const res = await fetch(`${base}/api/auth/users`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ email: "invited@example.com" }),
	});
	assert.equal(res.status, 201);
	const body = await res.json();
	assert.equal(body.user.email, "invited@example.com");
	assert.equal(body.user.status, "pending");
	assert.ok(body.invite.url.includes("/setup?token="));
	assert.ok(body.mail.sent);

	const eml = readdirSync(outboxDir())
		.filter((f) => f.endsWith(".eml"))
		.map((f) => readFileSync(path.join(outboxDir(), f), "utf8"))
		.find((t) => t.includes("invited@example.com"));
	assert.ok(eml);
	assert.ok(eml.includes("/setup?token="));
	assert.ok(!/password:/i.test(eml));
});

test("duplicate email 409", async () => {
	const cookie = await login(base);
	const res = await fetch(`${base}/api/auth/users`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ email: "invited@example.com" }),
	});
	assert.equal(res.status, 409);
});

test("invalid email 422", async () => {
	const cookie = await login(base);
	const res = await fetch(`${base}/api/auth/users`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ email: "not-valid" }),
	});
	assert.equal(res.status, 422);
	assert.ok(Array.isArray((await res.json()).errors));
});

test("setup completes invitation and signs in", async () => {
	const cookie = await login(base);
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
	const cookie = await login(base);
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
