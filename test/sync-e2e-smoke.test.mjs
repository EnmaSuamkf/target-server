/**
 * End-to-end smoke: operator creates a remote workflow (2 steps + start),
 * then a catalog template with TCP/RCI; the hub applies steps (with notes)
 * and server-managed selections. Skipped when the hub is not checked out.
 *
 * Mirrors the manual checklist in README § Remote sync.
 * Skipped in CI when the target hub is not checked out alongside target-server.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { once } from "node:events";
import { authed, login } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const targetHubSync = path.resolve(here, "../../target/hub/sync.ts");
const hasTargetHub = fs.existsSync(targetHubSync);

test(
	"E2E smoke: remote workflow with 2 steps + start → local execution + server events",
	{ skip: hasTargetHub ? false : "Requires ../target/hub (clone target alongside target-server)" },
	async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "target-sync-smoke-"));
		process.env.TARGET_SERVER_DB = path.join(tmpRoot, "server.db");
		process.env.PORT = "0";
		process.env.HOST = "127.0.0.1";

		const clientHome = path.join(tmpRoot, "client");
		process.env.TARGET_HOME = path.join(clientHome, ".target");
		process.env.AWB_HOME = path.join(clientHome, ".awb");
		fs.mkdirSync(process.env.TARGET_HOME, { recursive: true });
		fs.mkdirSync(process.env.AWB_HOME, { recursive: true });

		await import("../../target/hub/test-setup.ts");

		const { server } = await import("../server.mjs");
		if (!server.listening) await once(server, "listening");
		const base = `http://127.0.0.1:${server.address().port}`;

		process.env.TARGET_SYNC_URL = base;
		process.env.TARGET_SYNC_ENABLED = "true";
		delete process.env.TARGET_SYNC_TOKEN;

		const { runSyncTick, resetSyncExecutorState } = await import("../../target/hub/sync.ts");
		const { loadConfig, loadSyncConfig } = await import("../../target/hub/config.ts");
		const { getWorkflowByRemoteId, listStepNotes, listSteps, getSyncCredentials } = await import("../../target/hub/db.ts");
		const { getTcp, listWorkflowTcpSelections } = await import("../../target/hub/tcp-store.ts");
		const { getResourceSet, listWorkflowResourceSelections } = await import("../../target/hub/rci-store.ts");

		after(() => server.close());

		function syncCfg() {
			const cfg = loadSyncConfig();
			return { ...cfg, url: base, enabled: true };
		}

		async function drainSync(times = 16) {
			for (let i = 0; i < times; i++) {
				await runSyncTick({ hubConfig: hubCfg, config: syncCfg() });
			}
		}

		const json = (method, body) => ({
			method,
			headers: { ...authed(cookie), "content-type": "application/json" },
			body: JSON.stringify(body),
		});

		async function enqueueOperator(cookie, remoteId, type, payload = {}) {
			const res = await fetch(`${base}/api/sync/remote-workflows/${remoteId}/commands`, {
				method: "POST",
				headers: { ...authed(cookie), "content-type": "application/json" },
				body: JSON.stringify({ type, payload }),
			});
			assert.equal(res.status, 201, `enqueue ${type}`);
			return res.json();
		}

		resetSyncExecutorState();
		const hubCfg = loadConfig();
		const cookie = await login(base);

		await runSyncTick({ hubConfig: hubCfg, config: syncCfg() });
		const { clientId } = getSyncCredentials();
		assert.ok(clientId);

		const createRes = await fetch(`${base}/api/sync/remote-workflows`, {
			method: "POST",
			headers: { ...authed(cookie), "content-type": "application/json" },
			body: JSON.stringify({
				client_id: clientId,
				name: "Smoke remote workflow",
				workdir: "/tmp/smoke-remote",
			}),
		});
		assert.equal(createRes.status, 201);
		const { remote_workflow: remoteWorkflow, command: createCmd } = await createRes.json();
		const remoteId = remoteWorkflow.id;

		await runSyncTick({ hubConfig: hubCfg, config: syncCfg() });
		let local = getWorkflowByRemoteId(remoteId);
		assert.ok(local, "workflow.create should materialize locally");
		assert.equal(local.origin, "remote");
		assert.equal(local.name, "Smoke remote workflow");

		await enqueueOperator(cookie, remoteId, "step.add", {
			step_key: "step-1",
			description: "Smoke step one",
		});
		await runSyncTick({ hubConfig: hubCfg, config: syncCfg() });

		await enqueueOperator(cookie, remoteId, "step.add", {
			step_key: "step-2",
			description: "Smoke step two",
		});
		await runSyncTick({ hubConfig: hubCfg, config: syncCfg() });

		await enqueueOperator(cookie, remoteId, "workflow.start", { step_keys: ["step-1", "step-2"] });
		await runSyncTick({ hubConfig: hubCfg, config: syncCfg() });

		local = getWorkflowByRemoteId(remoteId);
		assert.ok(local);
		const tasks = listSteps(local.id).filter((s) => s.kind === "task");
		assert.equal(tasks.length, 2);
		assert.equal(tasks[0].description, "Smoke step one");
		assert.equal(tasks[1].description, "Smoke step two");
		assert.equal(local.status, "running");

		const { getCommandById, listSyncEvents } = await import("../db.mjs");
		assert.equal(getCommandById(createCmd.id).status, "acked");

		const events = listSyncEvents({ clientId, remoteId });
		assert.ok(events.length >= 1, "server should have sync events from client");
		assert.ok(
			events.some((e) => e.type === "workflow.created" || e.type === "command.ack" || e.type === "workflow.status_changed"),
			`expected lifecycle events, got: ${events.map((e) => e.type).join(", ")}`,
		);

		const clientsRes = await fetch(`${base}/api/sync/clients`, { headers: authed(cookie) });
		const { clients } = await clientsRes.json();
		const row = clients.find((c) => c.id === clientId);
		assert.ok(row);
		assert.ok(row.last_seen_at);

		const tcpRes = await fetch(
			`${base}/api/tcps`,
			json("POST", {
				name: "Smoke TCP",
				tools: [{ name: "status", requestTemplate: "git status" }],
			}),
		);
		assert.equal(tcpRes.status, 201);
		const tcp = (await tcpRes.json()).tcp;
		const rciRes = await fetch(
			`${base}/api/resource-sets`,
			json("POST", {
				name: "Smoke docs",
				resources: [{ name: "guide", kind: "doc", content: "# Guide" }],
			}),
		);
		assert.equal(rciRes.status, 201);
		const resourceSet = (await rciRes.json()).resourceSet;
		const templateRes = await fetch(
			`${base}/api/templates`,
			json("POST", {
				name: "Smoke catalog template",
				steps: [
					{
						description: "Catalog step one",
						notes: [{ content: "from server template", theme: "warning" }],
					},
					{ description: "Catalog step two" },
				],
				tcpSelections: [{ tcpId: tcp.id }],
				resourceSelections: [{ resourceSetId: resourceSet.id }],
			}),
		);
		assert.equal(templateRes.status, 201);
		const template = (await templateRes.json()).template;

		const catalogCreate = await fetch(
			`${base}/api/sync/remote-workflows`,
			json("POST", {
				client_id: clientId,
				name: "From catalog template",
				template_id: template.id,
			}),
		);
		assert.equal(catalogCreate.status, 201);
		const catalogBody = await catalogCreate.json();
		assert.deepEqual(catalogBody.remote_workflow.tcp_selections, [{ tcpId: tcp.id, toolNames: null }]);
		assert.deepEqual(catalogBody.remote_workflow.resource_selections, [
			{ resourceSetId: resourceSet.id, resourceNames: null },
		]);
		const catalogRemoteId = catalogBody.remote_workflow.id;
		await drainSync();

		const catalogLocal = getWorkflowByRemoteId(catalogRemoteId);
		assert.ok(catalogLocal, "template create should materialize on the hub");
		const catalogTasks = listSteps(catalogLocal.id).filter((s) => s.kind === "task");
		assert.equal(catalogTasks.length, 2);
		assert.equal(catalogTasks[0].description, "Catalog step one");
		assert.equal(catalogTasks[1].description, "Catalog step two");
		const notes = listStepNotes(catalogTasks[0].id);
		assert.equal(notes.length, 1);
		assert.equal(notes[0].content, "from server template");
		assert.equal(notes[0].theme, "warning");

		const hubTcp = getTcp(tcp.id);
		assert.ok(hubTcp);
		assert.equal(hubTcp.origin, "server");
		assert.equal(hubTcp.name, "Smoke TCP");
		const hubRci = getResourceSet(resourceSet.id);
		assert.ok(hubRci);
		assert.equal(hubRci.origin, "server");
		assert.deepEqual(listWorkflowTcpSelections(catalogLocal.id), [{ tcpId: tcp.id, toolNames: null }]);
		assert.deepEqual(listWorkflowResourceSelections(catalogLocal.id), [
			{ resourceSetId: resourceSet.id, resourceNames: null },
		]);
	},
);
