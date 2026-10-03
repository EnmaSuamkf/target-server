/** Two organizations export to two destinations through real /ingest; neither sees the other's data. */
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import fs, { readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { outboxDir } from "../mailer.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-otel-e2e-multi-"));
process.env.TARGET_SERVER_DB = path.join(tmpDir, "default.db");
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");
process.env.TARGET_MULTI_ORG = "1";
process.env.TARGET_DEVICE_LINKING_MODE = "required";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_PUBLIC_URL = "http://127.0.0.1:8900";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";
process.env.TARGET_SUPERUSER_EMAIL = "otel-e2e-su@example.com";
process.env.TARGET_SECRETS_KEY = randomBytes(32).toString("hex");
process.env.TARGET_OTEL_ALLOW_PRIVATE = "1";
process.env.TARGET_OTEL_INTERVAL_SECONDS = "0";

const { server } = await import("../server.mjs");
const { createOtelWorker } = await import("../otel-worker.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const json = (method, body, cookie, headers = {}) => ({
	method,
	headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
	body: body === undefined ? undefined : JSON.stringify(body),
});
const call = async (pathname, options) => {
	const res = await fetch(`${base}${pathname}`, options);
	const text = await res.text();
	return { status: res.status, text, body: text ? JSON.parse(text) : null };
};

function destination() {
	const seen = [];
	const srv = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			seen.push({ url: req.url, auth: req.headers.authorization, text: Buffer.concat(chunks).toString("utf8") });
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ seen, srv, endpoint: `http://127.0.0.1:${srv.address().port}` })));
}

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

async function linkHub(cookie, name) {
	const { publicKey } = generateKeyPairSync("ed25519");
	const value = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
	const created = await call(
		"/api/device-links/requests",
		json("POST", { contract_version: "device-link/v1", device_name: name, hub_version: "0.9.0", public_key: { algorithm: "ed25519", value }, requested_scopes: ["ingest:write", "sync:write"] }),
	);
	assert.equal(created.status, 201, created.text);
	const approved = await call(`/api/device-links/requests/${created.body.request_id}/approve`, json("POST", {}, cookie));
	assert.equal(approved.status, 200, approved.text);
	const consumed = await call(`/api/device-links/requests/${created.body.request_id}/consume`, {
		method: "POST",
		headers: { authorization: `Target-Link ${created.body.polling_credential}` },
	});
	assert.equal(consumed.status, 201, consumed.text);
	return { id: consumed.body.device.id, headers: { authorization: `Target-Device v1 ${consumed.body.device.id}.${consumed.body.device_secret}`, "content-type": "application/json" } };
}

async function provision(su, slug, dest, secret) {
	const email = `admin-${slug}@otel-e2e.example.com`;
	const created = await call("/api/platform/orgs", json("POST", { name: `Org ${slug}`, slug, admin_email: email }, su));
	assert.equal(created.status, 201, created.text);
	const cookie = await setupCookie(email, "org-admin-password-1");
	const put = await call("/api/settings/otel", json("PUT", { enabled: true, endpoint: dest.endpoint, headers: { Authorization: secret } }, cookie));
	assert.equal(put.status, 200, put.text);
	return { cookie, hub: await linkHub(cookie, `${slug} hub`), orgId: created.body.org.id };
}

let seq = 0;
async function ingestFinished(org, wf, tokens) {
	const mk = (kind, session, data) => ({ id: `mo-${++seq}`, kind, workflow_id: wf, session_id: session, created_at: new Date().toISOString(), data });
	const res = await call("/ingest", {
		method: "POST",
		headers: org.hub.headers,
		body: JSON.stringify({
			instance_id: org.hub.id,
			version: "1",
			user: { display_name: "Ada" },
			events: [
				mk("workflow.created", null, { name: "n", agent: "claude" }),
				mk("usage.snapshot", "s", { input_tokens: tokens, cache_read: 0, cache_creation: 0, output_tokens: 0, model: "m", cost_usd: null }),
				mk("workflow.status_changed", null, { from: "running", to: "completed" }),
			],
		}),
	});
	assert.equal(res.status, 200, res.text);
	assert.equal(res.body.accepted.length, 3);
}

test("each organization exports only its own events, to its own destination, with its own credentials", async () => {
	const su = await setupCookie("otel-e2e-su@example.com", "super-password-12");
	const destA = await destination();
	const destB = await destination();
	after(() => {
		destA.srv.close();
		destB.srv.close();
	});
	const a = await provision(su, "e2e-a", destA, "Bearer token-org-A-AAAA");
	const b = await provision(su, "e2e-b", destB, "Bearer token-org-B-BBBB");
	await new Promise((r) => setTimeout(r, 5));

	await ingestFinished(a, "wf-A-only", 111);
	await ingestFinished(b, "wf-B-only", 222);

	const summary = await createOtelWorker({}).runOnce();
	assert.equal(summary.orgs, 2);
	assert.equal(summary.failed, 0);

	for (const [dest, own, other, token, otherToken] of [
		[destA, "wf-A-only", "wf-B-only", "Bearer token-org-A-AAAA", "token-org-B"],
		[destB, "wf-B-only", "wf-A-only", "Bearer token-org-B-BBBB", "token-org-A"],
	]) {
		assert.ok(dest.seen.length >= 2, "traces and metrics arrived");
		assert.ok(dest.seen.every((r) => r.auth === token));
		const all = dest.seen.map((r) => r.text).join("\n");
		assert.ok(!all.includes(otherToken));
		assert.ok(!all.includes(other), "no trace or span id of the other org's workflow");
		assert.ok(dest.seen.some((r) => r.url === "/v1/traces"));
		assert.ok(dest.seen.some((r) => r.url === "/v1/metrics"));
	}
	const tokens = (dest) =>
		dest.seen
			.filter((r) => r.url === "/v1/metrics")
			.flatMap((r) => JSON.parse(r.text).resourceMetrics[0].scopeMetrics[0].metrics.filter((m) => m.name === "target.tokens"))
			.flatMap((m) => m.sum.dataPoints.map((p) => Number(p.asInt)))
			.reduce((x, y) => x + y, 0);
	assert.equal(tokens(destA), 111);
	assert.equal(tokens(destB), 222);
	// Resource attribute carries each org's own id.
	const orgAttr = (dest) => JSON.parse(dest.seen[0].text);
	assert.ok(JSON.stringify(orgAttr(destA)).includes(a.orgId));
	assert.ok(JSON.stringify(orgAttr(destB)).includes(b.orgId));
});
