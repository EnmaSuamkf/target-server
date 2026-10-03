/** Two organizations: each sees and changes only its own OTLP export settings. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import { once } from "node:events";
import fs, { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, mock } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { outboxDir } from "../mailer.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-otel-multi-"));
process.env.TARGET_SERVER_DB = path.join(tmpDir, "default.db");
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");
process.env.TARGET_MULTI_ORG = "1";
process.env.TARGET_DEVICE_LINKING_MODE = "required";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_PUBLIC_URL = "http://127.0.0.1:8900";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";
process.env.TARGET_SUPERUSER_EMAIL = "otel-su@example.com";
process.env.TARGET_SECRETS_KEY = randomBytes(32).toString("hex");

mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);

const { server } = await import("../server.mjs");
const control = await import("../control-plane.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const json = (method, body, cookie) => ({
	method,
	headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
	body: body === undefined ? undefined : JSON.stringify(body),
});
const call = async (pathname, options) => {
	const res = await fetch(`${base}${pathname}`, options);
	const text = await res.text();
	return { status: res.status, text, body: text ? JSON.parse(text) : null };
};
const otel = (method, body, cookie) => call("/api/settings/otel", json(method, body, cookie));

function setupToken(email) {
	for (const f of readdirSync(outboxDir()).filter((n) => n.endsWith(".eml")).sort().reverse()) {
		const text = readFileSync(path.join(outboxDir(), f), "utf8");
		const m = text.includes(email) && text.match(/\/setup\?token=([A-Fa-f0-9]+)/);
		if (m) return m[1];
	}
	return null;
}

async function setupCookie(email, password) {
	const token = setupToken(email);
	assert.ok(token, `setup token missing for ${email}`);
	const res = await fetch(`${base}/api/auth/setup`, json("POST", { token, password }));
	assert.equal(res.status, 200, await res.text());
	return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function provision(su, slug) {
	const email = `admin-${slug}@otel.example.com`;
	const created = await call("/api/platform/orgs", json("POST", { name: `Org ${slug}`, slug, admin_email: email }, su));
	assert.equal(created.status, 201, created.text);
	return { cookie: await setupCookie(email, "org-admin-password-1"), dbPath: control.getOrganization(created.body.org.id).dbPath, id: created.body.org.id, name: `Org ${slug}` };
}

const headersOf = (dbPath) => {
	const raw = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return raw.prepare("SELECT headers_enc FROM otel_exports WHERE id = 1").get()?.headers_enc ?? null;
	} finally {
		raw.close();
	}
};

let suCookie;
test("export settings are per organization", async () => {
	const su = (suCookie = await setupCookie("otel-su@example.com", "super-password-12"));
	const a = await provision(su, "otel-a");
	const b = await provision(su, "otel-b");

	const putA = await otel("PUT", { enabled: true, endpoint: "https://a.example.com", headers: { Authorization: "Bearer org-a-secret-AAAA" } }, a.cookie);
	assert.equal(putA.status, 200, putA.text);

	const getB = await otel("GET", undefined, b.cookie);
	assert.equal(getB.status, 200);
	assert.equal(getB.body.config.endpoint, "");
	assert.equal(getB.body.config.enabled, false);
	assert.deepEqual(getB.body.config.headers, []);
	assert.equal(getB.body.status.enabledAt, null);

	const putB = await otel("PUT", { enabled: true, endpoint: "https://b.example.com", headers: { "X-Key": "org-b-secret-BBBB" } }, b.cookie);
	assert.equal(putB.status, 200, putB.text);

	const seenA = await otel("GET", undefined, a.cookie);
	assert.equal(seenA.body.config.endpoint, "https://a.example.com");
	assert.deepEqual(seenA.body.config.headers, [{ name: "Authorization", masked: "••••AAAA" }]);
	assert.ok(!seenA.text.includes("org-b") && !seenA.text.includes("BBBB"));
	const seenB = await otel("GET", undefined, b.cookie);
	assert.deepEqual(seenB.body.config.headers, [{ name: "X-Key", masked: "••••BBBB" }]);
	assert.ok(!seenB.text.includes("org-a") && !seenB.text.includes("AAAA"));

	// Stored in each org's own file, encrypted; ciphertexts differ and are bound to their org.
	const rawA = headersOf(a.dbPath);
	const rawB = headersOf(b.dbPath);
	assert.ok(rawA.includes("Authorization") && !rawA.includes("X-Key") && !rawA.includes("secret"));
	assert.ok(rawB.includes("X-Key") && !rawB.includes("Authorization") && !rawB.includes("secret"));
	assert.equal(headersOf(process.env.TARGET_SERVER_DB), null);

	// Deleting org A's config leaves org B's untouched.
	assert.equal((await otel("DELETE", undefined, a.cookie)).status, 200);
	assert.equal((await otel("GET", undefined, a.cookie)).body.config.endpoint, "");
	assert.equal((await otel("GET", undefined, b.cookie)).body.config.endpoint, "https://b.example.com");
	assert.equal(headersOf(a.dbPath), null);
	assert.ok(headersOf(b.dbPath));
});

test("GET reports each organization's own id and name", async () => {
	const a = await provision(suCookie, "otel-c");
	const b = await provision(suCookie, "otel-d");
	const seenA = await otel("GET", undefined, a.cookie);
	const seenB = await otel("GET", undefined, b.cookie);
	assert.deepEqual(seenA.body.organization, { id: a.id, name: "Org otel-c" });
	assert.deepEqual(seenB.body.organization, { id: b.id, name: "Org otel-d" });
	assert.notEqual(a.id, b.id);
});
