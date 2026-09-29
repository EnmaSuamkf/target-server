import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from "./helpers.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SEEDED = "unique-seed-password-X";
const CHANGED = "admin-changed-password-Y";

function tmpDb() {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-seed-")), "t.db");
}

function childEnv(overrides) {
	const env = { ...process.env, ...overrides };
	delete env.TARGET_USE_PUBLISHED_ADMIN;
	if (!Object.hasOwn(overrides, "TARGET_SEED_ADMIN_PASSWORD")) {
		delete env.TARGET_SEED_ADMIN_PASSWORD;
	}
	return env;
}

function runScript(script, env, timeout = 15000) {
	return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: ROOT,
		env: childEnv(env),
		encoding: "utf8",
		timeout,
	});
}

function parseMarker(stdout) {
	const line = stdout
		.split("\n")
		.map((row) => row.trim())
		.find((row) => row.startsWith("SEED_PASSWORD_TEST:"));
	assert.ok(line, `missing SEED_PASSWORD_TEST marker in stdout:\n${stdout}`);
	return JSON.parse(line.slice("SEED_PASSWORD_TEST:".length));
}

function loginScript(passwords) {
	return `
		import { once } from "node:events";
		const { server } = await import("./server.mjs");
		if (!server.listening) await once(server, "listening");
		const port = server.address().port;
		const statuses = {};
		for (const [name, password] of Object.entries(${JSON.stringify(passwords)})) {
			const res = await fetch("http://127.0.0.1:" + port + "/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email: ${JSON.stringify(DEFAULT_ADMIN_EMAIL)}, password }),
			});
			statuses[name] = res.status;
		}
		await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
		console.log("SEED_PASSWORD_TEST:" + JSON.stringify(statuses));
	`;
}

test("RENDER=true honors TARGET_SEED_ADMIN_PASSWORD on first seed", () => {
	const dbPath = tmpDb();
	const result = runScript(
		loginScript({ seed: SEEDED, published: DEFAULT_ADMIN_PASSWORD }),
		{
			HOST: "127.0.0.1",
			PORT: "0",
			TARGET_SERVER_DB: dbPath,
			TARGET_MAIL_TRANSPORT: "file",
			TARGET_SKIP_UI_STALE_CHECK: "1",
			RENDER: "true",
			TARGET_SEED_ADMIN_PASSWORD: SEEDED,
		},
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const statuses = parseMarker(result.stdout);
	assert.equal(statuses.seed, 200);
	assert.equal(statuses.published, 401);
});

test("admin-changed password survives restart and seedAuth re-open", () => {
	const dbPath = tmpDb();
	const seed = runScript(
		`
			const { open, getAuthUserByEmail, setUserPassword, DEFAULT_ADMIN_EMAIL } = await import("./db.mjs");
			const { hashPassword } = await import("./auth.mjs");
			open(process.env.TARGET_SERVER_DB);
			const user = getAuthUserByEmail(DEFAULT_ADMIN_EMAIL);
			if (!user) throw new Error("seeded admin missing");
			setUserPassword(user.id, await hashPassword(${JSON.stringify(CHANGED)}));
		`,
		{
			TARGET_SERVER_DB: dbPath,
			RENDER: "true",
			TARGET_SEED_ADMIN_PASSWORD: SEEDED,
		},
	);
	assert.equal(seed.status, 0, seed.stderr || seed.stdout);

	const restarted = runScript(
		loginScript({ changed: CHANGED, seed: SEEDED, published: DEFAULT_ADMIN_PASSWORD }),
		{
			HOST: "127.0.0.1",
			PORT: "0",
			TARGET_SERVER_DB: dbPath,
			TARGET_MAIL_TRANSPORT: "file",
			TARGET_SKIP_UI_STALE_CHECK: "1",
			RENDER: "true",
			TARGET_SEED_ADMIN_PASSWORD: SEEDED,
		},
	);
	assert.equal(restarted.status, 0, restarted.stderr || restarted.stdout);
	const statuses = parseMarker(restarted.stdout);
	assert.equal(statuses.changed, 200);
	assert.equal(statuses.seed, 401);
	assert.equal(statuses.published, 401);
});

test("boot guard refuses public bind with default password even when RENDER=true", () => {
	const dbPath = tmpDb();
	const result = spawnSync(process.execPath, ["server.mjs"], {
		cwd: ROOT,
		env: childEnv({
			HOST: "0.0.0.0",
			PORT: "0",
			TARGET_SERVER_DB: dbPath,
			TARGET_PUBLIC_URL: "https://target.example.com",
			TARGET_ALLOW_FILE_MAIL: "1",
			TARGET_SMTP_URL: "",
			RENDER: "true",
			TARGET_SKIP_UI_STALE_CHECK: "1",
		}),
		encoding: "utf8",
		timeout: 8000,
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr + result.stdout, /published default password/);
});
