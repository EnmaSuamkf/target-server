/**
 * `/api/settings/pricing`: CRUD, import/export and the permission gates.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-pricing-api-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const URL_ = `${base}/api/settings/pricing`;
after(() => server.close());

const json = (method, body, cookie) => ({
	method,
	headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
	body: JSON.stringify(body),
});

async function inviteSession(admin, { email, permissions, password }) {
	const roleRes = await fetch(`${base}/api/auth/roles`, json("POST", { name: email, permissions }, admin));
	assert.equal(roleRes.status, 201);
	const role = (await roleRes.json()).role;
	const inviteRes = await fetch(`${base}/api/auth/users`, json("POST", { email, role_id: role.id }, admin));
	assert.equal(inviteRes.status, 201);
	const invite = await inviteRes.json();
	const token = new URL(invite.invite.setupUrl).searchParams.get("token");
	const setup = await fetch(`${base}/api/auth/setup`, json("POST", { token, password }));
	assert.equal(setup.status, 200);
	return setup.headers.get("set-cookie")?.split(";")[0];
}

const rule = (o = {}) => ({ agent: "claude", model: "claude-opus-*", inputPerMtok: 15, outputPerMtok: 75, ...o });
const strip = (rules) => rules.map(({ id, createdAt, updatedAt, ...r }) => r);
const rulesOf = async (cookie) => (await (await fetch(URL_, { headers: { cookie } })).json()).rules;

test("CRUD: 201 on create, 200 on read/update/delete, 404 once gone", async () => {
	const admin = await login(base);
	const created = await fetch(URL_, json("POST", { inputPerMtok: 3, outputPerMtok: 15 }, admin));
	assert.equal(created.status, 201);
	const r = (await created.json()).rule;
	assert.equal(r.agent, "*");
	assert.equal(r.model, "*");
	assert.equal(r.effectiveFrom, "");
	assert.equal(r.cacheReadPerMtok, null);

	const listed = await fetch(URL_, { headers: { cookie: admin } });
	assert.equal(listed.status, 200);
	const body = await listed.json();
	assert.ok(body.rules.some((x) => x.id === r.id));
	assert.ok(Array.isArray(body.unpriced));

	const put = await fetch(`${URL_}/${r.id}`, json("PUT", { inputPerMtok: 4, outputPerMtok: 20, cacheReadPerMtok: 0.4 }, admin));
	assert.equal(put.status, 200);
	assert.equal((await put.json()).rule.cacheReadPerMtok, 0.4);

	// PATCH keeps what it does not mention.
	const patch = await fetch(`${URL_}/${r.id}`, json("PATCH", { outputPerMtok: 25 }, admin));
	assert.equal(patch.status, 200);
	const patched = (await patch.json()).rule;
	assert.equal(patched.outputPerMtok, 25);
	assert.equal(patched.inputPerMtok, 4);
	assert.equal(patched.cacheReadPerMtok, 0.4);

	assert.equal((await fetch(`${URL_}/${r.id}`, json("DELETE", undefined, admin))).status, 200);
	assert.equal((await fetch(`${URL_}/${r.id}`, json("DELETE", undefined, admin))).status, 404);
	assert.equal((await fetch(`${URL_}/${r.id}`, json("PUT", rule(), admin))).status, 404);
	assert.equal((await fetch(`${URL_}/999999`, json("PATCH", { inputPerMtok: 1 }, admin))).status, 404);
});

test("409 duplicate_rule on create and on update into an existing key", async () => {
	const admin = await login(base);
	await fetch(URL_ + "/import", json("POST", { mode: "replace", rules: [] }, admin));
	assert.equal((await fetch(URL_, json("POST", rule(), admin))).status, 201);
	const dup = await fetch(URL_, json("POST", rule(), admin));
	assert.equal(dup.status, 409);
	assert.deepEqual(await dup.json(), { error: "duplicate_rule" });
	const other = (await (await fetch(URL_, json("POST", rule({ model: "x" }), admin))).json()).rule;
	const clash = await fetch(`${URL_}/${other.id}`, json("PATCH", { model: "claude-opus-*" }, admin));
	assert.equal(clash.status, 409);
});

test("422 with field errors: negative price, bad date, unknown shape", async () => {
	const admin = await login(base);
	const neg = await fetch(URL_, json("POST", rule({ inputPerMtok: -1 }), admin));
	assert.equal(neg.status, 422);
	const { errors } = await neg.json();
	assert.ok(errors.some((e) => e.field === "inputPerMtok"));
	assert.equal((await fetch(URL_, json("POST", { outputPerMtok: 1 }, admin))).status, 422);
	assert.equal((await fetch(URL_, json("POST", rule({ effectiveFrom: "yesterday" }), admin))).status, 422);
	assert.equal((await fetch(URL_, json("POST", rule({ inputPerMtok: 2_000_000 }), admin))).status, 422);
	assert.equal((await fetch(URL_, json("POST", rule({ cacheReadPerMtok: -0.1 }), admin))).status, 422);
	const ok = await fetch(URL_, json("POST", rule({ model: "dated", effectiveFrom: "2026-01-01T00:00:00Z" }), admin));
	assert.equal(ok.status, 201);
});

test("export is an attachment that re-imports unchanged with mode replace", async () => {
	const admin = await login(base);
	await fetch(URL_, json("POST", rule({ model: "m1", cacheReadPerMtok: 1.5, cacheWritePerMtok: 18 }), admin));
	const before = strip(await rulesOf(admin));
	assert.ok(before.length >= 2);

	const exp = await fetch(`${URL_}/export`, { headers: { cookie: admin } });
	assert.equal(exp.status, 200);
	assert.match(exp.headers.get("content-disposition"), /attachment; filename="pricing-export\.json"/);
	const file = await exp.json();
	assert.equal(file.kind, "target.pricing");
	assert.deepEqual(file.rules, before);

	const wipe = await fetch(`${URL_}/import`, json("POST", { mode: "replace", rules: [] }, admin));
	assert.equal(wipe.status, 201);
	assert.deepEqual(await rulesOf(admin), []);

	const back = await fetch(`${URL_}/import`, json("POST", { ...file, mode: "replace" }, admin));
	assert.equal(back.status, 201);
	assert.deepEqual(strip((await back.json()).rules), before);
	assert.deepEqual(strip(await rulesOf(admin)), before);
});

test("import: replace is the default, merge upserts, duplicates in the file are 422", async () => {
	const admin = await login(base);
	await fetch(`${URL_}/import`, json("POST", { rules: [rule({ model: "a", inputPerMtok: 1 }), rule({ model: "b", inputPerMtok: 2 })] }, admin));
	assert.deepEqual((await rulesOf(admin)).map((r) => r.model), ["a", "b"]);

	const merged = await fetch(`${URL_}/import`, json("POST", { mode: "merge", rules: [rule({ model: "a", inputPerMtok: 9 }), rule({ model: "c" })] }, admin));
	assert.equal(merged.status, 201);
	const byModel = Object.fromEntries((await rulesOf(admin)).map((r) => [r.model, r.inputPerMtok]));
	assert.deepEqual(byModel, { a: 9, b: 2, c: 15 });

	const replaced = await fetch(`${URL_}/import`, json("POST", { mode: "replace", rules: [rule({ model: "only" })] }, admin));
	assert.equal(replaced.status, 201);
	assert.deepEqual((await rulesOf(admin)).map((r) => r.model), ["only"]);

	const dup = await fetch(`${URL_}/import`, json("POST", { mode: "replace", rules: [rule(), rule({ inputPerMtok: 1 })] }, admin));
	assert.equal(dup.status, 422);
	// A rejected file changes nothing.
	assert.deepEqual((await rulesOf(admin)).map((r) => r.model), ["only"]);
	assert.equal((await fetch(`${URL_}/import`, json("POST", { mode: "weird", rules: [] }, admin))).status, 422);
	assert.equal((await fetch(`${URL_}/import`, json("POST", { rules: [rule({ inputPerMtok: -5 })] }, admin))).status, 422);
});

test("401 without a session", async () => {
	for (const [method, suffix] of [["GET", ""], ["POST", ""], ["GET", "/export"], ["POST", "/import"], ["DELETE", "/1"]]) {
		const res = await fetch(URL_ + suffix, json(method === "GET" ? "GET" : method, method === "GET" ? undefined : {}));
		assert.equal(res.status, 401, `${method} ${suffix}`);
	}
});

test("403 for a role that lacks each permission", async () => {
	const admin = await login(base);
	const seed = (await (await fetch(URL_, json("POST", rule({ model: "gate" }), admin))).json()).rule;
	const all = ["pricing.read", "pricing.edit", "pricing.import", "pricing.export"];
	const sessions = {};
	for (const perm of all) {
		sessions[perm] = await inviteSession(admin, {
			email: `only-${perm.replace(".", "-")}@example.com`,
			permissions: [perm],
			password: "correct-horse-battery",
		});
	}
	const attempt = (method, suffix, body, cookie) => fetch(URL_ + suffix, json(method, body, cookie)).then((r) => r.status);

	// Each session can do its own thing…
	assert.equal(await attempt("GET", "", undefined, sessions["pricing.read"]), 200);
	assert.equal(await attempt("POST", "", rule({ model: "by-editor" }), sessions["pricing.edit"]), 201);
	assert.equal(await attempt("GET", "/export", undefined, sessions["pricing.export"]), 200);
	assert.equal(await attempt("POST", "/import", { mode: "merge", rules: [rule({ model: "by-importer" })] }, sessions["pricing.import"]), 201);

	// …and is refused the others.
	for (const perm of all) {
		const c = sessions[perm];
		if (perm !== "pricing.read") assert.equal(await attempt("GET", "", undefined, c), 403, `${perm} read`);
		if (perm !== "pricing.edit") {
			assert.equal(await attempt("POST", "", rule({ model: "nope" }), c), 403, `${perm} create`);
			assert.equal(await attempt("PATCH", `/${seed.id}`, { inputPerMtok: 1 }, c), 403, `${perm} update`);
			assert.equal(await attempt("DELETE", `/${seed.id}`, undefined, c), 403, `${perm} delete`);
		}
		if (perm !== "pricing.export") assert.equal(await attempt("GET", "/export", undefined, c), 403, `${perm} export`);
		if (perm !== "pricing.import") assert.equal(await attempt("POST", "/import", { rules: [] }, c), 403, `${perm} import`);
	}
	assert.ok((await rulesOf(admin)).some((r) => r.id === seed.id), "a refused delete left the rule in place");
});
