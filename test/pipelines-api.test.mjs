/**
 * Pipelines in the server catalogue: CRUD, validation with line numbers, the
 * client.pipelines.* permission gates, delete refused while a template uses the
 * pipeline, and the import/export round trip. Runs against an isolated database
 * under the OS temp directory, never the repo's databases.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ADMIN_EMAIL, login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-pipelines-api-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const json = (method, body, cookie) => ({
	method,
	headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
	body: JSON.stringify(body),
});

const VERIFY = `name: verify
description: Install and test one package.
inputs:
  package:
    default: hub
env:
  CI: "1"
steps:
  - name: Install
    run: npm ci
    working-directory: \${{ inputs.package }}
  - name: Test
    run: npm test
    continue-on-error: true
`;

const INVALID = `name: broken
steps:
  - run: echo ok
    shell: zsh
  - run: echo \${{ inputs.x }}
`;

async function inviteSession(admin, { email, permissions }) {
	const roleRes = await fetch(`${base}/api/auth/roles`, json("POST", { name: email, permissions }, admin));
	assert.equal(roleRes.status, 201);
	const role = (await roleRes.json()).role;
	const inviteRes = await fetch(`${base}/api/auth/users`, json("POST", { email, role_id: role.id }, admin));
	assert.equal(inviteRes.status, 201);
	const invite = await inviteRes.json();
	const token = new URL(invite.invite.setupUrl).searchParams.get("token");
	const setup = await fetch(`${base}/api/auth/setup`, json("POST", { token, password: "a-long-enough-password" }));
	assert.equal(setup.status, 200);
	return setup.headers.get("set-cookie")?.split(";")[0];
}

function pipelineRows() {
	const db = new DatabaseSync(tmpDb);
	try {
		return db.prepare("SELECT id, name FROM pipelines").all();
	} finally {
		db.close();
	}
}

async function createPipeline(admin, source = VERIFY, extra = {}) {
	const res = await fetch(`${base}/api/pipelines`, json("POST", { source, ...extra }, admin));
	assert.equal(res.status, 201, await res.clone().text());
	return (await res.json()).pipeline;
}

test("CRUD: create derives the name from YAML, list, get, patch re-validates, delete", async () => {
	const admin = await login(base);
	const created = await createPipeline(admin, VERIFY, { tags: ["ci", ""] });
	assert.equal(created.name, "verify");
	assert.deepEqual(created.tags, ["ci"]);
	assert.equal(created.source, VERIFY);
	assert.match(created.sourceHash, /^[0-9a-f]{64}$/);

	const list = await (await fetch(`${base}/api/pipelines`, { headers: { cookie: admin } })).json();
	assert.ok(list.pipelines.some((p) => p.id === created.id));

	const one = await fetch(`${base}/api/pipelines/${created.id}`, { headers: { cookie: admin } });
	assert.equal(one.status, 200);
	assert.equal((await one.json()).pipeline.id, created.id);

	const renamed = VERIFY.replace("name: verify", "name: verify-all");
	const patched = await fetch(`${base}/api/pipelines/${created.id}`, json("PATCH", { source: renamed }, admin));
	assert.equal(patched.status, 200);
	const after = (await patched.json()).pipeline;
	assert.equal(after.name, "verify-all");
	assert.notEqual(after.sourceHash, created.sourceHash);

	const del = await fetch(`${base}/api/pipelines/${created.id}`, { method: "DELETE", headers: { cookie: admin } });
	assert.equal(del.status, 200);
	const gone = await fetch(`${base}/api/pipelines/${created.id}`, { headers: { cookie: admin } });
	assert.equal(gone.status, 404);
});

test("invalid YAML is refused with 400 invalid_pipeline and line numbers; nothing is stored", async () => {
	const admin = await login(base);
	const before = pipelineRows().length;
	const res = await fetch(`${base}/api/pipelines`, json("POST", { source: INVALID }, admin));
	assert.equal(res.status, 400);
	const body = await res.json();
	assert.equal(body.error, "invalid_pipeline");
	assert.ok(Array.isArray(body.errors) && body.errors.length >= 2);
	const shell = body.errors.find((e) => e.path === "steps[0].shell");
	assert.ok(shell, "shell error is reported");
	assert.equal(shell.line, 4);
	assert.match(shell.message, /shell must be one of/);
	const expr = body.errors.find((e) => e.path === "steps[1].run");
	assert.equal(expr.line, 5);
	assert.equal(pipelineRows().length, before);

	const patchTarget = await createPipeline(admin);
	const badPatch = await fetch(`${base}/api/pipelines/${patchTarget.id}`, json("PATCH", { source: INVALID }, admin));
	assert.equal(badPatch.status, 400);
	assert.equal((await badPatch.json()).error, "invalid_pipeline");
	const unchanged = await (await fetch(`${base}/api/pipelines/${patchTarget.id}`, { headers: { cookie: admin } })).json();
	assert.equal(unchanged.pipeline.source, VERIFY, "a refused edit leaves the stored source alone");
});

test("validate returns { ok, errors } with lines and saves nothing", async () => {
	const admin = await login(base);
	const before = pipelineRows().length;
	const bad = await (await fetch(`${base}/api/pipelines/validate`, json("POST", { source: INVALID }, admin))).json();
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.every((e) => typeof e.message === "string" && "line" in e && "path" in e));
	const good = await (await fetch(`${base}/api/pipelines/validate`, json("POST", { source: VERIFY }, admin))).json();
	assert.deepEqual(good, {
		ok: true,
		name: "verify",
		inputs: [{ name: "package", required: false, default: "hub" }],
		errors: [],
	});
	const missing = await fetch(`${base}/api/pipelines/validate`, json("POST", {}, admin));
	assert.equal(missing.status, 422);
	assert.equal(pipelineRows().length, before);
});

test("import then export round-trips the source, reuses identical text, and refuses a bad bundle atomically", async () => {
	const admin = await login(base);
	const seed = await createPipeline(admin, VERIFY, { tags: ["round"] });
	const exported = await fetch(`${base}/api/pipelines/export`, { headers: { cookie: admin } });
	assert.equal(exported.status, 200);
	assert.match(exported.headers.get("content-disposition") ?? "", /pipelines-export\.json/);
	const bundle = await exported.json();
	assert.equal(bundle.kind, "target.pipelines");
	assert.equal(bundle.pipelines.length, pipelineRows().length);
	const seeded = bundle.pipelines.find((p) => p.source === VERIFY);
	assert.ok(seeded);

	const single = await fetch(`${base}/api/pipelines/${seed.id}/export`, { headers: { cookie: admin } });
	assert.equal(single.status, 200);
	assert.equal((await single.json()).pipelines[0].source, VERIFY);

	const beforeImport = pipelineRows().length;
	const idsBefore = pipelineRows().map((row) => row.id);
	const imported = await fetch(`${base}/api/pipelines/import`, json("POST", { kind: "target.pipelines", pipelines: [{ source: VERIFY, tags: ["copy"] }] }, admin));
	assert.equal(imported.status, 201);
	const importBody = await imported.json();
	// Identical text is reused: the stored row answers, and no second copy is written.
	assert.equal(importBody.results[0].action, "reused");
	const copy = importBody.pipelines[0];
	// Several rows may share this text (the earlier CRUD test stored it too); the server reuses the oldest.
	assert.ok(idsBefore.includes(copy.id), "the reused row already existed: no new row was written");
	assert.equal(copy.source, VERIFY);
	assert.equal(pipelineRows().length, beforeImport);

	const refused = await fetch(
		`${base}/api/pipelines/import`,
		json("POST", { kind: "target.pipelines", pipelines: [{ source: VERIFY.replace("name: verify", "name: never-stored") }, { source: INVALID }] }, admin),
	);
	assert.equal(refused.status, 400);
	const refusedBody = await refused.json();
	assert.equal(refusedBody.error, "invalid_pipeline");
	assert.equal(refusedBody.index, 1);
	assert.equal(pipelineRows().length, beforeImport, "a bad bundle stores none of its items");
});

test("every client.pipelines.* ID gates exactly its route; no ID is a read-all", async () => {
	const admin = await login(base);
	const seed = await createPipeline(admin);
	const anon = await fetch(`${base}/api/pipelines`, json("POST", { source: VERIFY }));
	assert.equal(anon.status, 401);

	const onlyCreate = await inviteSession(admin, { email: "creator@example.com", permissions: ["client.pipelines.create"] });
	const created = await fetch(`${base}/api/pipelines`, json("POST", { source: VERIFY }, onlyCreate));
	assert.equal(created.status, 201);
	const denied = [
		fetch(`${base}/api/pipelines/${seed.id}`, json("PATCH", { source: VERIFY }, onlyCreate)),
		fetch(`${base}/api/pipelines/${seed.id}`, { method: "DELETE", headers: { cookie: onlyCreate } }),
		fetch(`${base}/api/pipelines/import`, json("POST", { kind: "target.pipelines", pipelines: [{ source: VERIFY }] }, onlyCreate)),
		fetch(`${base}/api/pipelines/export`, { headers: { cookie: onlyCreate } }),
	];
	for (const res of await Promise.all(denied)) assert.equal(res.status, 403);

	const onlyEdit = await inviteSession(admin, { email: "editor@example.com", permissions: ["client.pipelines.edit"] });
	const patched = await fetch(`${base}/api/pipelines/${seed.id}`, json("PATCH", { source: VERIFY }, onlyEdit));
	assert.equal(patched.status, 200);
	assert.equal((await fetch(`${base}/api/pipelines/${seed.id}`, { method: "DELETE", headers: { cookie: onlyEdit } })).status, 403);

	const onlyDelete = await inviteSession(admin, { email: "deleter@example.com", permissions: ["client.pipelines.delete"] });
	const throwaway = await createPipeline(admin, VERIFY.replace("name: verify", "name: throwaway"));
	assert.equal((await fetch(`${base}/api/pipelines/${throwaway.id}`, { method: "DELETE", headers: { cookie: onlyDelete } })).status, 200);

	const onlyImport = await inviteSession(admin, { email: "importer@example.com", permissions: ["client.pipelines.import"] });
	assert.equal((await fetch(`${base}/api/pipelines/import`, json("POST", { kind: "target.pipelines", pipelines: [{ source: VERIFY }] }, onlyImport))).status, 201);
	assert.equal((await fetch(`${base}/api/pipelines/export`, { headers: { cookie: onlyImport } })).status, 403);

	const onlyExport = await inviteSession(admin, { email: "exporter@example.com", permissions: ["client.pipelines.export"] });
	assert.equal((await fetch(`${base}/api/pipelines/export`, { headers: { cookie: onlyExport } })).status, 200);
	assert.equal((await fetch(`${base}/api/pipelines`, json("POST", { source: VERIFY }, onlyExport))).status, 403);

	const onlySync = await inviteSession(admin, { email: "syncer@example.com", permissions: ["client.pipelines.sync"] });
	assert.equal((await fetch(`${base}/api/pipelines`, json("POST", { source: VERIFY }, onlySync))).status, 403);
	assert.equal((await fetch(`${base}/api/pipelines`, { headers: { cookie: onlySync } })).status, 200, "a sync-only role may read the list");

	const nothing = await inviteSession(admin, { email: "nothing@example.com", permissions: ["activity.read.own"] });
	assert.equal((await fetch(`${base}/api/pipelines`, { headers: { cookie: nothing } })).status, 403);
	assert.equal((await fetch(`${base}/api/pipelines/validate`, json("POST", { source: VERIFY }, nothing))).status, 403);
});

test("delete is refused with 409 in_use while a template's step names the pipeline", async () => {
	const admin = await login(base);
	const pipeline = await createPipeline(admin, VERIFY.replace("name: verify", "name: referenced"));
	const templateId = "tpl-uses-pipeline";
	const db = new DatabaseSync(tmpDb);
	const now = new Date().toISOString();
	db.prepare("INSERT INTO templates (id, name, tags, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
		templateId,
		"Uses pipeline",
		"[]",
		JSON.stringify({ steps: [{ kind: "command", pipelineId: pipeline.id, pipelineInputs: {} }] }),
		now,
		now,
	);
	db.close();

	const refused = await fetch(`${base}/api/pipelines/${pipeline.id}`, { method: "DELETE", headers: { cookie: admin } });
	assert.equal(refused.status, 409);
	const body = await refused.json();
	assert.equal(body.error, "in_use");
	assert.deepEqual(body.templates, [{ id: templateId, name: "Uses pipeline" }]);

	const removed = await fetch(`${base}/api/templates/${templateId}`, { method: "DELETE", headers: { cookie: admin } });
	assert.equal(removed.status, 200);
	const allowed = await fetch(`${base}/api/pipelines/${pipeline.id}`, { method: "DELETE", headers: { cookie: admin } });
	assert.equal(allowed.status, 200);
});

test("sync roles are stored for pipelines and an unknown role is refused with 422", async () => {
	const admin = await login(base);
	const role = await (await fetch(`${base}/api/auth/roles`, json("POST", { name: "Pipeline syncers", permissions: ["client.pipelines.sync"] }, admin))).json();
	const withRole = await createPipeline(admin, VERIFY.replace("name: verify", "name: scoped"), { syncRoleIds: [role.role.id] });
	assert.deepEqual(withRole.syncRoleIds, [role.role.id]);
	const unknown = await fetch(`${base}/api/pipelines`, json("POST", { source: VERIFY, syncRoleIds: ["no-such-role"] }, admin));
	assert.equal(unknown.status, 422);
});

test("the default admin role holds all six pipeline permissions", async () => {
	const admin = await login(base);
	const res = await fetch(`${base}/api/auth/roles`, { headers: { cookie: admin } });
	const roles = (await res.json()).roles;
	const administrator = roles.find((r) => r.id === "admin");
	for (const action of ["create", "edit", "delete", "import", "export", "sync"]) {
		assert.ok(administrator.permissions.includes(`client.pipelines.${action}`), `admin missing ${action}`);
	}
	assert.ok(DEFAULT_ADMIN_EMAIL);
});
