#!/usr/bin/env node
/**
 * Operator smoke: invite one email three ways (password / google / both) and
 * assert file-outbox bodies match. Uses a throwaway DB; does not start if PORT is in use.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-invite-"));
process.env.TARGET_SERVER_DB = path.join(tmp, "t.db");
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_PUBLIC_URL = "http://127.0.0.1:8900";
process.env.TARGET_GOOGLE_CLIENT_ID = "verify-invite-client";
process.env.TARGET_GOOGLE_CLIENT_SECRET = "verify-invite-secret";

const TEST_EMAIL = "manual-invite@example.com";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const { login } = await import("../test/helpers.mjs");
const { outboxDir } = await import("../mailer.mjs");

const cookie = await login(base);

async function deleteTestUser() {
	const list = await (await fetch(`${base}/api/auth/users`, { headers: { cookie } })).json();
	const u = list.users.find((x) => x.email === TEST_EMAIL);
	if (u) await fetch(`${base}/api/auth/users/${u.id}`, { method: "DELETE", headers: { cookie } });
}

function newestEmlFor(email) {
	const dir = outboxDir();
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".eml"))
		.map((f) => {
			const full = path.join(dir, f);
			return { t: fs.readFileSync(full, "utf8"), m: fs.statSync(full).mtimeMs };
		})
		.filter((x) => x.t.includes(email))
		.sort((a, b) => b.m - a.m)[0]?.t;
}

const cases = [
	{
		label: "password-only",
		activation: { password: true, google: false },
		check(eml, body) {
			if (!body.invite.setupUrl?.includes("/setup?token=")) throw new Error("missing setupUrl");
			if (body.invite.loginUrl) throw new Error("unexpected loginUrl");
			if (!/Choose your password/i.test(eml)) throw new Error("mail missing password section");
			if (/\/setup\?token=/.test(eml) === false) throw new Error("mail missing setup token");
			if (/Continue with Google/i.test(eml)) throw new Error("mail must not mention Google");
		},
	},
	{
		label: "google-only",
		activation: { google: true },
		check(eml, body) {
			if (body.invite.setupUrl) throw new Error("google-only must not return setupUrl");
			if (!body.invite.loginUrl?.includes("/login")) throw new Error("missing loginUrl");
			if (/Continue with Google/i.test(eml) === false) throw new Error("mail missing Google section");
			if (/\/setup\?token=/.test(eml)) throw new Error("mail must not contain setup token");
		},
	},
	{
		label: "both",
		activation: { password: true, google: true },
		check(eml, body) {
			if (!body.invite.setupUrl?.includes("/setup?token=")) throw new Error("missing setupUrl");
			if (!body.invite.loginUrl?.includes("/login")) throw new Error("missing loginUrl");
			if (!/Choose your password/i.test(eml)) throw new Error("mail missing password section");
			if (!/Continue with Google/i.test(eml)) throw new Error("mail missing Google section");
		},
	},
];

let ok = 0;
for (const c of cases) {
	await deleteTestUser();
	const res = await fetch(`${base}/api/auth/users`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ email: TEST_EMAIL, activation: c.activation }),
	});
	if (res.status !== 201) throw new Error(`${c.label}: create → ${res.status} ${await res.text()}`);
	const body = await res.json();
	const eml = newestEmlFor(TEST_EMAIL);
	if (!eml) throw new Error(`${c.label}: no .eml in outbox`);
	c.check(eml, body);
	console.log(`OK  ${c.label} — mail matches activation`);
	ok++;
}

server.close();
console.log(`\nVerified ${ok}/${cases.length} invite mail variants for ${TEST_EMAIL}.`);
