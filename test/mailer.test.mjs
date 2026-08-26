import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isLoopbackHost } from "../boot-guards.mjs";

test("loopback detection", () => {
	assert.equal(isLoopbackHost("127.0.0.1"), true);
	assert.equal(isLoopbackHost("0.0.0.0"), false);
});

test("refuses public bind without TARGET_SMTP_URL", () => {
	const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-boot-")), "t.db");
	const r = spawnSync(process.execPath, ["server.mjs"], {
		cwd: new URL("..", import.meta.url).pathname,
		env: {
			...process.env,
			HOST: "0.0.0.0",
			PORT: "0",
			TARGET_SERVER_DB: tmpDb,
			TARGET_PUBLIC_URL: "https://target.example.com",
			TARGET_SEED_ADMIN_PASSWORD: "not-the-default-password",
			TARGET_SMTP_URL: "",
			TARGET_ALLOW_FILE_MAIL: "",
		},
		encoding: "utf8",
		timeout: 5000,
	});
	assert.notEqual(r.status, 0);
	assert.match(r.stderr + r.stdout, /TARGET_SMTP_URL/);
});

test("loopback bind starts with file mail transport", () => {
	const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-boot-")), "t.db");
	const r = spawnSync(process.execPath, ["-e", "import('./server.mjs').then(m => m.server.close())"], {
		cwd: new URL("..", import.meta.url).pathname,
		env: {
			...process.env,
			HOST: "127.0.0.1",
			PORT: "0",
			TARGET_SERVER_DB: tmpDb,
			TARGET_MAIL_TRANSPORT: "file",
		},
		encoding: "utf8",
		timeout: 8000,
	});
	assert.equal(r.status, 0, r.stderr || r.stdout);
});
