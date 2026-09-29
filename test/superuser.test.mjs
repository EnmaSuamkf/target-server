import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from "./helpers.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

test("no PERMISSIONS id grants platform capabilities", async () => {
	const { PERMISSIONS } = await import("../db.mjs");
	for (const id of PERMISSIONS) {
		assert.equal(id.startsWith("platform."), false, id);
		assert.doesNotMatch(id, /superuser/i);
		assert.doesNotMatch(id, /platform/i);
	}
});

function runScript(script, env, timeout = 25000) {
	return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: ROOT,
		env: { ...process.env, ...env },
		encoding: "utf8",
		timeout,
	});
}

test("superuser bootstrap via TARGET_SUPERUSER_EMAIL, /me, and org admin 403 on platform routes", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-superuser-"));
	const dbPath = path.join(tmpDir, "t.db");
	const result = runScript(
		`
		import { once } from "node:events";
		import { readdirSync, readFileSync } from "node:fs";
		import { join } from "node:path";
		const { server } = await import("./server.mjs");
		const control = await import("./control-plane.mjs");
		const { outboxDir } = await import("./mailer.mjs");
		if (!server.listening) await once(server, "listening");
		const base = "http://127.0.0.1:" + server.address().port;
		const pending = control.getSuperuserByEmail("super@example.com");
		let token = null;
		for (const file of readdirSync(outboxDir()).filter((f) => f.endsWith(".eml"))) {
			const text = readFileSync(join(outboxDir(), file), "utf8");
			if (!text.includes("super@example.com")) continue;
			const m = text.match(/\\/setup\\?token=([A-Fa-f0-9]+)/);
			if (m) token = m[1];
		}
		const setup = await fetch(base + "/api/auth/setup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, password: "super-password-12" }),
		});
		const setupBody = await setup.json();
		const suCookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];
		const me = await fetch(base + "/api/auth/me", { headers: { cookie: suCookie } });
		const meBody = await me.json();
		const login = await fetch(base + "/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: "super@example.com", password: "super-password-12" }),
		});
		const loginBody = await login.json();
		const adminLogin = await fetch(base + "/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				email: ${JSON.stringify(DEFAULT_ADMIN_EMAIL)},
				password: ${JSON.stringify(DEFAULT_ADMIN_PASSWORD)},
			}),
		});
		const adminCookie = (adminLogin.headers.get("set-cookie") ?? "").split(";")[0];
		const adminPlatform = await fetch(base + "/api/platform/organizations", { headers: { cookie: adminCookie } });
		const suPlatform = await fetch(base + "/api/platform/organizations", { headers: { cookie: suCookie } });
		await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
		console.log("SUPERUSER_TEST:" + JSON.stringify({
			pendingHadPassword: Boolean(pending?.passwordHash),
			tokenFound: Boolean(token),
			setupStatus: setup.status,
			setupUser: setupBody.user,
			meStatus: me.status,
			meUser: meBody.user,
			loginStatus: login.status,
			loginUser: loginBody.user,
			adminLogin: adminLogin.status,
			adminPlatform: adminPlatform.status,
			suPlatform: suPlatform.status,
		}));
		`,
		{
			HOST: "127.0.0.1",
			PORT: "0",
			TARGET_SERVER_DB: dbPath,
			TARGET_CONTROL_DB: path.join(tmpDir, "control.db"),
			TARGET_MAIL_TRANSPORT: "file",
			TARGET_PUBLIC_URL: "http://127.0.0.1:8900",
			TARGET_SKIP_UI_STALE_CHECK: "1",
			TARGET_SUPERUSER_EMAIL: "super@example.com",
		},
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /superuser setup:/);
	const line = result.stdout
		.split("\n")
		.map((row) => row.trim())
		.find((row) => row.startsWith("SUPERUSER_TEST:"));
	assert.ok(line, result.stdout);
	const body = JSON.parse(line.slice("SUPERUSER_TEST:".length));
	assert.equal(body.pendingHadPassword, false);
	assert.equal(body.tokenFound, true);
	assert.equal(body.setupStatus, 200);
	assert.equal(body.setupUser.superuser, true);
	assert.equal(body.setupUser.email, "super@example.com");
	assert.deepEqual(body.setupUser.permissions, []);
	assert.equal(body.meStatus, 200);
	assert.equal(body.meUser.superuser, true);
	assert.deepEqual(body.meUser.permissions, []);
	assert.equal(body.loginStatus, 200);
	assert.equal(body.loginUser.superuser, true);
	assert.equal(body.adminLogin, 200);
	assert.equal(body.adminPlatform, 403);
	assert.equal(body.suPlatform, 200);

	const handle = new DatabaseSync(path.join(tmpDir, "control.db"), { readOnly: true });
	try {
		const row = handle.prepare("SELECT password_hash FROM superusers WHERE email = ?").get("super@example.com");
		assert.ok(row.password_hash);
		assert.notEqual(row.password_hash, DEFAULT_ADMIN_PASSWORD);
	} finally {
		handle.close();
	}
});
