import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ADMIN_EMAIL, login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-catalog-sync-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.TARGET_DEVICE_LINKING_MODE = "optional";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
const db = await import("../db.mjs");
const { hashToken } = await import("../auth.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const json = (method, body, cookie) => ({
	method,
	headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
	body: JSON.stringify(body),
});

function linkDevice({ requestId, ownerUserId, secret }) {
	db.createDeviceLinkRequest({
		id: requestId,
		deviceName: "Catalog sync hub",
		publicKey: `ed25519-${requestId}`,
		scopes: ["ingest:write", "sync:write"],
		pollingCredentialHash: hashToken(`${requestId}-poll`),
		expiresAt: "2027-01-01T00:00:00.000Z",
	});
	db.decideDeviceLinkRequest({
		requestId,
		ownerUserId,
		decision: "approved",
		decidedAt: "2026-01-01T00:00:00.000Z",
	});
	return db.consumeDeviceLinkRequest({
		requestId,
		pollingCredentialHash: hashToken(`${requestId}-poll`),
		deviceId: `dev-${requestId}`,
		deviceSecretHash: hashToken(secret),
		consumedAt: "2026-01-01T00:00:01.000Z",
	});
}

async function registerLinkedHub({ requestId, ownerUserId, secret, capabilities = null }) {
	linkDevice({ requestId, ownerUserId, secret });
	const headers = { authorization: `Target-Device v1 dev-${requestId}.${secret}`, "content-type": "application/json" };
	const register = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers,
		body: JSON.stringify({ name: requestId, ...(capabilities ? { capabilities } : {}) }),
	});
	assert.equal(register.status, 201);
	return headers;
}

async function pullCatalog(headers) {
	return fetch(`${base}/api/sync/catalog`, { headers });
}

function assertNoSyncRoleIds(value) {
	assert.equal(JSON.stringify(value).includes("syncRoleIds"), false);
}

function seedCatalog({ listedRoleId, otherRoleId }) {
	const listedTcp = db.createTcp({
		name: "Listed tcp",
		tags: ["listed"],
		tools: [{ name: "echo", requestTemplate: "echo hi", tokens: { TOKEN: "keep-me" } }],
		syncRoleIds: [listedRoleId],
	});
	const hiddenTcp = db.createTcp({
		name: "Hidden tcp",
		tools: [{ name: "secret", requestTemplate: "secret" }],
		syncRoleIds: [otherRoleId],
	});
	const emptyTcp = db.createTcp({
		name: "Empty tcp",
		tools: [{ name: "noop", requestTemplate: "noop" }],
		syncRoleIds: [],
	});
	const listedRci = db.createResourceSet({
		name: "Listed rci",
		tags: ["listed"],
		resources: [{ name: "guide", kind: "doc", content: "# listed" }],
		syncRoleIds: [listedRoleId],
	});
	const hiddenRci = db.createResourceSet({
		name: "Hidden rci",
		resources: [{ name: "hidden", kind: "doc", content: "# hidden" }],
		syncRoleIds: [otherRoleId],
	});
	const emptyRci = db.createResourceSet({ name: "Empty rci", syncRoleIds: [] });
	const listedTemplate = db.createTemplate({
		name: "Listed template",
		tags: ["listed"],
		steps: [{ description: "Do the listed work" }],
		tcpSelections: [{ tcpId: listedTcp.id }, { tcpId: hiddenTcp.id }],
		resourceSelections: [{ resourceSetId: listedRci.id }, { resourceSetId: hiddenRci.id }],
		syncRoleIds: [listedRoleId],
	});
	const hiddenTemplate = db.createTemplate({
		name: "Hidden template",
		steps: [{ description: "Hidden" }],
		syncRoleIds: [otherRoleId],
	});
	const emptyTemplate = db.createTemplate({ name: "Empty template", syncRoleIds: [] });
	return {
		listedTcp,
		hiddenTcp,
		emptyTcp,
		listedRci,
		hiddenRci,
		emptyRci,
		listedTemplate,
		hiddenTemplate,
		emptyTemplate,
	};
}

test("GET /api/sync/catalog is 401 without credentials", async () => {
	assert.equal((await fetch(`${base}/api/sync/catalog`)).status, 401);
});

test("legacy token client cannot pull the catalog", async () => {
	const register = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "Legacy catalog client" }),
	});
	assert.equal(register.status, 201);
	const { client_token } = await register.json();
	const res = await pullCatalog({ authorization: `Bearer ${client_token}` });
	assert.equal(res.status, 403);
	assert.deepEqual(await res.json(), { error: "owner_required" });
});

test("linked catalog pull respects permissions, allowlists, admin bypass and selection filtering", async () => {
	await login(base);
	const other = db.createRole({ name: "Other catalog role", permissions: ["activity.read"] });
	const listed = db.createRole({
		name: "Listed catalog syncer",
		permissions: ["client.templates.sync", "client.tcp-tools.sync", "client.rci.sync"],
	});
	const templatesOnly = db.createRole({ name: "Templates only syncer", permissions: ["client.templates.sync"] });
	const tcpOnly = db.createRole({ name: "TCP only syncer", permissions: ["client.tcp-tools.sync"] });
	const rciOnly = db.createRole({ name: "RCI only syncer", permissions: ["client.rci.sync"] });
	const noSync = db.createRole({ name: "No catalog sync", permissions: ["client.read"] });

	const catalog = seedCatalog({ listedRoleId: listed.id, otherRoleId: other.id });
	db.updateTemplate(catalog.listedTemplate.id, { syncRoleIds: [listed.id, templatesOnly.id] });
	db.updateTcp(catalog.listedTcp.id, { syncRoleIds: [listed.id, tcpOnly.id] });
	db.updateResourceSet(catalog.listedRci.id, { syncRoleIds: [listed.id, rciOnly.id] });

	const listedUser = db.createAuthUser({ email: "catalog-listed@example.test", roleId: listed.id });
	const templatesUser = db.createAuthUser({ email: "catalog-templates@example.test", roleId: templatesOnly.id });
	const tcpUser = db.createAuthUser({ email: "catalog-tcp@example.test", roleId: tcpOnly.id });
	const rciUser = db.createAuthUser({ email: "catalog-rci@example.test", roleId: rciOnly.id });
	const noSyncUser = db.createAuthUser({ email: "catalog-nosync@example.test", roleId: noSync.id });
	const adminUser = db.getAuthUserByEmail(DEFAULT_ADMIN_EMAIL);

	const listedHeaders = await registerLinkedHub({ requestId: "catalog-listed", ownerUserId: listedUser.id, secret: "listed-secret" });
	const listedRes = await pullCatalog(listedHeaders);
	assert.equal(listedRes.status, 200);
	const listedBody = await listedRes.json();
	assert.equal(listedBody.contract_version, "catalog-sync/v1");
	assert.equal(typeof listedBody.server_time, "string");
	assert.equal(listedBody.owner_id, listedUser.id);
	assert.deepEqual(listedBody.allowed, { templates: true, tcp_tools: true, resource_sets: true, pipelines: false });
	assert.deepEqual(listedBody.templates.map((item) => item.id), [catalog.listedTemplate.id]);
	assert.deepEqual(listedBody.tcp_tools.map((item) => item.id), [catalog.listedTcp.id]);
	assert.deepEqual(listedBody.resource_sets.map((item) => item.id), [catalog.listedRci.id]);
	assert.deepEqual(listedBody.templates[0].data.tcpSelections.map((selection) => selection.tcpId), [catalog.listedTcp.id]);
	assert.deepEqual(listedBody.templates[0].data.resourceSelections.map((selection) => selection.resourceSetId), [catalog.listedRci.id]);
	assert.equal(listedBody.tcp_tools[0].data.tools[0].tokens.TOKEN, "keep-me");
	assert.equal(listedBody.templates[0].data.tags.join(","), "listed");
	assertNoSyncRoleIds(listedBody);

	const templatesHeaders = await registerLinkedHub({
		requestId: "catalog-templates",
		ownerUserId: templatesUser.id,
		secret: "templates-secret",
	});
	const templatesBody = await (await pullCatalog(templatesHeaders)).json();
	assert.deepEqual(templatesBody.allowed, { templates: true, tcp_tools: false, resource_sets: false, pipelines: false });
	assert.deepEqual(templatesBody.templates.map((item) => item.id), [catalog.listedTemplate.id]);
	assert.deepEqual(templatesBody.tcp_tools, []);
	assert.deepEqual(templatesBody.resource_sets, []);
	assert.deepEqual(templatesBody.templates[0].data.tcpSelections, []);
	assert.deepEqual(templatesBody.templates[0].data.resourceSelections, []);

	const tcpHeaders = await registerLinkedHub({ requestId: "catalog-tcp", ownerUserId: tcpUser.id, secret: "tcp-secret" });
	const tcpBody = await (await pullCatalog(tcpHeaders)).json();
	assert.deepEqual(tcpBody.allowed, { templates: false, tcp_tools: true, resource_sets: false, pipelines: false });
	assert.deepEqual(tcpBody.templates, []);
	assert.deepEqual(tcpBody.tcp_tools.map((item) => item.id), [catalog.listedTcp.id]);
	assert.deepEqual(tcpBody.resource_sets, []);

	const rciHeaders = await registerLinkedHub({ requestId: "catalog-rci", ownerUserId: rciUser.id, secret: "rci-secret" });
	const rciBody = await (await pullCatalog(rciHeaders)).json();
	assert.deepEqual(rciBody.allowed, { templates: false, tcp_tools: false, resource_sets: true, pipelines: false });
	assert.deepEqual(rciBody.templates, []);
	assert.deepEqual(rciBody.tcp_tools, []);
	assert.deepEqual(rciBody.resource_sets.map((item) => item.id), [catalog.listedRci.id]);

	const noneHeaders = await registerLinkedHub({ requestId: "catalog-none", ownerUserId: noSyncUser.id, secret: "none-secret" });
	const noneBody = await (await pullCatalog(noneHeaders)).json();
	assert.deepEqual(noneBody.allowed, { templates: false, tcp_tools: false, resource_sets: false, pipelines: false });
	assert.deepEqual(noneBody.templates, []);
	assert.deepEqual(noneBody.tcp_tools, []);
	assert.deepEqual(noneBody.resource_sets, []);

	const adminHeaders = await registerLinkedHub({ requestId: "catalog-admin", ownerUserId: adminUser.id, secret: "admin-secret" });
	const adminRes = await pullCatalog(adminHeaders);
	assert.equal(adminRes.status, 200);
	const adminBody = await adminRes.json();
	assert.deepEqual(adminBody.allowed, { templates: true, tcp_tools: true, resource_sets: true, pipelines: false });
	const adminTemplateIds = adminBody.templates.map((item) => item.id);
	assert.ok(adminTemplateIds.includes(catalog.listedTemplate.id));
	assert.ok(adminTemplateIds.includes(catalog.hiddenTemplate.id));
	assert.ok(adminTemplateIds.includes(catalog.emptyTemplate.id));
	const adminTcpIds = adminBody.tcp_tools.map((item) => item.id);
	assert.ok(adminTcpIds.includes(catalog.listedTcp.id));
	assert.ok(adminTcpIds.includes(catalog.hiddenTcp.id));
	assert.ok(adminTcpIds.includes(catalog.emptyTcp.id));
	const adminRciIds = adminBody.resource_sets.map((item) => item.id);
	assert.ok(adminRciIds.includes(catalog.listedRci.id));
	assert.ok(adminRciIds.includes(catalog.hiddenRci.id));
	assert.ok(adminRciIds.includes(catalog.emptyRci.id));
	const adminListed = adminBody.templates.find((item) => item.id === catalog.listedTemplate.id);
	assert.deepEqual(
		adminListed.data.tcpSelections.map((selection) => selection.tcpId).sort(),
		[catalog.hiddenTcp.id, catalog.listedTcp.id].sort(),
	);
	assert.deepEqual(
		adminListed.data.resourceSelections.map((selection) => selection.resourceSetId).sort(),
		[catalog.hiddenRci.id, catalog.listedRci.id].sort(),
	);
	assertNoSyncRoleIds(adminBody);
});

// --- Pipelines in the catalogue (docs/pipelines.md, "Phase 2") ---------------
// A hub gets pipelines and command-step templates only when it advertises the
// `pipelines` capability AND its owner holds client.pipelines.sync. Every test
// below states which of the two it is checking.

const PIPELINE_HUB = { resources: { version: 2, tcp_tools: true, resource_sets: true, pipelines: true } };

const PIPELINE_SOURCE = `name: verify-sync
inputs:
  package:
    default: hub
steps:
  - run: npm test
    working-directory: \${{ inputs.package }}
`;

const PIPELINE_NEEDS_INPUT = `name: needs-input
inputs:
  target:
    required: true
steps:
  - run: echo "$TARGET"
    env:
      TARGET: \${{ inputs.target }}
`;

test("pipelines and command-step templates reach only hubs that advertise pipelines and hold client.pipelines.sync", async () => {
	await login(base);
	const syncer = db.createRole({ name: "Pipeline syncer", permissions: ["client.pipelines.sync", "client.templates.sync"] });
	const templatesOnly = db.createRole({ name: "Pipeline-less syncer", permissions: ["client.templates.sync"] });
	const pipeline = db.createPipeline({ source: PIPELINE_SOURCE, syncRoleIds: [syncer.id] });
	const hidden = db.createPipeline({ source: PIPELINE_SOURCE.replace("verify-sync", "hidden-sync"), syncRoleIds: [] });
	const commandTemplate = db.createTemplate({
		name: "Command template",
		steps: [{ kind: "command", pipelineId: pipeline.id, pipelineInputs: {} }],
		syncRoleIds: [syncer.id, templatesOnly.id],
	});
	const agentTemplate = db.createTemplate({
		name: "Agent template",
		steps: [{ description: "Write the docs" }],
		syncRoleIds: [syncer.id, templatesOnly.id],
	});
	const syncerUser = db.createAuthUser({ email: "pipes-syncer@example.test", roleId: syncer.id });
	const plainUser = db.createAuthUser({ email: "pipes-plain@example.test", roleId: templatesOnly.id });

	// Case 1: a hub that does not advertise `pipelines` (an older hub). It gets no
	// pipelines domain, no pipeline id, no pipeline source, and no command template.
	const legacy = await registerLinkedHub({ requestId: "pipes-legacy", ownerUserId: syncerUser.id, secret: "pipes-legacy-secret" });
	const legacyRaw = await (await pullCatalog(legacy)).text();
	const legacyBody = JSON.parse(legacyRaw);
	assert.equal(legacyBody.allowed.pipelines, false);
	assert.equal("pipelines" in legacyBody, false, "the pipelines domain is omitted entirely");
	assert.deepEqual(legacyBody.templates.map((item) => item.id), [agentTemplate.id]);
	assert.equal(legacyRaw.includes(pipeline.id), false, "no pipeline id reaches a hub without the capability");
	assert.equal(legacyRaw.includes("npm test"), false, "no pipeline source reaches a hub without the capability");
	assert.equal(legacyRaw.includes(commandTemplate.id), false, "no command-step template reaches a hub without the capability");

	// Case 2: a hub that advertises `pipelines`, owned by a role with the grant.
	const capable = await registerLinkedHub({
		requestId: "pipes-capable",
		ownerUserId: syncerUser.id,
		secret: "pipes-capable-secret",
		capabilities: PIPELINE_HUB,
	});
	const capableRaw = await (await pullCatalog(capable)).text();
	const capableBody = JSON.parse(capableRaw);
	assert.equal(capableBody.allowed.pipelines, true);
	assert.deepEqual(capableBody.pipelines.map((item) => item.id), [pipeline.id]);
	const shipped = capableBody.pipelines[0];
	assert.equal(shipped.name, "verify-sync");
	assert.equal(shipped.data.source, PIPELINE_SOURCE);
	assert.equal(shipped.data.sourceHash, pipeline.sourceHash);
	assert.deepEqual(Object.keys(shipped.data).sort(), ["source", "sourceHash", "tags"], "the item carries no other fields");
	assert.equal(capableRaw.includes(hidden.id), false, "a pipeline the owner is not granted is not sent");
	assert.deepEqual(capableBody.templates.map((item) => item.id).sort(), [agentTemplate.id, commandTemplate.id].sort());
	const command = capableBody.templates.find((item) => item.id === commandTemplate.id).data.steps[0];
	assert.equal(command.kind, "command");
	assert.equal(command.pipelineId, pipeline.id);
	assert.deepEqual(command.pipelineInputs, {});
	assert.equal(command.useSubagent, false, "a command step never has a subagent");
	assert.equal(command.acceptanceCriteria, null, "a command step never has acceptance criteria");
	assertNoSyncRoleIds(capableBody);

	// Case 3: a hub that advertises `pipelines`, but its owner lacks client.pipelines.sync.
	const noGrant = await registerLinkedHub({
		requestId: "pipes-nogrant",
		ownerUserId: plainUser.id,
		secret: "pipes-nogrant-secret",
		capabilities: PIPELINE_HUB,
	});
	const noGrantBody = await (await pullCatalog(noGrant)).json();
	assert.equal(noGrantBody.allowed.pipelines, false);
	assert.deepEqual(noGrantBody.pipelines, []);
	assert.deepEqual(noGrantBody.templates.map((item) => item.id), [agentTemplate.id]);
});

test("a remote workflow from a command-step template is refused without the capability and refused for an ungranted pipeline", async () => {
	const admin = await login(base);
	const syncer = db.createRole({ name: "Remote pipeline syncer", permissions: ["client.pipelines.sync", "client.templates.sync"] });
	const syncerUser = db.createAuthUser({ email: "pipes-remote@example.test", roleId: syncer.id });
	const granted = db.createPipeline({ source: PIPELINE_SOURCE, syncRoleIds: [syncer.id] });
	const ungranted = db.createPipeline({ source: PIPELINE_SOURCE.replace("verify-sync", "ungranted-sync"), syncRoleIds: [] });
	const grantedTemplate = db.createTemplate({
		name: "Granted command template",
		steps: [{ kind: "command", pipelineId: granted.id, pipelineInputs: {} }],
	});
	const ungrantedTemplate = db.createTemplate({
		name: "Ungranted command template",
		steps: [{ kind: "command", pipelineId: ungranted.id, pipelineInputs: {} }],
	});

	await registerLinkedHub({ requestId: "pipes-remote-legacy", ownerUserId: syncerUser.id, secret: "pipes-remote-legacy-secret" });
	await registerLinkedHub({
		requestId: "pipes-remote-capable",
		ownerUserId: syncerUser.id,
		secret: "pipes-remote-capable-secret",
		capabilities: PIPELINE_HUB,
	});
	const post = (body) =>
		fetch(`${base}/api/sync/remote-workflows`, json("POST", body, admin));

	const legacy = await post({ client_id: "dev-pipes-remote-legacy", name: "Legacy run", template_id: grantedTemplate.id });
	assert.equal(legacy.status, 409);
	const legacyBody = await legacy.json();
	assert.equal(legacyBody.error, "capability_unsupported");
	assert.equal(legacyBody.required.domain, "pipelines");

	const notGranted = await post({ client_id: "dev-pipes-remote-capable", name: "Ungranted run", template_id: ungrantedTemplate.id });
	assert.equal(notGranted.status, 409);
	const notGrantedBody = await notGranted.json();
	assert.equal(notGrantedBody.error, "pipeline_not_synced");
	assert.deepEqual(notGrantedBody.pipelineIds, [ungranted.id]);

	const allowed = await post({ client_id: "dev-pipes-remote-capable", name: "Granted run", template_id: grantedTemplate.id });
	assert.equal(allowed.status, 201, await allowed.clone().text());
	const sqlite = new DatabaseSync(tmpDb);
	const stepAdds = sqlite
		.prepare("SELECT payload_json FROM commands WHERE client_id = ? AND type = 'step.add' ORDER BY sequence")
		.all("dev-pipes-remote-capable")
		.map((row) => JSON.parse(row.payload_json));
	sqlite.close();
	assert.equal(stepAdds.length, 1);
	assert.equal(stepAdds[0].kind, "command");
	assert.equal(stepAdds[0].pipeline_id, granted.id);
	assert.equal(stepAdds[0].use_subagent, false);
	assert.equal("acceptance_criteria" in stepAdds[0], false);
});

test("a command step is validated on template save against the org's pipelines and their declared inputs", async () => {
	const admin = await login(base);
	const needs = db.createPipeline({ source: PIPELINE_NEEDS_INPUT });

	// Unknown pipeline.
	assert.throws(
		() => db.createTemplate({ name: "Bad pipeline", steps: [{ kind: "command", pipelineId: "no-such-pipeline" }] }),
		(err) => err.code === "invalid_template_step" && err.statusCode === 422 && err.errors[0].path === "steps[0].pipelineId",
	);
	// Required input missing, and an undeclared input given.
	assert.throws(
		() => db.createTemplate({ name: "Missing input", steps: [{ kind: "command", pipelineId: needs.id, pipelineInputs: {} }] }),
		(err) => err.errors.some((e) => e.message === 'missing input "target"'),
	);
	assert.throws(
		() =>
			db.createTemplate({
				name: "Extra input",
				steps: [{ kind: "command", pipelineId: needs.id, pipelineInputs: { target: "x", nope: "y" } }],
			}),
		(err) => err.errors.some((e) => e.message === 'unknown input "nope"'),
	);
	// A good step is saved; its empty description is the pipeline's name.
	const good = db.createTemplate({
		name: "Good",
		steps: [{ kind: "command", pipelineId: needs.id, pipelineInputs: { target: "x" } }],
	});
	assert.equal(good.steps[0].description, "needs-input");
	assert.deepEqual(good.pipelineIds, [needs.id]);

	// Over the API: the same refusals are 422 invalid_template_step with the problems.
	const bad = await fetch(`${base}/api/templates`, json("POST", { name: "API bad", steps: [{ kind: "command", pipelineId: needs.id, pipelineInputs: {} }] }, admin));
	assert.equal(bad.status, 422);
	const badBody = await bad.json();
	assert.equal(badBody.error, "invalid_template_step");
	assert.equal(badBody.errors[0].message, 'missing input "target"');
	const ok = await fetch(`${base}/api/templates`, json("POST", { name: "API good", steps: [{ kind: "command", pipelineId: needs.id, pipelineInputs: { target: "x" } }] }, admin));
	assert.equal(ok.status, 201);
	const okTemplate = (await ok.json()).template;
	assert.deepEqual(okTemplate.pipelineIds, [needs.id]);
	assert.equal(okTemplate.steps[0].useSubagent, false);
});
