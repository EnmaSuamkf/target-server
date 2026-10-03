/**
 * /api/settings/otel: RBAC, masking, fail-closed secrets, validation, SSRF and
 * the connectivity test against a fake local OTLP server.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, mock } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-otel-api-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
const KEY = randomBytes(32).toString("hex");
process.env.TARGET_SECRETS_KEY = KEY;
delete process.env.TARGET_OTEL_ALLOW_PRIVATE;

// No real DNS in tests: every hostname resolves to `resolveTo` unless a case says otherwise.
let resolveTo = [{ address: "93.184.216.34", family: 4 }];
mock.method(dns, "lookup", async () => resolveTo);

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const URL_ = `${base}/api/settings/otel`;
after(() => server.close());

const json = (method, body, cookie) => ({
	method,
	headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
	body: body === undefined ? undefined : JSON.stringify(body),
});
const call = async (method, suffix, body, cookie) => {
	const res = await fetch(URL_ + suffix, json(method, body, cookie));
	const text = await res.text();
	return { status: res.status, text, body: text ? JSON.parse(text) : null };
};

async function inviteSession(admin, { email, permissions, password = "correct-horse-battery" }) {
	const role = (await (await fetch(`${base}/api/auth/roles`, json("POST", { name: email, permissions }, admin))).json()).role;
	const invite = await (await fetch(`${base}/api/auth/users`, json("POST", { email, role_id: role.id }, admin))).json();
	const token = new URL(invite.invite.setupUrl).searchParams.get("token");
	const setup = await fetch(`${base}/api/auth/setup`, json("POST", { token, password }));
	assert.equal(setup.status, 200);
	return setup.headers.get("set-cookie")?.split(";")[0];
}

const SECRET_AUTH = "Bearer sk-live-PLAINTEXT-7788";
const SECRET_KEY = "dd-api-key-PLAINTEXT-4321";
const rawHeaders = () => {
	const raw = new DatabaseSync(tmpDb, { readOnly: true });
	try {
		return raw.prepare("SELECT headers_enc FROM otel_exports WHERE id = 1").get()?.headers_enc ?? null;
	} finally {
		raw.close();
	}
};

test("401 without a session; 403 without the right permission; 200 with it", async () => {
	for (const [method, suffix] of [["GET", ""], ["PUT", ""], ["DELETE", ""], ["POST", "/test"]]) {
		assert.equal((await call(method, suffix, method === "PUT" ? {} : undefined)).status, 401, `${method}${suffix}`);
	}
	const admin = await login(base);
	const reader = await inviteSession(admin, { email: "tel-read@example.com", permissions: ["telemetry.read"] });
	const writer = await inviteSession(admin, { email: "tel-write@example.com", permissions: ["telemetry.write"] });
	const nobody = await inviteSession(admin, { email: "tel-none@example.com", permissions: ["activity.read"] });

	assert.equal((await call("GET", "", undefined, reader)).status, 200);
	assert.equal((await call("GET", "", undefined, nobody)).status, 403);
	assert.equal((await call("GET", "", undefined, writer)).status, 403);
	assert.equal((await call("PUT", "", { endpoint: "https://otlp.example.com" }, reader)).status, 403);
	assert.equal((await call("POST", "/test", undefined, reader)).status, 403);
	assert.equal((await call("DELETE", "", undefined, reader)).status, 403);
	assert.equal((await call("PUT", "", { endpoint: "https://otlp.example.com" }, writer)).status, 200);
	assert.equal((await call("DELETE", "", undefined, writer)).status, 200);
	assert.equal((await call("PATCH", "", {}, admin)).status, 405);
});

test("GET on an unconfigured org returns defaults and secretsAvailable", async () => {
	const admin = await login(base);
	const { status, body } = await call("GET", "", undefined, admin);
	assert.equal(status, 200);
	assert.equal(body.secretsAvailable, true);
	assert.equal(body.config.enabled, false);
	assert.equal(body.config.endpoint, "");
	assert.deepEqual(body.config.headers, []);
	assert.deepEqual(body.config.signals, ["traces", "metrics"]);
	assert.equal(body.config.sendContent, true);
	assert.deepEqual(body.organization, { id: "default", name: "Default" });
	assert.equal(body.status.outbox.pending, 0);
});

test("PUT stores encrypted headers; GET never returns a full header value", async () => {
	const admin = await login(base);
	const put = await call(
		"PUT",
		"",
		{ enabled: true, endpoint: "https://otlp.example.com", headers: { Authorization: SECRET_AUTH, "DD-API-KEY": SECRET_KEY }, signals: ["traces"] },
		admin,
	);
	assert.equal(put.status, 200, put.text);
	const get = await call("GET", "", undefined, admin);
	for (const res of [put, get]) {
		assert.ok(!res.text.includes("PLAINTEXT"), "a full header value leaked");
		assert.ok(!res.text.includes(SECRET_AUTH) && !res.text.includes(SECRET_KEY));
		assert.deepEqual(res.body.config.headers, [
			{ name: "Authorization", masked: "••••7788" },
			{ name: "DD-API-KEY", masked: "••••4321" },
		]);
		assert.equal(res.body.config.enabled, true);
		assert.deepEqual(res.body.config.signals, ["traces"]);
		assert.ok(res.body.status.enabledAt);
	}
	const raw = rawHeaders();
	assert.ok(!raw.includes("PLAINTEXT") && raw.includes("v1:"));
});

test("an omitted header value keeps the stored secret; unlisted headers are removed", async () => {
	const admin = await login(base);
	const before = rawHeaders();
	const put = await call("PUT", "", { headers: { Authorization: "", "X-New": "new-value-9999" } }, admin);
	assert.equal(put.status, 200, put.text);
	assert.deepEqual(put.body.config.headers, [
		{ name: "Authorization", masked: "••••7788" },
		{ name: "X-New", masked: "••••9999" },
	]);
	assert.equal(JSON.parse(rawHeaders()).Authorization, JSON.parse(before).Authorization);
	const missing = await call("PUT", "", { headers: { "Never-Set": null } }, admin);
	assert.equal(missing.status, 422);
	assert.equal(missing.body.error, "header_value_required");
	// Put the fixture back.
	await call("PUT", "", { headers: { Authorization: "" } }, admin);
});

test("without TARGET_SECRETS_KEY: status says so and PUT is refused with secrets_unavailable", async () => {
	const admin = await login(base);
	delete process.env.TARGET_SECRETS_KEY;
	try {
		const get = await call("GET", "", undefined, admin);
		assert.equal(get.body.secretsAvailable, false);
		assert.deepEqual(get.body.config.headers, [{ name: "Authorization", masked: "••••" }]);

		const withSecret = await call("PUT", "", { headers: { Authorization: "Bearer brand-new-secret-1234" } }, admin);
		assert.equal(withSecret.status, 409);
		assert.equal(withSecret.body.error, "secrets_unavailable");
		assert.ok(!withSecret.text.includes("brand-new"));
		const enable = await call("PUT", "", { enabled: true, endpoint: "https://otlp.example.com" }, admin);
		assert.equal(enable.status, 409);
		assert.equal(enable.body.error, "secrets_unavailable");
		// A key-less change that touches no secret and leaves it off is fine.
		assert.equal((await call("PUT", "", { enabled: false, sendContent: false }, admin)).status, 200);
	} finally {
		process.env.TARGET_SECRETS_KEY = KEY;
	}
	assert.equal((await call("GET", "", undefined, admin)).body.secretsAvailable, true);
});

test("validation errors: 422 with details", async () => {
	const admin = await login(base);
	const bad = [
		{ enabled: true },
		{ enabled: true, endpoint: "" },
		{ endpoint: 5 },
		{ endpoint: "https://x.example.com", signals: [] },
		{ endpoint: "https://x.example.com", signals: ["logs"] },
		{ endpoint: "https://x.example.com", signals: ["traces", "traces"] },
		{ endpoint: "https://x.example.com", headers: { "bad name": "v" } },
		{ endpoint: "https://x.example.com", headers: { A: 5 } },
		{ endpoint: "https://x.example.com", sendContent: "yes please" },
	];
	for (const body of bad) {
		const r = await call("PUT", "", body, admin);
		assert.equal(r.status, 422, JSON.stringify(body));
		assert.ok(r.body.errors, JSON.stringify(body));
	}
});

test("SSRF: bad endpoints are refused with stable codes", async () => {
	const admin = await login(base);
	const refuse = async (endpoint, code) => {
		const r = await call("PUT", "", { endpoint }, admin);
		assert.equal(r.status, 422, endpoint);
		assert.equal(r.body.error, code, endpoint);
	};
	await refuse("https://localhost:4318", "endpoint_private");
	await refuse("https://10.1.2.3", "endpoint_private");
	await refuse("https://127.0.0.1", "endpoint_private");
	await refuse("https://169.254.169.254/latest", "endpoint_private");
	await refuse("http://169.254.169.254", "endpoint_scheme");
	await refuse("http://otlp.example.com", "endpoint_scheme");
	await refuse("https://user:pw@otlp.example.com", "endpoint_credentials");
	await refuse("not-a-url", "endpoint_invalid");

	resolveTo = [{ address: "127.0.0.1", family: 4 }];
	try {
		await refuse("https://rebind.example.com", "endpoint_private");
	} finally {
		resolveTo = [{ address: "93.184.216.34", family: 4 }];
	}
	resolveTo = [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.8", family: 4 }];
	try {
		await refuse("https://mixed.example.com", "endpoint_private");
	} finally {
		resolveTo = [{ address: "93.184.216.34", family: 4 }];
	}
	assert.equal((await call("PUT", "", { endpoint: "https://fine.example.com" }, admin)).status, 200);
});

test("POST /test sends one span and one metric to a fake OTLP server", async () => {
	const admin = await login(base);
	const seen = [];
	let mode = "ok";
	const fake = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
			if (mode === "redirect") {
				res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
				return res.end();
			}
			res.writeHead(mode === "ok" ? 200 : 401, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise((r) => fake.listen(0, "127.0.0.1", r));
	after(() => fake.close());
	const endpoint = `http://127.0.0.1:${fake.address().port}`;

	// Private targets are refused until TARGET_OTEL_ALLOW_PRIVATE=1.
	const refused = await call("PUT", "", { endpoint }, admin);
	assert.equal(refused.status, 422);
	assert.equal(refused.body.error, "endpoint_scheme");

	process.env.TARGET_OTEL_ALLOW_PRIVATE = "1";
	try {
		const saved = await call("PUT", "", { enabled: false, endpoint, headers: { Authorization: SECRET_AUTH }, signals: ["traces", "metrics"] }, admin);
		assert.equal(saved.status, 200, saved.text);
		assert.equal(saved.body.allowPrivateEndpoints, true);

		const ok = await call("POST", "/test", undefined, admin);
		assert.equal(ok.status, 200, ok.text);
		assert.deepEqual(ok.body, { ok: true, status: 200, error: null });
		assert.deepEqual(seen.map((s) => s.url), ["/v1/traces", "/v1/metrics"]);
		assert.ok(seen.every((s) => s.auth === SECRET_AUTH));
		const spans = seen[0].body.resourceSpans[0].scopeSpans[0].spans;
		assert.equal(spans.length, 1);
		assert.equal(spans[0].name, "target.otel.test");
		assert.equal(seen[1].body.resourceMetrics[0].scopeMetrics[0].metrics.length, 1);

		mode = "reject";
		const rejected = await call("POST", "/test", undefined, admin);
		assert.equal(rejected.status, 200);
		assert.equal(rejected.body.ok, false);
		assert.equal(rejected.body.status, 401);
		assert.match(rejected.body.error, /HTTP 401/);
		assert.ok(!rejected.text.includes("PLAINTEXT"));

		mode = "redirect";
		seen.length = 0;
		const redirected = await call("POST", "/test", undefined, admin);
		assert.equal(redirected.body.ok, false);
		assert.equal(redirected.body.status, 302);
		assert.equal(seen.length, 1);
	} finally {
		delete process.env.TARGET_OTEL_ALLOW_PRIVATE;
	}
	// Back to the default policy the stored private endpoint is refused at send time.
	const blocked = await call("POST", "/test", undefined, admin);
	assert.equal(blocked.status, 422);
	assert.equal(blocked.body.error, "endpoint_scheme");
});

test("POST /test without a saved endpoint is a 409", async () => {
	const admin = await login(base);
	await call("DELETE", "", undefined, admin);
	const r = await call("POST", "/test", undefined, admin);
	assert.equal(r.status, 409);
	assert.equal(r.body.error, "not_configured");
});

test("DELETE removes the config and the stored ciphertext", async () => {
	const admin = await login(base);
	await call("PUT", "", { endpoint: "https://otlp.example.com", headers: { Authorization: SECRET_AUTH } }, admin);
	assert.ok(rawHeaders());
	assert.equal((await call("DELETE", "", undefined, admin)).status, 200);
	assert.equal(rawHeaders(), null);
	const get = await call("GET", "", undefined, admin);
	assert.equal(get.body.config.endpoint, "");
	assert.deepEqual(get.body.config.headers, []);
});
