import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { once } from "node:events";
import { createOAuthState, OAUTH_STATE_COOKIE } from "../google-oauth.mjs";
import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-google-oauth-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_PUBLIC_URL = "http://127.0.0.1:8900";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";
process.env.TARGET_GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.TARGET_GOOGLE_CLIENT_SECRET = "test-client-secret";

const originalFetch = globalThis.fetch;

function installGoogleFetchMock({ email, sub }) {
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.includes("oauth2.googleapis.com/token")) {
			return new Response(JSON.stringify({ access_token: "test-access-token", token_type: "Bearer" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.includes("openidconnect.googleapis.com/v1/userinfo")) {
			return new Response(
				JSON.stringify({
					sub,
					email,
					email_verified: true,
					name: "Google Test User",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return originalFetch(input);
	};
}

before(() => {
	installGoogleFetchMock({ email: "google-invited@example.com", sub: "google-sub-invited" });
});

after(async () => {
	globalThis.fetch = originalFetch;
	if (server?.listening) server.close();
});

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

function httpGetNoFollow(url, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.get(url, { headers }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				});
			});
		});
		req.on("error", reject);
	});
}

function httpPostJson(url, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const data = JSON.stringify(body);
		const req = http.request(
			{
				hostname: u.hostname,
				port: u.port,
				path: `${u.pathname}${u.search}`,
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(data),
					...headers,
				},
			},
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

function sessionCookieFromSetCookie(setCookie) {
	const parts = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
	return parts.map((c) => c.split(";")[0]).join("; ");
}

test("GET /api/auth/providers reports google when configured", async () => {
	const res = await fetch(`${base}/api/auth/providers`);
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { google: true });
});

test("GET /api/auth/google redirects to Google when configured", async () => {
	const res = await httpGetNoFollow(`${base}/api/auth/google`);
	assert.equal(res.status, 302);
	const location = res.headers.location ?? "";
	assert.match(String(location), /^https:\/\/accounts\.google\.com\/o\/oauth2/);
	assert.ok(String(location).includes("client_id=test-client-id"));
	const setCookie = res.headers["set-cookie"] ?? [];
	const cookieHeader = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie;
	assert.ok(cookieHeader.includes(OAUTH_STATE_COOKIE));
});

test("callback rejects uninvited Google email", async () => {
	installGoogleFetchMock({ email: "not-invited@example.com", sub: "google-sub-stranger" });
	const state = createOAuthState();
	const res = await httpGetNoFollow(
		`${base}/api/auth/google/callback?code=fake-code&state=${encodeURIComponent(state)}`,
		{ cookie: `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}` },
	);
	assert.equal(res.status, 302);
	assert.match(String(res.headers.location ?? ""), /auth_error=not_invited/);
	installGoogleFetchMock({ email: "google-invited@example.com", sub: "google-sub-invited" });
});

test("callback activates invited pending user without password", async () => {
	const adminLogin = await httpPostJson(`${base}/api/auth/login`, {
		email: DEFAULT_ADMIN_EMAIL,
		password: DEFAULT_ADMIN_PASSWORD,
	});
	assert.equal(adminLogin.status, 200);
	const adminCookie = sessionCookieFromSetCookie(adminLogin.headers["set-cookie"]);
	const createRes = await httpPostJson(
		`${base}/api/auth/users`,
		{ email: "google-invited@example.com" },
		{ cookie: adminCookie },
	);
	assert.equal(createRes.status, 201);

	const state = createOAuthState();
	const cb = await httpGetNoFollow(
		`${base}/api/auth/google/callback?code=fake-code&state=${encodeURIComponent(state)}`,
		{ cookie: `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}` },
	);
	assert.equal(cb.status, 302);
	assert.equal(cb.headers.location, "http://127.0.0.1:8900/");
	const setCookie = cb.headers["set-cookie"] ?? [];
	const sessionParts = (Array.isArray(setCookie) ? setCookie : [setCookie]).map((c) => c.split(";")[0]);
	const session = sessionParts.find((c) => c.startsWith("target_auth=")) ?? "";
	assert.ok(session.includes("target_auth="));

	const me = await httpGetNoFollow(`${base}/api/auth/me`, { cookie: session });
	assert.equal(me.status, 200);
	const body = JSON.parse(me.body);
	assert.equal(body.user.email, "google-invited@example.com");
	assert.equal(body.user.status, "active");
});

test("password login unchanged for active password users", async () => {
	const res = await httpPostJson(`${base}/api/auth/login`, {
		email: DEFAULT_ADMIN_EMAIL,
		password: DEFAULT_ADMIN_PASSWORD,
	});
	assert.equal(res.status, 200);
});
