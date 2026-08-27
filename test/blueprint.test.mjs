import assert from "node:assert/strict";
import test from "node:test";
import { validate } from "../blueprint.mjs";

test("blueprint normalises email", () => {
	const r = validate("auth.login", { email: "  ADMIN@Example.COM ", password: "x" });
	assert.equal(r.ok, true);
	assert.equal(r.value.email, "admin@example.com");
});

test("blueprint rejects bad emails and localhost", () => {
	for (const email of ["not-an-email", "a@b", "user@localhost", "a@.com"]) {
		const r = validate("user.create", { email });
		assert.equal(r.ok, false);
		assert.ok(r.errors.some((e) => e.field === "email"));
	}
});

test("blueprint password min length", () => {
	const r = validate("auth.setup", { token: "a".repeat(64), password: "short" });
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => e.code === "string.min"));
});

test("blueprint stripUnknown drops injected role", () => {
	const r = validate("user.create", { email: "someone@example.com", role: "superadmin" });
	assert.equal(r.ok, true);
	assert.equal(r.value.role, undefined);
});

test("blueprint error shape", () => {
	const r = validate("user.create", { email: "bad" });
	assert.equal(r.ok, false);
	for (const e of r.errors) {
		assert.match(e.field, /.+/);
		assert.match(e.code, /.+/);
		assert.match(e.message, /.+/);
	}
});
