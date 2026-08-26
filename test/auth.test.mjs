import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD, login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-auth-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

test("login success sets cookie and me works", async () => {
	const cookie = await login(base);
	const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
	assert.equal(me.status, 200);
	const body = await me.json();
	assert.equal(body.user.email, DEFAULT_ADMIN_EMAIL);
});

test("login failure is identical for unknown email", async () => {
	const res = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: "missing@example.com", password: "password-target-server" }),
	});
	assert.equal(res.status, 401);
	assert.deepEqual(await res.json(), { error: "invalid_credentials" });
});

test("Bearer header auth works", async () => {
	const res = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD }),
	});
	const setCookie = res.headers.get("set-cookie") ?? "";
	const jwt = decodeURIComponent(setCookie.match(/target_auth=([^;]+)/)?.[1] ?? "");
	const stats = await fetch(`${base}/api/stats`, { headers: { authorization: `Bearer ${jwt}` } });
	assert.equal(stats.status, 200);
});

test("guarded route 401 without session", async () => {
	const res = await fetch(`${base}/api/stats`);
	assert.equal(res.status, 401);
});

test("health and ingest stay public", async () => {
	assert.equal((await fetch(`${base}/health`)).status, 200);
	const ing = await fetch(`${base}/api/stats`);
	assert.equal(ing.status, 401);
});

test("logout clears session", async () => {
	const cookie = await login(base);
	const out = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } });
	assert.equal(out.status, 204);
	assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie } })).status, 401);
});

test("/login serves SPA shell", async () => {
	const res = await fetch(`${base}/login`);
	assert.equal(res.status, 200);
	assert.match(await res.text(), /<html/i);
});
