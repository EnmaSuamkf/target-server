/**
 * Send content defaults to ON for an organization that never saved an export
 * configuration, and no stored choice is ever changed (throwaway databases only).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns/promises";
import test, { after, mock } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { login } from "./helpers.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-otel-sc-"));
const dbFile = path.join(tmpDir, "default.db");
process.env.TARGET_SERVER_DB = dbFile;
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_SECRETS_KEY = randomBytes(32).toString("hex");

// No real DNS in tests.
mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);

const { server } = await import("../server.mjs");
const db = await import("../db.mjs");
const { validate } = await import("../blueprint.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const inDefault = (fn) => db.runWithOrg(db.DEFAULT_ORG_ID, fn);
const rawSendContent = () => {
	const raw = new DatabaseSync(dbFile, { readOnly: true });
	try {
		return raw.prepare("SELECT send_content FROM otel_exports WHERE id = 1").get()?.send_content;
	} finally {
		raw.close();
	}
};
/** A configuration saved by an older version: written straight into the table. */
const legacyRow = (sendContent) => {
	inDefault(() => db.deleteOtelConfig());
	const raw = new DatabaseSync(dbFile);
	raw.prepare(
		`INSERT INTO otel_exports (id, enabled, endpoint, headers_enc, signals, send_content, langfuse_attrs, updated_at)
		 VALUES (1, 0, 'https://otlp.example.com', '{}', 'traces,metrics', ?, 0, '2026-01-01T00:00:00.000Z')`,
	).run(sendContent);
	raw.close();
};

let cookie;
const otel = async (method, body) => {
	const res = await fetch(`${base}/api/settings/otel`, {
		method,
		headers: { "content-type": "application/json", cookie },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() };
};

test("a new organization reports and stores send_content true", async () => {
	cookie = await login(base);
	inDefault(() => db.deleteOtelConfig());
	assert.equal((await otel("GET")).body.config.sendContent, true);
	assert.equal(rawSendContent(), undefined, "GET does not create a row");
	const put = await otel("PUT", { endpoint: "https://otlp.example.com" });
	assert.equal(put.status, 200);
	assert.equal(put.body.config.sendContent, true);
	assert.equal(rawSendContent(), 1);
});

test("an explicit false on a new configuration is stored false", async () => {
	inDefault(() => db.deleteOtelConfig());
	const put = await otel("PUT", { endpoint: "https://otlp.example.com", sendContent: false });
	assert.equal(put.body.config.sendContent, false);
	assert.equal(rawSendContent(), 0);
	assert.equal((await otel("PUT", { endpoint: "https://otlp.example.com" })).body.config.sendContent, false, "omitting it later keeps false");
});

test("an existing row with 0 stays 0 through GET, PUT without the field and a restart", async () => {
	legacyRow(0);
	assert.equal((await otel("GET")).body.config.sendContent, false);
	assert.equal(rawSendContent(), 0);
	assert.equal((await otel("PUT", { endpoint: "https://other.example.com" })).body.config.sendContent, false);
	assert.equal(rawSendContent(), 0);
	// "Restart": drop the cached handle so the migrations run again on the same file.
	db.closeOrgDb(db.DEFAULT_ORG_ID);
	inDefault(() => db.open());
	assert.equal(rawSendContent(), 0);
	assert.equal((await otel("GET")).body.config.sendContent, false);
});

test("an existing row with 1 stays 1", async () => {
	legacyRow(1);
	assert.equal((await otel("PUT", { endpoint: "https://other.example.com" })).body.config.sendContent, true);
	assert.equal(rawSendContent(), 1);
	assert.equal((await otel("PUT", { sendContent: false })).body.config.sendContent, false, "an explicit change still works");
});

test("applying the migrations twice is a no-op on the otel tables", () => {
	const schema = () => {
		const raw = new DatabaseSync(dbFile, { readOnly: true });
		try {
			return raw.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'otel_%' ORDER BY name").all().map((r) => `${r.name}:${r.sql}`);
		} finally {
			raw.close();
		}
	};
	legacyRow(0);
	const before = schema();
	for (let i = 0; i < 2; i++) {
		db.closeOrgDb(db.DEFAULT_ORG_ID);
		inDefault(() => db.open());
	}
	assert.deepEqual(schema(), before);
	assert.equal(rawSendContent(), 0);
});

test("the joi schema leaves sendContent undefined when omitted (no hidden default)", () => {
	const omitted = validate("otel.settings", { endpoint: "https://otlp.example.com" });
	assert.equal(omitted.ok, true);
	assert.equal("sendContent" in omitted.value, false);
	assert.equal(validate("otel.settings", { sendContent: false }).value.sendContent, false);
	assert.equal(validate("otel.settings", { sendContent: "yes please" }).ok, false);
});
