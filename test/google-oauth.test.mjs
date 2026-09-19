import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import {
	buildGoogleAuthUrl,
	createOAuthState,
	googleRedirectUri,
	isGoogleOAuthConfigured,
	OAUTH_STATE_COOKIE,
	verifyOAuthState,
} from "../google-oauth.mjs";

test("isGoogleOAuthConfigured is false without env vars", () => {
	const id = process.env.TARGET_GOOGLE_CLIENT_ID;
	const secret = process.env.TARGET_GOOGLE_CLIENT_SECRET;
	delete process.env.TARGET_GOOGLE_CLIENT_ID;
	delete process.env.TARGET_GOOGLE_CLIENT_SECRET;
	try {
		assert.equal(isGoogleOAuthConfigured(), false);
	} finally {
		if (id !== undefined) process.env.TARGET_GOOGLE_CLIENT_ID = id;
		else delete process.env.TARGET_GOOGLE_CLIENT_ID;
		if (secret !== undefined) process.env.TARGET_GOOGLE_CLIENT_SECRET = secret;
		else delete process.env.TARGET_GOOGLE_CLIENT_SECRET;
	}
});

test("isGoogleOAuthConfigured is true when id and secret are set", () => {
	const id = process.env.TARGET_GOOGLE_CLIENT_ID;
	const secret = process.env.TARGET_GOOGLE_CLIENT_SECRET;
	process.env.TARGET_GOOGLE_CLIENT_ID = "id.apps.googleusercontent.com";
	process.env.TARGET_GOOGLE_CLIENT_SECRET = "secret";
	try {
		assert.equal(isGoogleOAuthConfigured(), true);
	} finally {
		if (id !== undefined) process.env.TARGET_GOOGLE_CLIENT_ID = id;
		else delete process.env.TARGET_GOOGLE_CLIENT_ID;
		if (secret !== undefined) process.env.TARGET_GOOGLE_CLIENT_SECRET = secret;
		else delete process.env.TARGET_GOOGLE_CLIENT_SECRET;
	}
});

test("createOAuthState returns unique base64url strings", () => {
	const a = createOAuthState();
	const b = createOAuthState();
	assert.notEqual(a, b);
	assert.match(a, /^[\w-]+$/);
	assert.ok(a.length >= 32);
});

test("verifyOAuthState compares cookie to state safely", () => {
	const state = createOAuthState();
	const req = { headers: { cookie: `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}` } };
	assert.equal(verifyOAuthState(req, state), true);
	assert.equal(verifyOAuthState(req, `${state}x`), false);
	assert.equal(verifyOAuthState({ headers: {} }, state), false);
});

test("buildGoogleAuthUrl includes redirect_uri and state", () => {
	const id = process.env.TARGET_GOOGLE_CLIENT_ID;
	const pub = process.env.TARGET_PUBLIC_URL;
	process.env.TARGET_GOOGLE_CLIENT_ID = "unit-test-id.apps.googleusercontent.com";
	process.env.TARGET_PUBLIC_URL = "http://127.0.0.1:8900";
	const state = "test-state-value";
	try {
		const url = buildGoogleAuthUrl(state, { host: "127.0.0.1", port: "8900" });
		const parsed = new URL(url);
		assert.equal(parsed.hostname, "accounts.google.com");
		assert.equal(parsed.searchParams.get("client_id"), "unit-test-id.apps.googleusercontent.com");
		assert.equal(parsed.searchParams.get("state"), state);
		assert.equal(parsed.searchParams.get("redirect_uri"), googleRedirectUri({ host: "127.0.0.1", port: "8900" }));
		assert.equal(parsed.searchParams.get("scope"), "openid email profile");
	} finally {
		if (id !== undefined) process.env.TARGET_GOOGLE_CLIENT_ID = id;
		else delete process.env.TARGET_GOOGLE_CLIENT_ID;
		if (pub !== undefined) process.env.TARGET_PUBLIC_URL = pub;
		else delete process.env.TARGET_PUBLIC_URL;
	}
});

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-google-providers-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";
delete process.env.TARGET_GOOGLE_CLIENT_ID;
delete process.env.TARGET_GOOGLE_CLIENT_SECRET;

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

test("GET /api/auth/providers reports google false without OAuth env", async () => {
	const id = process.env.TARGET_GOOGLE_CLIENT_ID;
	const secret = process.env.TARGET_GOOGLE_CLIENT_SECRET;
	delete process.env.TARGET_GOOGLE_CLIENT_ID;
	delete process.env.TARGET_GOOGLE_CLIENT_SECRET;
	try {
		const res = await fetch(`${base}/api/auth/providers`);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { google: false });
	} finally {
		if (id !== undefined) process.env.TARGET_GOOGLE_CLIENT_ID = id;
		else delete process.env.TARGET_GOOGLE_CLIENT_ID;
		if (secret !== undefined) process.env.TARGET_GOOGLE_CLIENT_SECRET = secret;
		else delete process.env.TARGET_GOOGLE_CLIENT_SECRET;
	}
});
