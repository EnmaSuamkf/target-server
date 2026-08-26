/**
 * End-to-end test: boot the real server on an ephemeral port, POST a batch
 * shaped exactly like the Target client's envelope (docs/report-server.es.html
 * §7.1/§7.2), and assert it is accepted, stored, deduped, and surfaced by the
 * dashboard API.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { once } from "node:events";
import { login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-test-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0"; // OS-assigned free port
process.env.HOST = "127.0.0.1";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = "";

before(async () => {
	cookie = await login(base);
});

after(() => server.close());

function batch(overrides = {}) {
	return {
		batch_id: "b-1",
		instance_id: "inst-aaaaaaaa",
		version: "0.2.0",
		schema_version: 1,
		sent_at: new Date().toISOString(),
		user: { display_name: "Ada" },
		events: [
			{ id: "e1", kind: "workflow.created", workflow_id: "wf1", created_at: new Date().toISOString(), data: { name: "demo" } },
			{ id: "e2", kind: "step.failed", workflow_id: "wf1", created_at: new Date().toISOString(), data: { error: { kind: "agent_error" } } },
			{ id: "e3", kind: "usage.snapshot", workflow_id: "wf1", created_at: new Date().toISOString(), data: { input_tokens: 100, output_tokens: 20 } },
		],
		...overrides,
	};
}

test("POST /ingest accepts a batch and returns accepted ids", async () => {
	const res = await fetch(`${base}/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(batch()),
	});
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.deepEqual(body.accepted.sort(), ["e1", "e2", "e3"]);
	assert.equal(body.rejected.length, 0);
});

test("re-posting the same batch is idempotent (no double-count)", async () => {
	await fetch(`${base}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch()) });
	const res = await fetch(`${base}/api/stats`, { headers: { cookie } });
	const s = await res.json();
	assert.equal(s.totalEvents, 3); // still 3 despite two posts
	assert.equal(s.totalInstances, 1);
	assert.equal(s.failures, 1);
	assert.equal(s.workflows, 1);
	assert.equal(s.usage.inputTokens, 100);
});

test("malformed events are rejected but the batch still 200s", async () => {
	const res = await fetch(`${base}/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(batch({ instance_id: "inst-bbbbbbbb", events: [{ kind: "no-id" }, { id: "ok1", kind: "heartbeat", data: {} }] })),
	});
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.deepEqual(body.accepted, ["ok1"]);
	assert.equal(body.rejected.length, 1);
	assert.equal(body.rejected[0].reason, "schema");
});

test("a batch missing events[] is a 422", async () => {
	const res = await fetch(`${base}/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ instance_id: "x" }),
	});
	assert.equal(res.status, 422);
});

test("dashboard API exposes instances and events", async () => {
	const inst = await (await fetch(`${base}/api/instances`, { headers: { cookie } })).json();
	assert.ok(inst.instances.find((i) => i.instanceId === "inst-aaaaaaaa" && i.displayName === "Ada"));
	const evs = await (await fetch(`${base}/api/events?limit=10`, { headers: { cookie } })).json();
	assert.ok(evs.events.length >= 3);
});

test("workflow aggregation: /api/workflows lists counts and /api/workflows/:id reconstructs steps", async () => {
	// A second batch for wf1: workflow.created (rename) + the step list
	// (step.added ×2) + one step starting. The first batch's step.failed event
	// carries no step_id, so it counts in the totals but reconstructs no step.
	const res = await fetch(`${base}/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(
			batch({
				batch_id: "b-2",
				events: [
					{ id: "w1", kind: "workflow.created", workflow_id: "wf1", created_at: new Date().toISOString(), data: { name: "steps demo" } },
					{
						id: "w2",
						kind: "step.added",
						workflow_id: "wf1",
						created_at: new Date().toISOString(),
						data: { step_id: "s1", order_index: 0, description: "first step", manual_review: false, has_acceptance_criteria: false },
					},
					{
						id: "w3",
						kind: "step.added",
						workflow_id: "wf1",
						created_at: new Date().toISOString(),
						data: { step_id: "s2", order_index: 1, description: "second step", manual_review: true, has_acceptance_criteria: true },
					},
					{
						id: "w4",
						kind: "step.started",
						workflow_id: "wf1",
						created_at: new Date().toISOString(),
						data: { step_id: "s1", order_index: 0, phase: "exec", attempt: 1, max_retries: 0 },
					},
				],
			}),
		),
	});
	assert.equal(res.status, 200);

	const list = await (await fetch(`${base}/api/workflows`, { headers: { cookie } })).json();
	const wf1 = list.workflows.find((w) => w.workflowId === "wf1");
	assert.ok(wf1, "wf1 is listed");
	assert.equal(wf1.name, "steps demo"); // latest non-null workflow.created name
	assert.equal(wf1.user, "Ada");
	assert.equal(wf1.stepsAdded, 2);
	assert.equal(wf1.stepsStarted, 1);
	assert.equal(wf1.stepsDone, 0);
	assert.equal(wf1.stepsFailed, 1); // from the first batch
	assert.deepEqual(wf1.tokens, { input: 100, output: 20 });
	assert.equal(wf1.status, "running"); // s1 started and never settled

	const detail = await (await fetch(`${base}/api/workflows/wf1`, { headers: { cookie } })).json();
	assert.equal(detail.workflow.workflowId, "wf1");
	assert.equal(detail.workflow.status, "running");
	assert.equal(detail.steps.length, 2);
	const [s1, s2] = detail.steps; // sorted by orderIndex
	assert.equal(s1.stepId, "s1");
	assert.equal(s1.orderIndex, 0);
	assert.equal(s1.description, "first step");
	assert.equal(s1.status, "running");
	assert.equal(s2.stepId, "s2");
	assert.equal(s2.orderIndex, 1);
	assert.equal(s2.description, "second step");
	assert.equal(s2.status, "pending"); // step.added only
	assert.equal(s2.manualReview, true);
	assert.ok(detail.events.length >= 4);

	const missing = await fetch(`${base}/api/workflows/wf-unknown`, { headers: { cookie } });
	assert.equal(missing.status, 404);
});

test("agent/sandbox: workflow rows resolve them and the filters narrow every view", async () => {
	// wf2 runs on a different agent inside docker; wf1 (batches b-1/b-2) never
	// reported either, so it must not match any agent/sandbox filter.
	const res = await fetch(`${base}/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(
			batch({
				batch_id: "b-3",
				events: [
					{
						id: "g1",
						kind: "workflow.created",
						workflow_id: "wf2",
						created_at: new Date().toISOString(),
						data: { name: "containerised", agent: "free-code", sandbox: "docker", image: "target-agent:latest" },
					},
					{
						id: "g2",
						kind: "workflow.updated",
						workflow_id: "wf1",
						created_at: new Date().toISOString(),
						data: { name: "steps demo", agent: "claude", sandbox: "host", image: null },
					},
				],
			}),
		),
	});
	assert.equal(res.status, 200);

	// Rows resolve agent/sandbox from the latest event carrying them —
	// workflow.updated counts for the name too (rename notification).
	const list = await (await fetch(`${base}/api/workflows`, { headers: { cookie } })).json();
	const wf1 = list.workflows.find((w) => w.workflowId === "wf1");
	const wf2 = list.workflows.find((w) => w.workflowId === "wf2");
	assert.equal(wf1.agent, "claude");
	assert.equal(wf1.sandbox, "host");
	assert.equal(wf1.name, "steps demo"); // workflow.updated refreshed it
	assert.equal(wf2.agent, "free-code");
	assert.equal(wf2.sandbox, "docker");
	assert.equal(wf2.image, "target-agent:latest");

	// The filters narrow the workflow list…
	const onlyFc = await (await fetch(`${base}/api/workflows?agent=free-code`, { headers: { cookie } })).json();
	assert.deepEqual(onlyFc.workflows.map((w) => w.workflowId), ["wf2"]);
	const onlyDocker = await (await fetch(`${base}/api/workflows?sandbox=docker`, { headers: { cookie } })).json();
	assert.deepEqual(onlyDocker.workflows.map((w) => w.workflowId), ["wf2"]);
	const onlyHost = await (await fetch(`${base}/api/workflows?sandbox=host`, { headers: { cookie } })).json();
	assert.deepEqual(onlyHost.workflows.map((w) => w.workflowId), ["wf1"]);

	// …the event feed…
	const evs = await (await fetch(`${base}/api/events?agent=claude&limit=50`, { headers: { cookie } })).json();
	assert.ok(evs.events.length > 0);
	assert.ok(evs.events.every((e) => e.workflowId === "wf1"));

	// …and the stats, which also publish the distinct values for the dropdowns.
	const s = await (await fetch(`${base}/api/stats?sandbox=docker`, { headers: { cookie } })).json();
	assert.equal(s.workflows, 1);
	assert.ok(s.events === undefined); // shape sanity: stats has totalEvents
	const all = await (await fetch(`${base}/api/stats`, { headers: { cookie } })).json();
	assert.deepEqual(all.agents.sort(), ["claude", "free-code"]);
	assert.deepEqual(all.sandboxes.sort(), ["docker", "host"]);
});
