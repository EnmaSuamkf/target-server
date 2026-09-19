import assert from "node:assert/strict";
import test from "node:test";
import { inviteMail, withToken } from "../mail-templates.mjs";

const ORIGIN = "https://report.example.com";
const EMAIL = "invitee@example.com";

test("inviteMail password-only includes setup link, not Google", () => {
	const { text, html } = inviteMail({
		publicUrl: ORIGIN,
		email: EMAIL,
		allowPassword: true,
		allowGoogle: false,
	});
	assert.match(text, /Choose your password/);
	assert.match(text, /\/setup\?token=…/);
	assert.doesNotMatch(text, /Continue with Google/i);
	assert.doesNotMatch(text, /\/login/);
	assert.match(html, /setup\?token=…/);
	assert.doesNotMatch(html, /Continue with Google/i);
});

test("inviteMail google-only includes login, not setup", () => {
	const loginUrl = `${ORIGIN}/login`;
	const { text, html } = inviteMail({
		publicUrl: ORIGIN,
		email: EMAIL,
		allowPassword: false,
		allowGoogle: true,
		loginUrl,
	});
	assert.match(text, /Continue with Google/i);
	assert.ok(text.includes(loginUrl));
	assert.doesNotMatch(text, /Choose your password/);
	assert.doesNotMatch(text, /\/setup\?token=/);
	assert.doesNotMatch(html, /setup\?token=/);
	assert.ok(html.includes(loginUrl));
});

test("inviteMail both includes password and Google sections", () => {
	const loginUrl = `${ORIGIN}/login`;
	const { text, html } = inviteMail({
		publicUrl: ORIGIN,
		email: EMAIL,
		allowPassword: true,
		allowGoogle: true,
		loginUrl,
	});
	assert.match(text, /Choose your password/);
	assert.match(text, /\/setup\?token=…/);
	assert.match(text, /Continue with Google/i);
	assert.ok(text.includes(loginUrl));
	assert.match(html, /setup\?token=…/);
	assert.ok(html.includes(loginUrl));
});

test("withToken replaces setup placeholder in password invite", () => {
	const body = inviteMail({
		publicUrl: ORIGIN,
		email: EMAIL,
		allowPassword: true,
		allowGoogle: false,
	});
	const token = "a".repeat(64);
	const out = withToken(body, token);
	assert.ok(out.text.includes(`/setup?token=${token}`));
	assert.doesNotMatch(out.text, /token=…/);
});
