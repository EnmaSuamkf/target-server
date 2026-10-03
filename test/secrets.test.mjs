import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
	DEV_KEY_FILENAME,
	SecretsError,
	currentKeyId,
	decryptSecret,
	encryptSecret,
	envelopeKeyId,
	initDevKey,
	maskSecret,
	resetDevKey,
	secretsAvailable,
} from "../secrets.mjs";

const KEY_A = randomBytes(32).toString("hex");
const KEY_B = randomBytes(32).toString("hex");
const SECRET = "Bearer sk-live-PLAINTEXT-1234";

const saved = {};
beforeEach(() => {
	for (const k of ["TARGET_SECRETS_KEY", "TARGET_SECRETS_KEY_PREVIOUS"]) saved[k] = process.env[k];
	delete process.env.TARGET_SECRETS_KEY;
	delete process.env.TARGET_SECRETS_KEY_PREVIOUS;
	resetDevKey();
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	resetDevKey();
});

function throwsCode(fn, code) {
	assert.throws(fn, (e) => e instanceof SecretsError && e.code === code, `expected ${code}`);
}

test("round-trip with envelope format and random IV", () => {
	process.env.TARGET_SECRETS_KEY = KEY_A;
	assert.equal(secretsAvailable(), true);
	const a = encryptSecret("org1", SECRET);
	const b = encryptSecret("org1", SECRET);
	assert.match(a, /^v1:[0-9a-f]{8}:[\w-]+:[\w-]+:[\w-]*$/);
	assert.notEqual(a, b);
	assert.ok(!a.includes("PLAINTEXT"));
	assert.equal(decryptSecret("org1", a), SECRET);
	assert.equal(decryptSecret("org1", encryptSecret("org1", "")), "");
	assert.equal(envelopeKeyId(a), currentKeyId());
});

test("tampered ciphertext, tag, iv and envelope are rejected", () => {
	process.env.TARGET_SECRETS_KEY = KEY_A;
	const parts = encryptSecret("org1", SECRET).split(":");
	const flip = (s) => (s[0] === "A" ? "B" : "A") + s.slice(1);
	for (const i of [2, 3, 4]) {
		const t = [...parts];
		t[i] = flip(t[i]);
		throwsCode(() => decryptSecret("org1", t.join(":")), i === 2 ? "secrets_decrypt_failed" : "secrets_decrypt_failed");
	}
	throwsCode(() => decryptSecret("org1", "garbage"), "secrets_bad_envelope");
	throwsCode(() => decryptSecret("org1", ["v2", ...parts.slice(1)].join(":")), "secrets_bad_envelope");
	throwsCode(() => decryptSecret("org1", null), "secrets_bad_envelope");
});

test("a ciphertext cannot be moved to another organization", () => {
	process.env.TARGET_SECRETS_KEY = KEY_A;
	const env = encryptSecret("org1", SECRET);
	throwsCode(() => decryptSecret("org2", env), "secrets_decrypt_failed");
	throwsCode(() => encryptSecret("", SECRET), "secrets_org_required");
});

test("wrong key fails", () => {
	process.env.TARGET_SECRETS_KEY = KEY_A;
	const env = encryptSecret("org1", SECRET);
	process.env.TARGET_SECRETS_KEY = KEY_B;
	throwsCode(() => decryptSecret("org1", env), "secrets_key_mismatch");
});

test("rotation: previous key decrypts old values, new writes use the new key", () => {
	process.env.TARGET_SECRETS_KEY = KEY_A;
	const old = encryptSecret("org1", SECRET);
	process.env.TARGET_SECRETS_KEY = KEY_B;
	process.env.TARGET_SECRETS_KEY_PREVIOUS = KEY_A;
	assert.equal(decryptSecret("org1", old), SECRET);
	const fresh = encryptSecret("org1", SECRET);
	assert.notEqual(envelopeKeyId(fresh), envelopeKeyId(old));
	assert.equal(envelopeKeyId(fresh), currentKeyId());
	delete process.env.TARGET_SECRETS_KEY_PREVIOUS;
	assert.equal(decryptSecret("org1", fresh), SECRET);
	throwsCode(() => decryptSecret("org1", old), "secrets_key_mismatch");
});

test("missing key fails closed", () => {
	assert.equal(secretsAvailable(), false);
	assert.equal(currentKeyId(), null);
	throwsCode(() => encryptSecret("org1", SECRET), "secrets_unavailable");
	process.env.TARGET_SECRETS_KEY = KEY_A;
	const env = encryptSecret("org1", SECRET);
	delete process.env.TARGET_SECRETS_KEY;
	throwsCode(() => decryptSecret("org1", env), "secrets_unavailable");
});

test("invalid key length or format is rejected without echoing the key", () => {
	for (const bad of ["abcd", KEY_A.slice(0, 62), `${KEY_A}00`, "z".repeat(64)]) {
		process.env.TARGET_SECRETS_KEY = bad;
		assert.equal(secretsAvailable(), false);
		assert.throws(
			() => encryptSecret("org1", SECRET),
			(e) => e.code === "secrets_key_invalid" && !e.message.includes(bad),
		);
	}
	process.env.TARGET_SECRETS_KEY = KEY_A;
	process.env.TARGET_SECRETS_KEY_PREVIOUS = "short";
	throwsCode(() => encryptSecret("org1", SECRET), "secrets_key_invalid");
});

test("dev key: created with mode 0600 on loopback, stable, and reused", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "secrets-test-"));
	try {
		const dbPath = path.join(dir, "x.db");
		assert.equal(initDevKey({ host: "127.0.0.1", dbPath }), true);
		const file = path.join(dir, DEV_KEY_FILENAME);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.equal(secretsAvailable(), true);
		const env = encryptSecret("org1", SECRET);
		resetDevKey();
		assert.equal(secretsAvailable(), false);
		assert.equal(initDevKey({ host: "localhost", dbPath }), true);
		assert.equal(decryptSecret("org1", env), SECRET);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dev key is refused on non-loopback binds and when an env key exists", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "secrets-test-"));
	try {
		const dbPath = path.join(dir, "x.db");
		assert.equal(initDevKey({ host: "0.0.0.0", dbPath }), false);
		assert.equal(secretsAvailable(), false);
		assert.throws(() => statSync(path.join(dir, DEV_KEY_FILENAME)));
		assert.equal(initDevKey({ host: "127.0.0.1", dbPath, env: { TARGET_SECRETS_KEY: KEY_A } }), false);
		assert.throws(() => statSync(path.join(dir, DEV_KEY_FILENAME)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("maskSecret reveals at most the last 4 characters", () => {
	assert.equal(maskSecret("Bearer sk-live-1234"), "••••1234");
	assert.equal(maskSecret("short"), "••••");
	assert.equal(maskSecret(undefined), "••••");
});

test("errors never contain the plaintext", () => {
	process.env.TARGET_SECRETS_KEY = KEY_A;
	const env = encryptSecret("org1", SECRET);
	try {
		decryptSecret("org2", env);
	} catch (e) {
		assert.ok(!e.message.includes("PLAINTEXT") && !String(e.stack).includes("PLAINTEXT"));
	}
});
