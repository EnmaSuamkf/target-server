/**
 * OpenTelemetry export storage: idempotent migration, encrypted header
 * round-trip, outbox lifecycle, export state and per-organization isolation.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-otel-db-"));
process.env.TARGET_SERVER_DB = path.join(tmpDir, "default.db");
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");
process.env.TARGET_SECRETS_KEY = randomBytes(32).toString("hex");
delete process.env.TARGET_SECRETS_KEY_PREVIOUS;

const db = await import("../db.mjs");
const { DEFAULT_ORG_ID, runWithOrg } = db;
const otherDb = path.join(tmpDir, "other.db");
const inDefault = (fn) => runWithOrg(DEFAULT_ORG_ID, fn);
const inOther = (fn) => runWithOrg("org-other", fn, { dbPath: otherDb });

const TOKEN = "Bearer sk-PLAINTEXT-abcd1234";
const OTHER_TOKEN = "other-secret-wxyz9876";
const rawRow = (file) => {
	const raw = new DatabaseSync(file, { readOnly: true });
	try {
		return raw.prepare("SELECT headers_enc FROM otel_exports WHERE id = 1").get();
	} finally {
		raw.close();
	}
};

test("migration is idempotent on an existing database file", () => {
	inDefault(() => db.open());
	db.closeOrgDb(DEFAULT_ORG_ID);
	// Re-open the same file: every CREATE ... IF NOT EXISTS runs a second time.
	assert.doesNotThrow(() => inDefault(() => db.open()));
	inDefault(() => {
		const tables = db
			.open()
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'otel_%' ORDER BY name")
			.all()
			.map((r) => r.name);
		assert.deepEqual(tables, ["otel_export_state", "otel_exports", "otel_outbox"]);
		assert.equal(db.getOtelConfig(), null);
	});
});

test("config round-trips encrypted; raw column never holds plaintext", () => {
	inDefault(() => {
		const saved = db.saveOtelConfig({
			enabled: false,
			endpoint: "https://otlp.example.com",
			headers: { Authorization: TOKEN },
			signals: ["traces"],
			sendContent: true,
		});
		assert.deepEqual(saved.headers, [{ name: "Authorization", masked: "••••1234" }]);
		assert.equal(saved.endpoint, "https://otlp.example.com");
		assert.deepEqual(saved.signals, ["traces"]);
		assert.equal(saved.sendContent, true);
		assert.equal(saved.langfuseAttrs, false);
		assert.equal(saved.enabled, false);
		assert.equal(saved.enabledAt, null);
		assert.deepEqual(db.getOtelConfig({ includeSecrets: true }).headers, { Authorization: TOKEN });
		assert.ok(!JSON.stringify(saved).includes("PLAINTEXT"));
	});
	const raw = rawRow(process.env.TARGET_SERVER_DB).headers_enc;
	assert.match(raw, /"Authorization":"v1:/);
	assert.ok(!raw.includes("PLAINTEXT") && !raw.includes("abcd1234") && !raw.includes(TOKEN));
});

test("omitted header value keeps the stored secret; unlisted headers are removed", () => {
	inDefault(() => {
		const before = rawRow(process.env.TARGET_SERVER_DB).headers_enc;
		db.saveOtelConfig({ headers: { Authorization: "", "X-Extra": "extra-value-0001" } });
		assert.deepEqual(db.getOtelConfig({ includeSecrets: true }).headers, { Authorization: TOKEN, "X-Extra": "extra-value-0001" });
		assert.equal(JSON.parse(rawRow(process.env.TARGET_SERVER_DB).headers_enc).Authorization, JSON.parse(before).Authorization);
		// Not touching headers at all keeps them too.
		db.saveOtelConfig({ endpoint: "https://otlp2.example.com" });
		assert.equal(db.getOtelConfig().headers.length, 2);
		db.saveOtelConfig({ headers: { Authorization: undefined } });
		assert.deepEqual(db.getOtelConfig({ includeSecrets: true }).headers, { Authorization: TOKEN });
		assert.throws(() => db.saveOtelConfig({ headers: { Brand: null } }), (e) => e.code === "header_value_required");
	});
});

test("enabled_at is stamped when switched on, kept while on, reset on re-enable", async () => {
	inDefault(() => {
		const on = db.saveOtelConfig({ enabled: true });
		assert.equal(on.enabled, true);
		assert.ok(on.enabledAt);
		db.saveOtelConfig({ endpoint: "https://otlp3.example.com" });
		assert.equal(db.getOtelConfig().enabledAt, on.enabledAt);
		db.saveOtelConfig({ enabled: false });
		assert.equal(db.getOtelConfig().enabled, false);
	});
	await new Promise((r) => setTimeout(r, 5));
	inDefault(() => {
		const again = db.saveOtelConfig({ enabled: true });
		assert.ok(again.enabledAt);
		db.saveOtelConfig({ enabled: false });
	});
});

test("enabling or writing secrets fails closed without a key", () => {
	const key = process.env.TARGET_SECRETS_KEY;
	delete process.env.TARGET_SECRETS_KEY;
	try {
		inDefault(() => {
			assert.throws(() => db.saveOtelConfig({ enabled: true }), (e) => e.code === "secrets_unavailable");
			assert.throws(() => db.saveOtelConfig({ headers: { New: "value-12345" } }), (e) => e.code === "secrets_unavailable");
			// Reading masked config still works; unreadable headers show as masked placeholders.
			assert.deepEqual(db.getOtelConfig().headers, [{ name: "Authorization", masked: "••••" }]);
			assert.deepEqual(db.getOtelConfig({ includeSecrets: true }).headers, {});
		});
	} finally {
		process.env.TARGET_SECRETS_KEY = key;
	}
});

test("outbox: enqueue is idempotent, claim honours due time, marks and prune", () => {
	inDefault(() => {
		const t0 = "2026-01-01T00:00:00.000Z";
		assert.equal(db.enqueueOtelEvent("e1", "step.done", t0), true);
		assert.equal(db.enqueueOtelEvent("e1", "step.done", t0), false);
		db.enqueueOtelEvent("e2", "usage.snapshot", t0);
		db.enqueueOtelEvent("e3", "step.done", "2026-01-01T00:10:00.000Z");
		let batch = db.claimOtelOutboxBatch(10, "2026-01-01T00:05:00.000Z");
		assert.deepEqual(batch.map((r) => r.eventId), ["e1", "e2"]);
		assert.equal(db.claimOtelOutboxBatch(1, "2026-01-01T01:00:00.000Z").length, 1);

		db.markOtelRetry([batch[0].id], "2026-01-01T00:06:00.000Z");
		batch = db.claimOtelOutboxBatch(10, "2026-01-01T00:05:30.000Z");
		assert.deepEqual(batch.map((r) => r.eventId), ["e2"]);
		const later = db.claimOtelOutboxBatch(10, "2026-01-01T00:07:00.000Z");
		assert.equal(later.find((r) => r.eventId === "e1").attempts, 1);

		db.markOtelSent([later.find((r) => r.eventId === "e1").id]);
		db.markOtelDead([later.find((r) => r.eventId === "e2").id]);
		assert.deepEqual(db.otelOutboxCounts(), { pending: 1, sent: 1, dead: 1 });
		assert.deepEqual(db.claimOtelOutboxBatch(10, "2026-02-01T00:00:00.000Z").map((r) => r.eventId), ["e3"]);

		// e1/e2 are older than 7 days at this "now"; e3 (created 10 minutes later) is too, so use a tighter cut.
		const removed = db.pruneOtelOutbox(7, new Date("2026-01-08T00:05:00.000Z"));
		assert.equal(removed, 2);
		assert.deepEqual(db.otelOutboxCounts(), { pending: 1, sent: 0, dead: 0 });
		assert.equal(db.pruneOtelOutbox(7, new Date("2026-01-08T00:11:00.000Z")), 1);
	});
});

test("export state upserts, and markOtelSent writes state in one transaction", () => {
	inDefault(() => {
		assert.equal(db.getOtelExportState("wf", "s1"), null);
		db.setOtelExportState("wf", "s1", { tokens: { input: 10, output: 5, cache_read: 2, cache_creation: 1 }, costUsd: 0.5 });
		assert.deepEqual(db.getOtelExportState("wf", "s1"), {
			tokens: { input: 10, output: 5, cache_read: 2, cache_creation: 1 },
			costUsd: 0.5,
		});
		const t = "2026-03-01T00:00:00.000Z";
		db.enqueueOtelEvent("s-e1", "usage.snapshot", t);
		const [row] = db.claimOtelOutboxBatch(10, t);
		db.markOtelSent([row.id], [{ workflowId: "wf", sessionId: null, state: { tokens: { input: 99 }, costUsd: 2 } }]);
		assert.equal(db.getOtelExportState("wf", null).tokens.input, 99);
		assert.equal(db.getOtelExportState("wf", "s1").tokens.input, 10);
		// A failing state write rolls the status change back.
		db.enqueueOtelEvent("s-e2", "usage.snapshot", t);
		const [row2] = db.claimOtelOutboxBatch(10, t);
		assert.throws(() => db.markOtelSent([row2.id], [{ workflowId: null, sessionId: "x", state: { tokens: {}, costUsd: 0 } }]));
		assert.equal(db.claimOtelOutboxBatch(10, t).length, 1);
	});
});

test("recordOtelResult stamps last_ok_at and last_error", () => {
	inDefault(() => {
		db.recordOtelResult({ ok: false, error: "HTTP 503" });
		assert.equal(db.getOtelConfig().lastError, "HTTP 503");
		db.recordOtelResult({ ok: true, at: "2026-04-01T00:00:00.000Z" });
		const c = db.getOtelConfig();
		assert.equal(c.lastOkAt, "2026-04-01T00:00:00.000Z");
		assert.equal(c.lastError, null);
	});
});

test("organizations are isolated: config, secrets, outbox and state", () => {
	inOther(() => {
		assert.equal(db.getOtelConfig(), null);
		assert.equal(db.claimOtelOutboxBatch(10, "2099-01-01T00:00:00.000Z").length, 0);
		assert.equal(db.getOtelExportState("wf", null), null);
		db.saveOtelConfig({ enabled: true, endpoint: "https://other.example.com", headers: { Authorization: OTHER_TOKEN } });
		db.enqueueOtelEvent("o1", "step.done");
		db.setOtelExportState("wf", null, { tokens: { input: 1 }, costUsd: 1 });
	});
	inDefault(() => {
		assert.notEqual(db.getOtelConfig().endpoint, "https://other.example.com");
		assert.ok(!db.claimOtelOutboxBatch(10, "2099-01-01T00:00:00.000Z").some((r) => r.eventId === "o1"));
		assert.equal(db.getOtelExportState("wf", null).tokens.input, 99);
		assert.deepEqual(db.getOtelConfig({ includeSecrets: true }).headers, { Authorization: TOKEN });
	});
	// A ciphertext copied across organizations does not decrypt (org id is bound).
	const stolen = rawRow(otherDb).headers_enc;
	const raw = new DatabaseSync(process.env.TARGET_SERVER_DB);
	raw.prepare("UPDATE otel_exports SET headers_enc = ? WHERE id = 1").run(stolen);
	raw.close();
	inDefault(() => assert.deepEqual(db.getOtelConfig({ includeSecrets: true }).headers, {}));
	// Deleting one org's config leaves the other untouched.
	inOther(() => {
		assert.equal(db.deleteOtelConfig(), true);
		assert.equal(db.getOtelConfig(), null);
		assert.equal(db.otelOutboxCounts().pending, 0);
	});
	inDefault(() => assert.ok(db.getOtelConfig()));
});

test("deleteOtelConfig clears config, outbox and state", () => {
	inDefault(() => {
		assert.equal(db.deleteOtelConfig(), true);
		assert.equal(db.getOtelConfig(), null);
		assert.equal(db.getOtelExportState("wf", null), null);
		assert.equal(db.otelOutboxCounts().pending, 0);
		assert.equal(db.deleteOtelConfig(), false);
	});
});
