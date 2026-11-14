/**
 * Portable template bundles (version 2) on the server: plan section 3, cases 1–13.
 * A bundle carries the YAML of every pipeline its command steps use, and an import
 * resolves each one by content hash. Identical text in the same organization is
 * reused with its roles untouched. Anything else is created with NO sync roles.
 * Every case runs against one isolated database under the OS temp directory. Case 12
 * uses a second organization's database, and case 11 uses the hub's own export shape
 * (test/fixtures/hub-template-bundle-v2.json).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { login } from "./helpers.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-template-bundles-"));
const tmpDb = path.join(tmpDir, "t.db");
const orgBDb = path.join(tmpDir, "org-b.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
	db.closeOrgDb("org-case12");
	server.close();
});

const db = await import("../db.mjs");
const { sourceHash } = await import("../pipeline-yaml.mjs");
const ADMIN_ROLE = db.ADMIN_ROLE_ID;
// One login for the whole file: the server rate-limits logins, and every case uses the same admin.
const adminCookie = await login(base);

// ---- HTTP and database helpers --------------------------------------------------

async function request(method, route, cookie, body) {
	const headers = { cookie };
	const init = { method, headers };
	if (body !== undefined) {
		headers["content-type"] = "application/json";
		init.body = JSON.stringify(body);
	}
	const res = await fetch(`${base}${route}`, init);
	const text = await res.text();
	let parsed = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}
	return { status: res.status, body: parsed };
}

/** The YAML of a pipeline that validates. The name lives inside the text, so name and text change together. */
const pipelineText = (name, command = `echo ${name}`) => `name: ${name}\nsteps:\n  - run: ${command}\n`;

/** Rows of a database file, read directly so the count is the stored truth, not an API view. */
function pipelineRows(file = tmpDb) {
	const handle = new DatabaseSync(file);
	try {
		return handle.prepare("SELECT id, name, source_hash AS sourceHash FROM pipelines ORDER BY rowid").all();
	} finally {
		handle.close();
	}
}

const rowCount = (file = tmpDb) => pipelineRows(file).length;
const rowsWithHash = (text, file = tmpDb) => pipelineRows(file).filter((row) => row.sourceHash === sourceHash(text));

async function templateCount(admin) {
	return (await request("GET", "/api/templates", admin)).body.templates.length;
}

async function createPipeline(admin, source, extra = {}) {
	const res = await request("POST", "/api/pipelines", admin, { source, ...extra });
	assert.equal(res.status, 201, JSON.stringify(res.body));
	return res.body.pipeline;
}

async function createTemplate(admin, body) {
	const res = await request("POST", "/api/templates", admin, body);
	assert.equal(res.status, 201, JSON.stringify(res.body));
	return res.body.template;
}

/** An agent step as the template editor stores it. */
const agentStep = (description) => ({
	description,
	acceptanceCriteria: null,
	manualReview: false,
	useSubagent: true,
	maxRetries: 0,
	retryIntervalSeconds: 0,
});

/** A command step as a stored template holds it, with a local pipeline id. */
const commandStep = (pipelineId, description = "run it") => ({ kind: "command", pipelineId, pipelineInputs: {}, description });

// ---- Bundle builders -------------------------------------------------------------

/** A version 2 bundle file, built by hand so each test states exactly what the file says. */
function bundle(templates, pipelines, schemaVersion = 2) {
	return {
		kind: "target.templates",
		schemaVersion,
		exportedAt: "2026-11-13T12:00:00.000Z",
		templates,
		...(pipelines === undefined ? {} : { pipelines }),
	};
}

function fileTemplate(name, steps) {
	return { name, tags: [], steps, tcpIds: [], tcpSelections: [], resourceSelections: [] };
}

/** A command step as a version 2 bundle carries it: `pipelineRef`, never `pipelineId`. */
function refStep(description, pipelineRef) {
	return {
		description,
		kind: "command",
		pipelineRef,
		pipelineInputs: {},
		acceptanceCriteria: null,
		manualReview: false,
		useSubagent: false,
		maxRetries: 0,
		retryIntervalSeconds: 0,
	};
}

function embedded(ref, name, source, claimedHash = "0".repeat(64)) {
	return { ref, name, tags: [], source, sourceHash: claimedHash };
}

const importBundle = (admin, doc) => request("POST", "/api/templates/import", admin, doc);

// ---- Case 1: export shape -------------------------------------------------------

test("case 1: a fresh export is schemaVersion 2 and lists each pipeline once, with refs and no local ids or sync roles", async () => {
	const admin = adminCookie;
	const text = pipelineText("case1-export");
	const pipeline = await createPipeline(admin, text, { tags: ["ci"], syncRoleIds: [ADMIN_ROLE] });
	const createdFirst = await createTemplate(admin, { name: "case1 first", steps: [commandStep(pipeline.id), commandStep(pipeline.id)] });
	await createTemplate(admin, { name: "case1 second", steps: [commandStep(pipeline.id), agentStep("Review the result")] });

	const exported = await request("GET", "/api/templates/export", admin);
	assert.equal(exported.status, 200);
	const out = exported.body;
	assert.equal(out.kind, "target.templates");
	assert.equal(out.schemaVersion, 2, "a fresh export is version 2");

	const entries = out.pipelines.filter((entry) => entry.source === text);
	assert.equal(entries.length, 1, "one entry however many steps and templates use the pipeline");
	assert.deepEqual(Object.keys(entries[0]).sort(), ["name", "ref", "source", "sourceHash", "tags"]);
	assert.equal(entries[0].sourceHash, sourceHash(text));
	assert.deepEqual(entries[0].tags, ["ci"]);
	const ref = entries[0].ref;

	const first = out.templates.find((t) => t.name === "case1 first");
	const second = out.templates.find((t) => t.name === "case1 second");
	for (const step of [...first.steps, ...second.steps]) {
		assert.ok(!("pipelineId" in step), "a step never carries the local pipelineId");
	}
	assert.deepEqual(
		first.steps.map((s) => s.pipelineRef),
		[ref, ref],
		"both command steps of the first template name the shared ref",
	);
	assert.equal(second.steps.find((s) => s.kind === "command").pipelineRef, ref);
	assert.ok(!("pipelineRef" in second.steps.find((s) => s.kind !== "command")), "an agent step has no pipelineRef");
	assert.equal(second.steps.find((s) => s.kind !== "command").kind, "task", "an agent step is exported as a task, as the hub writes it");
	assert.equal(second.steps.find((s) => s.kind !== "command").pipelineInputs, null);

	const serialized = JSON.stringify(out);
	assert.ok(!serialized.includes("syncRoleIds"), "no sync roles anywhere in the bundle");
	assert.ok(!serialized.includes(pipeline.id), "no local pipeline id anywhere in the bundle");

	const single = await request("GET", `/api/templates/${createdFirst.id}/export`, admin);
	assert.equal(single.status, 200);
	assert.equal(single.body.schemaVersion, 2);
	assert.equal(single.body.pipelines.length, 1);
});

// ---- Case 2: import into an org without the pipeline ---------------------------

test("case 2: importing a pipeline this org lacks creates it with NO sync roles, and the step points at it", async () => {
	const admin = adminCookie;
	const text = pipelineText("case2-fresh");
	const before = rowCount();

	const res = await importBundle(
		admin,
		bundle([fileTemplate("case2 template", [refStep("Run it", "p1")])], [embedded("p1", "case2-fresh", text)]),
	);

	assert.equal(res.status, 201, JSON.stringify(res.body));
	assert.deepEqual(res.body.pipelines.map((p) => [p.ref, p.action]), [["p1", "created"]]);
	const created = res.body.pipelines[0].pipeline;
	assert.equal(created.source, text);
	assert.deepEqual(created.syncRoleIds, [], "a created pipeline has no sync roles");
	assert.equal(rowCount(), before + 1, "exactly one new pipeline row");
	assert.equal(res.body.templates[0].steps[0].pipelineId, created.id, "the step points at the created row");
	assert.deepEqual(res.body.warnings, []);

	const stored = await request("GET", `/api/pipelines/${created.id}`, admin);
	assert.equal(stored.status, 200);
	assert.deepEqual(stored.body.pipeline.syncRoleIds, [], "the stored copy has no sync roles either");
});

// ---- Case 3: identical pipeline already here ------------------------------------

test("case 3: an identical pipeline already here is reused: no new row, its roles untouched, the step points at it", async () => {
	const admin = adminCookie;
	const text = pipelineText("case3-reuse");
	const existing = await createPipeline(admin, text, { syncRoleIds: [ADMIN_ROLE] });
	const before = rowCount();

	const res = await importBundle(
		admin,
		bundle([fileTemplate("case3 template", [refStep("Run it", "p1")])], [embedded("p1", "case3-reuse", text)]),
	);

	assert.equal(res.status, 201, JSON.stringify(res.body));
	assert.equal(res.body.pipelines[0].action, "reused");
	assert.equal(res.body.pipelines[0].pipeline.id, existing.id);
	assert.deepEqual(res.body.pipelines[0].pipeline.syncRoleIds, [ADMIN_ROLE], "the existing roles are kept");
	assert.equal(rowCount(), before, "no new pipeline row");
	assert.equal(res.body.templates[0].steps[0].pipelineId, existing.id);
	assert.deepEqual(res.body.warnings, []);
});

// ---- Case 4: same name, different text -----------------------------------------

test("case 4: a same-named pipeline with other text is created separately, and pipeline_name_conflict is reported", async () => {
	const admin = adminCookie;
	const local = await createPipeline(admin, pipelineText("case4-name", "echo local"));
	const bundledText = pipelineText("case4-name", "echo from-the-bundle");
	const before = rowCount();

	const res = await importBundle(
		admin,
		bundle([fileTemplate("case4 template", [refStep("Run it", "p1")])], [embedded("p1", "case4-name", bundledText)]),
	);

	assert.equal(res.status, 201, JSON.stringify(res.body));
	assert.equal(res.body.pipelines[0].action, "created");
	const created = res.body.pipelines[0].pipeline;
	assert.notEqual(created.id, local.id, "never bound to the local text");
	assert.equal(created.source, bundledText, "the exact bundled text is what runs");
	assert.deepEqual(created.syncRoleIds, []);
	assert.equal(rowCount(), before + 1);
	assert.equal(res.body.templates[0].steps[0].pipelineId, created.id);
	assert.deepEqual(res.body.warnings, [{ code: "pipeline_name_conflict", ref: "p1", name: "case4-name" }]);
});

// ---- Case 5: the same bundle twice ----------------------------------------------

test("case 5: the same bundle twice: the second import reuses the pipeline and creates no duplicate", async () => {
	const admin = adminCookie;
	const text = pipelineText("case5-twice");
	const doc = bundle([fileTemplate("case5 template", [refStep("Run it", "p1")])], [embedded("p1", "case5-twice", text)]);
	const before = rowCount();

	const first = await importBundle(admin, doc);
	const second = await importBundle(admin, doc);

	assert.equal(first.status, 201);
	assert.equal(second.status, 201);
	assert.equal(first.body.pipelines[0].action, "created");
	assert.equal(second.body.pipelines[0].action, "reused");
	assert.equal(second.body.pipelines[0].pipeline.id, first.body.pipelines[0].pipeline.id);
	assert.equal(rowCount(), before + 1, "one row for two imports of the same text");
	assert.equal(rowsWithHash(text).length, 1);
	assert.equal(second.body.templates[0].steps[0].pipelineId, first.body.pipelines[0].pipeline.id);
});

// ---- Case 6: tampered sourceHash ------------------------------------------------

test("case 6: a tampered sourceHash in the file is ignored: the hash is recomputed from the text", async () => {
	const admin = adminCookie;
	const text = pipelineText("case6-tampered");
	const tampered = bundle(
		[fileTemplate("case6 tampered", [refStep("Run it", "p1")])],
		[embedded("p1", "case6-tampered", text, "f".repeat(64))],
	);

	const res = await importBundle(admin, tampered);

	assert.equal(res.status, 201, JSON.stringify(res.body));
	assert.equal(res.body.pipelines[0].action, "created");
	assert.equal(res.body.pipelines[0].pipeline.sourceHash, sourceHash(text), "the stored hash comes from the text");
	assert.equal(rowsWithHash(text).length, 1);
});

test("case 6b: a file claiming another pipeline's hash does not get that pipeline: the text decides", async () => {
	const admin = adminCookie;
	const existing = await createPipeline(admin, pipelineText("case6-existing"), { syncRoleIds: [ADMIN_ROLE] });
	const otherText = pipelineText("case6-other");
	const before = rowCount();

	const res = await importBundle(
		admin,
		bundle(
			[fileTemplate("case6b claim", [refStep("Run it", "p1")])],
			[embedded("p1", "case6-other", otherText, existing.sourceHash)],
		),
	);

	assert.equal(res.status, 201, JSON.stringify(res.body));
	assert.equal(res.body.pipelines[0].action, "created", "not reused on the strength of the claimed hash");
	assert.notEqual(res.body.pipelines[0].pipeline.id, existing.id);
	assert.equal(rowCount(), before + 1);
	const untouched = await request("GET", `/api/pipelines/${existing.id}`, admin);
	assert.equal(untouched.body.pipeline.source, pipelineText("case6-existing"));
	assert.deepEqual(untouched.body.pipeline.syncRoleIds, [ADMIN_ROLE], "the existing row keeps its roles");
});

// ---- Case 7: invalid YAML -------------------------------------------------------

test("case 7: invalid embedded YAML refuses the bundle with invalid_pipeline, and nothing is created", async () => {
	const admin = adminCookie;
	const pipelinesBefore = rowCount();
	const templatesBefore = await templateCount(admin);
	const good = pipelineText("case7-good");

	const res = await importBundle(
		admin,
		bundle(
			[fileTemplate("case7 refused", [refStep("Run it", "p1"), refStep("Run it", "p2")])],
			[
				embedded("p1", "case7-good", good),
				embedded("p2", "case7-bad", "name: case7-bad\nsteps:\n  - run: echo ok\n    shell: zsh\n"),
			],
		),
	);

	assert.equal(res.status, 400, JSON.stringify(res.body));
	assert.equal(res.body.error, "invalid_pipeline");
	assert.ok(res.body.errors.length >= 1);
	assert.ok(res.body.errors.some((e) => e.path.startsWith("pipelines[1]")), "the error names the bad entry");
	assert.equal(rowCount(), pipelinesBefore, "not even the valid pipeline is created");
	assert.equal(rowsWithHash(good).length, 0);
	assert.equal(await templateCount(admin), templatesBefore, "no template is created");
});

// ---- Case 8: a missing ref ------------------------------------------------------

test("case 8: a pipelineRef missing from pipelines[] imports the template with no pipeline, reporting unresolved_pipeline/missing_ref", async () => {
	const admin = adminCookie;

	const res = await importBundle(
		admin,
		bundle([fileTemplate("case8 missing ref", [agentStep("Plan the work"), refStep("Run it", "p9")])]),
	);

	assert.equal(res.status, 201, JSON.stringify(res.body));
	assert.equal(res.body.templates.length, 1, "the template is imported anyway");
	const steps = res.body.templates[0].steps;
	assert.ok(!steps[1].pipelineId, "the unresolved step keeps no pipeline");
	assert.deepEqual(res.body.pipelines, []);
	assert.deepEqual(res.body.warnings, [
		{ code: "unresolved_pipeline", template: "case8 missing ref", stepIndex: 1, reason: "missing_ref" },
	]);

	const exported = await request("GET", `/api/templates/${res.body.templates[0].id}/export`, admin);
	const step = exported.body.templates[0].steps[1];
	assert.ok(!("pipelineRef" in step), "the export names no pipeline for it");
	assert.ok(!("pipelineId" in step), "and no local id");
	assert.equal(step.pipelineInputs, null, "an unbound step has no inputs, as the hub writes it");
});

// ---- Case 9: version 1 bundles --------------------------------------------------

test("case 9: a version 1 bundle keeps a pipelineId that exists here; an unknown one is unresolved_pipeline/unknown_id", async () => {
	const admin = adminCookie;
	const known = await createPipeline(admin, pipelineText("case9-known"));
	const unknownId = "00000000-0000-4000-8000-000000000000";
	const v1 = {
		kind: "target.templates",
		schemaVersion: 1,
		templates: [
			fileTemplate("case9 v1", [
				{ kind: "command", pipelineId: known.id, pipelineInputs: {}, description: "run the known one" },
				{ kind: "command", pipelineId: unknownId, pipelineInputs: {}, description: "run the unknown one" },
			]),
		],
	};

	const res = await importBundle(admin, v1);

	assert.equal(res.status, 201, JSON.stringify(res.body));
	const steps = res.body.templates[0].steps;
	assert.equal(steps[0].pipelineId, known.id, "the id that exists here is kept");
	assert.ok(!steps[1].pipelineId, "the unknown id is not kept");
	assert.deepEqual(res.body.warnings, [
		{ code: "unresolved_pipeline", template: "case9 v1", stepIndex: 1, reason: "unknown_id" },
	]);
	assert.deepEqual(res.body.pipelines, [], "a version 1 bundle embeds no pipelines");
});

// ---- Case 10: a newer version ---------------------------------------------------

test("case 10: schemaVersion 3 is refused with unsupported_schema_version, and nothing is created", async () => {
	const admin = adminCookie;
	const pipelinesBefore = rowCount();
	const templatesBefore = await templateCount(admin);
	const newer = bundle(
		[fileTemplate("case10 too new", [])],
		[embedded("p1", "case10-new", pipelineText("case10-new"))],
		3,
	);

	const res = await importBundle(admin, newer);

	assert.equal(res.status, 400);
	assert.deepEqual(res.body, { error: "unsupported_schema_version" });
	assert.equal(rowCount(), pipelinesBefore);
	assert.equal(rowsWithHash(pipelineText("case10-new")).length, 0);
	assert.equal(await templateCount(admin), templatesBefore);
});

// ---- Case 11: a bundle exported by the hub --------------------------------------

test("case 11: a bundle with the hub's own export shape imports cleanly, and a pipeline shared by two templates is created once", async () => {
	const admin = adminCookie;
	const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/hub-template-bundle-v2.json", import.meta.url), "utf8"));

	// The fixture is the hub's output: its top-level keys, its pipeline entries and its real hashes.
	assert.deepEqual(Object.keys(fixture).sort(), ["exportedAt", "kind", "pipelines", "schemaVersion", "templates"]);
	assert.equal(fixture.schemaVersion, 2);
	for (const entry of fixture.pipelines) {
		assert.deepEqual(Object.keys(entry).sort(), ["name", "ref", "source", "sourceHash", "tags"]);
		assert.equal(entry.sourceHash, sourceHash(entry.source), `the hash of ${entry.ref} is the hub's`);
	}
	for (const template of fixture.templates) {
		for (const step of template.steps) assert.ok(!("pipelineId" in step), "the hub never writes a pipelineId");
	}

	const before = rowCount();
	const res = await importBundle(admin, fixture);

	assert.equal(res.status, 201, JSON.stringify(res.body));
	assert.deepEqual(res.body.templates.map((t) => t.name), ["Hub release", "Hub nightly"]);
	assert.deepEqual(res.body.pipelines.map((p) => [p.ref, p.action]), [["p1", "created"], ["p2", "created"]]);
	const [verify, lint] = res.body.pipelines.map((p) => p.pipeline);
	assert.deepEqual(verify.syncRoleIds, []);
	assert.deepEqual(lint.syncRoleIds, []);
	assert.equal(rowCount(), before + 2, "two pipelines created, one per ref");

	const [release, nightly] = res.body.templates;
	assert.equal(release.steps.find((s) => s.kind === "command").pipelineId, verify.id);
	assert.deepEqual(
		nightly.steps.map((s) => s.pipelineId),
		[verify.id, lint.id],
		"both templates point at the one shared row",
	);
	assert.deepEqual(res.body.warnings, []);

	const again = await importBundle(admin, fixture);
	assert.equal(again.status, 201);
	assert.deepEqual(again.body.pipelines.map((p) => p.action), ["reused", "reused"]);
	assert.equal(rowCount(), before + 2, "a second import of the same file creates nothing");
});

// ---- Case 12: another organization's pipeline is not reused ---------------------

test("case 12: a pipeline with the same text in ANOTHER organization is never reused", async () => {
	const admin = adminCookie;
	const text = pipelineText("case12-isolated");
	// Organization B lives in its own database and holds the same text.
	const orgBRow = db.runWithOrg(
		"org-case12",
		() => {
			db.open(orgBDb);
			return db.createPipeline({ source: text, tags: [], syncRoleIds: [] });
		},
		{ dbPath: orgBDb },
	);
	const doc = bundle([fileTemplate("case12 template", [refStep("Run it", "p1")])], [embedded("p1", "case12-isolated", text)]);

	// This organization has no such text, so it creates its own row.
	const res = await importBundle(admin, doc);

	assert.equal(res.status, 201, JSON.stringify(res.body));
	assert.equal(res.body.pipelines[0].action, "created", "the other organization's row is not reused");
	assert.notEqual(res.body.pipelines[0].pipeline.id, orgBRow.id);
	assert.equal(rowsWithHash(text, tmpDb).length, 1, "this organization: one row, its own");
	assert.equal(rowsWithHash(text, orgBDb).length, 1, "organization B: still exactly its own row");
	assert.equal(rowsWithHash(text, orgBDb)[0].id, orgBRow.id, "organization B's row is untouched");

	// Organization B's own import reuses its own row.
	const inB = db.runWithOrg(
		"org-case12",
		() => {
			db.open(orgBDb);
			return db.importTemplateBundle(doc);
		},
		{ dbPath: orgBDb },
	);
	assert.equal(inB.pipelines[0].action, "reused");
	assert.equal(inB.pipelines[0].pipelineId, orgBRow.id);
	assert.equal(rowsWithHash(text, orgBDb).length, 1);
});

// ---- Case 13: the standalone pipeline import ------------------------------------

test("case 13: POST /api/pipelines/import of an existing pipeline reports reused, and creates no duplicate row", async () => {
	const admin = adminCookie;
	const text = pipelineText("case13-standalone");
	const existing = await createPipeline(admin, text);
	const before = rowCount();

	const res = await request("POST", "/api/pipelines/import", admin, [{ source: text }]);

	assert.equal(res.status, 201, JSON.stringify(res.body));
	assert.equal(res.body.results[0].action, "reused");
	assert.equal(res.body.results[0].pipeline.id, existing.id);
	assert.equal(res.body.pipelines[0].id, existing.id, "pipelines still lists the entry");
	assert.equal(res.body.results.length, res.body.pipelines.length);
	assert.equal(rowCount(), before, "no duplicate row");

	const fresh = await request("POST", "/api/pipelines/import", admin, [{ source: pipelineText("case13-new") }]);
	assert.equal(fresh.body.results[0].action, "created");
	assert.equal(rowCount(), before + 1);
});

// ---- Bare shapes: a bare array of templates and a bare template -----------------

test("a bare array of templates and a bare template still import, with no pipelines and no warnings", async () => {
	const admin = adminCookie;
	const before = await templateCount(admin);

	const asArray = await importBundle(admin, [fileTemplate("bare array template", [agentStep("Plan the work")])]);
	assert.equal(asArray.status, 201, JSON.stringify(asArray.body));
	assert.deepEqual(asArray.body.templates.map((t) => t.name), ["bare array template"]);
	assert.deepEqual(asArray.body.pipelines, []);
	assert.deepEqual(asArray.body.warnings, []);

	const bare = await importBundle(admin, fileTemplate("bare single template", [agentStep("Plan the work")]));
	assert.equal(bare.status, 201, JSON.stringify(bare.body));
	assert.deepEqual(bare.body.templates.map((t) => t.name), ["bare single template"]);
	assert.deepEqual(bare.body.warnings, []);
	assert.equal(await templateCount(admin), before + 2);
});
