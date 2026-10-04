/**
 * metricsTemporality defaults to "cumulative" for an organization that never saved an export
 * configuration; rows that already exist stay "delta" and are never rewritten (throwaway databases only).
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-otel-mt-"));
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
const rawRow = () => {
	const raw = new DatabaseSync(dbFile, { readOnly: true });
	try {
		return raw.prepare("SELECT metrics_temporality, updated_at FROM otel_exports WHERE id = 1").get();
	} finally {
		raw.close();
	}
};
const rawTemporality = () => rawRow()?.metrics_temporality;
/** A configuration saved before the column existed: the old table shape with no metrics_temporality, then migrated. */
const preColumnRow = () => {
	inDefault(() => db.deleteOtelConfig());
	db.closeOrgDb(db.DEFAULT_ORG_ID);
	const raw = new DatabaseSync(dbFile);
	raw.exec("DROP TABLE otel_exports");
	raw.exec(`CREATE TABLE otel_exports (
		id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 0, endpoint TEXT NOT NULL DEFAULT '',
		headers_enc TEXT NOT NULL DEFAULT '{}', signals TEXT NOT NULL DEFAULT 'traces,metrics', send_content INTEGER NOT NULL DEFAULT 0,
		langfuse_attrs INTEGER NOT NULL DEFAULT 0, enabled_at TEXT, last_ok_at TEXT, last_error TEXT, updated_at TEXT NOT NULL)`);
	raw.prepare(
		`INSERT INTO otel_exports (id, enabled, endpoint, headers_enc, signals, send_content, langfuse_attrs, updated_at)
		 VALUES (1, 0, 'https://otlp.example.com', '{}', 'traces,metrics', 1, 0, '2026-01-01T00:00:00.000Z')`,
	).run();
	raw.close();
	inDefault(() => db.open()); // runs the migrations
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

test("a never-saved organization reports cumulative and GET creates no row", async () => {
	cookie = await login(base);
	inDefault(() => db.deleteOtelConfig());
	assert.equal((await otel("GET")).body.config.metricsTemporality, "cumulative");
	assert.equal(rawRow(), undefined);
});

test("the first PUT that omits the field stores cumulative", async () => {
	inDefault(() => db.deleteOtelConfig());
	const put = await otel("PUT", { endpoint: "https://otlp.example.com" });
	assert.equal(put.status, 200);
	assert.equal(put.body.config.metricsTemporality, "cumulative");
	assert.equal(rawTemporality(), "cumulative");
});

test("an explicit value on a new configuration is stored, and omitting it later keeps it", async () => {
	inDefault(() => db.deleteOtelConfig());
	assert.equal((await otel("PUT", { endpoint: "https://otlp.example.com", metricsTemporality: "delta" })).body.config.metricsTemporality, "delta");
	assert.equal(rawTemporality(), "delta");
	assert.equal((await otel("PUT", { endpoint: "https://other.example.com" })).body.config.metricsTemporality, "delta");
	assert.equal((await otel("PUT", { metricsTemporality: "cumulative" })).body.config.metricsTemporality, "cumulative");
	assert.equal((await otel("PUT", { endpoint: "https://again.example.com" })).body.config.metricsTemporality, "cumulative");
});

test("a row saved before the column existed reads delta, is not rewritten, and an omitted PUT keeps delta", async () => {
	preColumnRow();
	const before = rawRow();
	assert.equal(before.metrics_temporality, "delta");
	assert.equal(before.updated_at, "2026-01-01T00:00:00.000Z", "migration does not rewrite the row");
	assert.equal((await otel("GET")).body.config.metricsTemporality, "delta");
	assert.equal((await otel("PUT", { endpoint: "https://other.example.com" })).body.config.metricsTemporality, "delta");
	assert.equal(rawTemporality(), "delta");
	// "Restart": run the migrations again on the same file.
	db.closeOrgDb(db.DEFAULT_ORG_ID);
	inDefault(() => db.open());
	assert.equal(rawTemporality(), "delta");
	assert.equal((await otel("PUT", { metricsTemporality: "cumulative" })).body.config.metricsTemporality, "cumulative", "an explicit change still works");
});

test("an existing row keeps cumulative through a restart", async () => {
	inDefault(() => db.deleteOtelConfig());
	await otel("PUT", { endpoint: "https://otlp.example.com" });
	db.closeOrgDb(db.DEFAULT_ORG_ID);
	inDefault(() => db.open());
	assert.equal(rawTemporality(), "cumulative");
});

test("the API rejects unknown temporality values", async () => {
	inDefault(() => db.deleteOtelConfig());
	for (const bad of ["Cumulative", "both", "", 1, null]) {
		const put = await otel("PUT", { endpoint: "https://otlp.example.com", metricsTemporality: bad });
		assert.equal(put.status, 422, JSON.stringify(bad));
	}
	assert.equal(rawRow(), undefined);
});

test("the joi schema leaves metricsTemporality undefined when omitted and accepts only cumulative|delta", () => {
	const omitted = validate("otel.settings", { endpoint: "https://otlp.example.com" });
	assert.equal(omitted.ok, true);
	assert.equal("metricsTemporality" in omitted.value, false);
	assert.equal(validate("otel.settings", { metricsTemporality: "delta" }).value.metricsTemporality, "delta");
	assert.equal(validate("otel.settings", { metricsTemporality: "cumulative" }).ok, true);
	assert.equal(validate("otel.settings", { metricsTemporality: "weekly" }).ok, false);
});
