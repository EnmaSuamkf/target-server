/**
 * End-to-end smoke: operator creates a remote workflow (2 steps + start),
 * then a catalog template with TCP/RCI; the hub applies steps (with notes)
 * and server-managed selections. Skipped when the hub is not checked out.
 *
 * Mirrors the manual checklist in README § Remote sync.
 * Skipped in CI when the target hub is not checked out alongside target-server.
 *
 * A second smoke drives a scheduled series end to end with a SIMULATED hub
 * (plain HTTP, so it also runs in CI): create with a daily schedule, the hub
 * applies the commands, announces two fires and a missed run, the operator
 * cancels the series.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
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
		const { clientId, token } = getSyncCredentials();
		assert.ok(clientId);
		assert.equal((await fetch(`${base}/api/sync/catalog`)).status, 401);
		assert.ok(token);
		const catalogLegacy = await fetch(`${base}/api/sync/catalog`, {
			headers: { authorization: `Bearer ${token}` },
		});
		assert.equal(catalogLegacy.status, 403);
		assert.deepEqual(await catalogLegacy.json(), { error: "owner_required" });

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

test("E2E smoke: scheduled series with a simulated hub → two fires, a missed run, cancel", async () => {
	// The first smoke boots the server when the hub is checked out, and its
	// test-scoped `after` has closed it again by now: the module (one instance
	// per process) is reused and put back on a port. Otherwise boot it here.
	const reused = Boolean(process.env.TARGET_SERVER_DB);
	if (!reused) {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "target-sync-smoke-schedule-"));
		process.env.TARGET_SERVER_DB = path.join(tmpRoot, "server.db");
		process.env.PORT = "0";
		process.env.HOST = "127.0.0.1";
	}
	const { server } = await import("../server.mjs");
	if (!server.listening) {
		if (reused) server.listen(0, "127.0.0.1");
		await once(server, "listening");
	}
	after(() => {
		if (server.listening) server.close();
	});
	const base = `http://127.0.0.1:${server.address().port}`;
	const cookie = await login(base);

	async function call(pathname, { method = "GET", headers = {}, body } = {}) {
		const res = await fetch(`${base}${pathname}`, {
			method,
			headers: { "content-type": "application/json", ...headers },
			body: body == null ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null };
	}
	const operator = (pathname, opts = {}) => call(pathname, { ...opts, headers: authed(cookie) });

	// --- The simulated hub ---------------------------------------------------
	const register = await call("/api/sync/register", {
		method: "POST",
		body: {
			name: "Simulated scheduling hub",
			capabilities: {
				commands: ["workflow.create", "workflow.set_context", "step.add", "workflow.set_schedule", "workflow.cancel_schedule"],
				runners: [{ id: "claude", installed: true }],
			},
		},
	});
	assert.equal(register.status, 201, JSON.stringify(register.body));
	assert.ok(register.body.server_capabilities.events.includes("schedule.instance_created"));
	const hub = { id: register.body.client_id, headers: { authorization: `Bearer ${register.body.client_token}` } };
	const applied = [];

	async function hubEvents(events) {
		const res = await call("/api/sync/events", { method: "POST", headers: hub.headers, body: { events } });
		assert.equal(res.status, 200, JSON.stringify(res.body));
		return res.body;
	}

	/** Poll and ack until the queue is empty (commands of one workflow come one at a time). */
	async function hubApplyCommands() {
		for (let i = 0; i < 20; i++) {
			const poll = await call("/api/sync/commands", { headers: hub.headers });
			assert.equal(poll.status, 200);
			if (poll.body.commands.length === 0) return;
			for (const command of poll.body.commands) {
				applied.push(command);
				const ack = await call(`/api/sync/commands/${command.id}/ack`, {
					method: "POST",
					headers: hub.headers,
					body: { status: "applied", local_id: `local-${command.remote_id}`, remote_id: command.remote_id },
				});
				assert.equal(ack.status, 200, JSON.stringify(ack.body));
			}
		}
		assert.fail("command queue never drained");
	}

	// --- Operator: remote workflow (2 template steps) on a daily schedule ----
	const template = await operator("/api/templates", {
		method: "POST",
		body: { name: "Smoke scheduled template", steps: [{ description: "Collect" }, { description: "Report" }] },
	});
	assert.equal(template.status, 201);
	const daily = { spec: { kind: "daily", time: "09:00" }, timezone: "Europe/Madrid" };
	const created = await operator("/api/sync/remote-workflows", {
		method: "POST",
		body: {
			client_id: hub.id,
			name: "Smoke nightly",
			agent: "claude",
			conversation_context: "Run the nightly checks.",
			template_id: template.body.template.id,
			schedule: daily,
		},
	});
	assert.equal(created.status, 201, JSON.stringify(created.body));
	const seriesId = created.body.series.id;
	const firstId = created.body.remote_workflow.id;

	await hubApplyCommands();
	assert.deepEqual(
		applied.map((c) => c.type),
		["workflow.create", "workflow.set_context", "step.add", "step.add", "workflow.set_schedule"],
	);
	const stepKeys = applied.filter((c) => c.type === "step.add").map((c) => c.payload.step_key);
	assert.equal(stepKeys.length, 2);
	assert.deepEqual(applied.at(-1).payload, { series_id: seriesId, ...daily, include_previous: true });
	await hubEvents([
		{ id: `sc-${firstId}-armed`, type: "workflow.schedule_changed", remote_id: firstId, payload: { series_id: seriesId, state: "armed", next_run_at: "2026-10-01T07:00:00.000Z" } },
	]);

	// --- Two fires: each clones the next instance and announces it ----------
	function announce(remoteId, previousRemoteId, scheduledFor) {
		return {
			id: `instance-created:${remoteId}`,
			type: "schedule.instance_created",
			remote_id: remoteId,
			payload: {
				series_id: seriesId,
				previous_remote_id: previousRemoteId,
				name: `Smoke nightly · ${scheduledFor.slice(0, 10)} 09:00`,
				scheduled_for: scheduledFor,
				schedule: { ...daily, include_previous: true },
				agent: "claude",
				sandbox: "docker",
				conversation_context: "Run the nightly checks.",
				steps: stepKeys.map((step_key, i) => ({
					step_key,
					description: i === 0 ? "Collect" : "Report",
					acceptance_criteria: null,
					manual_review: false,
					use_subagent: true,
					max_retries: 0,
					retry_interval_seconds: 0,
				})),
				tcp_selections: [],
				resource_selections: [],
			},
		};
	}
	const secondId = randomUUID();
	const thirdId = randomUUID();
	const fire1 = await hubEvents([
		{ id: `status-${firstId}-running`, type: "workflow.status_changed", remote_id: firstId, payload: { to: "running" } },
		announce(secondId, firstId, "2026-10-02T07:00:00.000Z"),
		{ id: `sc-${secondId}-armed`, type: "workflow.schedule_changed", remote_id: secondId, payload: { series_id: seriesId, state: "armed", next_run_at: "2026-10-02T07:00:00.000Z" } },
	]);
	assert.deepEqual(fire1.rejected, []);
	assert.equal(fire1.accepted.length, 3);
	const fire2 = await hubEvents([
		announce(thirdId, secondId, "2026-10-05T07:00:00.000Z"),
		{ id: `sc-${thirdId}-armed`, type: "workflow.schedule_changed", remote_id: thirdId, payload: { series_id: seriesId, state: "armed", next_run_at: "2026-10-05T07:00:00.000Z" } },
	]);
	assert.deepEqual(fire2.rejected, []);
	// A lost response: the hub announces the same instance again → duplicate.
	const resent = await hubEvents([announce(thirdId, secondId, "2026-10-05T07:00:00.000Z")]);
	assert.deepEqual(resent.duplicates, [`instance-created:${thirdId}`]);

	// The hub was offline over two runs: missed, the series skips ahead.
	const missed = ["2026-10-03T07:00:00.000Z", "2026-10-04T07:00:00.000Z"];
	const missedRes = await hubEvents([
		{ id: `missed-${seriesId}-1`, type: "schedule.run_missed", remote_id: thirdId, payload: { series_id: seriesId, occurrences: missed } },
	]);
	assert.deepEqual(missedRes.accepted, [`missed-${seriesId}-1`]);

	// --- Operator cancels the series through its current (armed) instance ---
	const cancel = await operator(`/api/sync/remote-workflows/${thirdId}/schedule`, { method: "DELETE" });
	assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
	assert.deepEqual(cancel.body.command.payload, { series_id: seriesId });
	await hubApplyCommands();
	assert.equal(applied.at(-1).type, "workflow.cancel_schedule");
	await hubEvents([
		{ id: `sc-${thirdId}-cancelled`, type: "workflow.schedule_changed", remote_id: thirdId, payload: { series_id: seriesId, state: "cancelled", next_run_at: null } },
	]);
	// Too late for another fire: the server refuses it.
	const late = await hubEvents([announce(randomUUID(), thirdId, "2026-10-06T07:00:00.000Z")]);
	assert.equal(late.rejected[0].reason, "series_cancelled");

	// --- Final server state --------------------------------------------------
	const listing = await operator(`/api/sync/schedule-series?client_id=${hub.id}`);
	assert.equal(listing.status, 200);
	assert.equal(listing.body.series.length, 1);
	const series = listing.body.series[0];
	assert.equal(series.id, seriesId);
	assert.equal(series.state, "cancelled");
	assert.equal(series.created_by, "server");
	assert.deepEqual(series.spec, daily.spec);
	assert.deepEqual(series.instances.map((i) => i.id), [firstId, secondId, thirdId]);
	assert.deepEqual(series.instances.map((i) => i.created_by), ["server", "hub", "hub"]);
	assert.deepEqual(series.instances.map((i) => i.schedule_state), ["fired", "fired", "cancelled"]);
	assert.deepEqual(series.instances.map((i) => i.scheduled_for), [null, "2026-10-02T07:00:00.000Z", "2026-10-05T07:00:00.000Z"]);
	assert.equal(series.instances[0].local_id, `local-${firstId}`);
	assert.equal(series.instances[1].local_id, null, "hub-cloned instances have no local mapping yet");
	for (const instance of series.instances) {
		const detail = await operator(`/api/sync/remote-workflows/${instance.id}`);
		assert.deepEqual(detail.body.steps.map((s) => s.step_key), stepKeys, `${instance.id} step_keys`);
		assert.equal(detail.body.remote_workflow.series_id, seriesId);
	}
	assert.equal(series.notices.length, 1);
	assert.equal(series.notices[0].kind, "missed");
	assert.deepEqual(series.notices[0].occurrences, missed);
	assert.equal(series.notices[0].remote_id, thirdId);
});
