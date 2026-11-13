/**
 * A command step's pipeline name, end to end: a hub reports the step through
 * POST /ingest (its step events, and a workflow.plan snapshot), and the dashboard
 * API (GET /api/workflows/:id) names the pipeline. The catalog name wins when this
 * server has the id; else the `pipeline_name` the hub reported; else null. The id
 * is never the name, and an older hub that sends no name gets null.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { once } from "node:events";
import { login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-pipeline-names-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0"; // OS-assigned free port
process.env.HOST = "127.0.0.1";

const { server } = await import("../server.mjs");
const db = await import("../db.mjs");
if (!server.listening) await once(server, "listening");
db.open(tmpDb);
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = "";

const INST = "inst-pipeline-names";
const NOW = "2026-06-01T12:00:00.000Z";
const CATALOG_SOURCE = "name: catalog-checkout\nsteps:\n  - run: echo ok\n";
// A pipeline the hub runs but this server's catalog does not have.
const HUB_LOCAL_ID = "5b7e0c1a-2d3f-4a6b-8c9d-000000000001";
// A pipeline id nobody on this server knows, as an older hub would report it.
const UNKNOWN_ID = "5b7e0c1a-2d3f-4a6b-8c9d-000000000002";

let catalog = null;
let batchSeq = 0;
let eventSeq = 0;

before(async () => {
	cookie = await login(base);
	catalog = db.createPipeline({ source: CATALOG_SOURCE });
});

after(() => server.close());

function event(workflowId, kind, data) {
	eventSeq += 1;
	return { id: `ev-${eventSeq}`, kind, workflow_id: workflowId, created_at: NOW, data };
}

/** Posts one hub batch and asserts every event was accepted. */
async function report(events) {
	batchSeq += 1;
	const res = await fetch(`${base}/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			batch_id: `pipeline-names-${batchSeq}`,
			instance_id: INST,
			version: "0.2.0",
			schema_version: 1,
			sent_at: NOW,
			events,
		}),
	});
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.rejected.length, 0, JSON.stringify(body.rejected));
}

/** The step `stepId` of workflow `workflowId`, as the dashboard API returns it. */
async function apiStep(workflowId, stepId) {
	const res = await fetch(`${base}/api/workflows/${workflowId}`, { headers: { cookie } });
	assert.equal(res.status, 200);
	const detail = await res.json();
	const step = detail.steps.find((s) => s.stepId === stepId);
	assert.ok(step, `step ${stepId} is in ${workflowId}`);
	return step;
}

test("a hub-local pipeline's reported name reaches the API from the step events", async () => {
	await report([
		event("wf-pn-events", "workflow.created", { name: "names" }),
		event("wf-pn-events", "step.added", { step_id: "cmd", order_index: 0, description: "Check out" }),
		event("wf-pn-events", "step.started", {
			step_id: "cmd",
			order_index: 0,
			pipeline_id: HUB_LOCAL_ID,
			pipeline_name: "git-checkout-base",
		}),
	]);
	const step = await apiStep("wf-pn-events", "cmd");
	assert.equal(step.kind, "command");
	assert.deepEqual(step.pipeline, { id: HUB_LOCAL_ID, name: "git-checkout-base" });
});

test("a hub-local pipeline's reported name reaches the API from a plan snapshot", async () => {
	await report([
		event("wf-pn-plan", "workflow.created", { name: "names" }),
		event("wf-pn-plan", "workflow.plan", {
			name: "names",
			status: "running",
			steps: [
				{
					step_id: "cmd",
					kind: "command",
					pipeline_id: HUB_LOCAL_ID,
					pipeline_name: "git-checkout-base",
					order_index: 0,
					description: "Check out",
					status: "pending",
				},
			],
		}),
	]);
	const step = await apiStep("wf-pn-plan", "cmd");
	assert.equal(step.kind, "command");
	assert.deepEqual(step.pipeline, { id: HUB_LOCAL_ID, name: "git-checkout-base" });
});

test("a plan snapshot without pipeline_name keeps the name the step events reported", async () => {
	await report([
		event("wf-pn-fallback", "workflow.created", { name: "names" }),
		event("wf-pn-fallback", "step.started", {
			step_id: "cmd",
			order_index: 0,
			pipeline_id: HUB_LOCAL_ID,
			pipeline_name: "git-checkout-base",
		}),
		event("wf-pn-fallback", "workflow.plan", {
			name: "names",
			status: "running",
			steps: [{ step_id: "cmd", kind: "command", pipeline_id: HUB_LOCAL_ID, order_index: 0, status: "running" }],
		}),
	]);
	const step = await apiStep("wf-pn-fallback", "cmd");
	assert.deepEqual(step.pipeline, { id: HUB_LOCAL_ID, name: "git-checkout-base" });
});

test("a catalog pipeline keeps its catalog name over a different name the hub reports", async () => {
	assert.equal(catalog.name, "catalog-checkout");
	await report([
		event("wf-pn-catalog-events", "workflow.created", { name: "names" }),
		event("wf-pn-catalog-events", "step.started", {
			step_id: "cmd",
			order_index: 0,
			pipeline_id: catalog.id,
			pipeline_name: "hub-says-other",
		}),
		event("wf-pn-catalog-plan", "workflow.created", { name: "names" }),
		event("wf-pn-catalog-plan", "workflow.plan", {
			name: "names",
			status: "running",
			steps: [
				{
					step_id: "cmd",
					kind: "command",
					pipeline_id: catalog.id,
					pipeline_name: "hub-says-other",
					order_index: 0,
					status: "pending",
				},
			],
		}),
	]);
	for (const wf of ["wf-pn-catalog-events", "wf-pn-catalog-plan"]) {
		const step = await apiStep(wf, "cmd");
		assert.deepEqual(step.pipeline, { id: catalog.id, name: "catalog-checkout" }, wf);
	}
});

test("an older hub's unknown pipeline, with no reported name, gets a null name, never the id", async () => {
	await report([
		event("wf-pn-old-events", "workflow.created", { name: "names" }),
		event("wf-pn-old-events", "step.started", { step_id: "cmd", order_index: 0, pipeline_id: UNKNOWN_ID }),
		event("wf-pn-old-plan", "workflow.created", { name: "names" }),
		event("wf-pn-old-plan", "workflow.plan", {
			name: "names",
			status: "pending",
			steps: [{ step_id: "cmd", kind: "command", pipeline_id: UNKNOWN_ID, order_index: 0, status: "pending" }],
		}),
	]);
	for (const wf of ["wf-pn-old-events", "wf-pn-old-plan"]) {
		const step = await apiStep(wf, "cmd");
		assert.equal(step.kind, "command", wf);
		assert.deepEqual(step.pipeline, { id: UNKNOWN_ID, name: null }, wf);
		assert.notEqual(step.pipeline.name, UNKNOWN_ID, wf);
	}
});

test("a reported name that is the id, or blank, is not a name", async () => {
	await report([
		event("wf-pn-junk", "workflow.created", { name: "names" }),
		event("wf-pn-junk", "step.started", {
			step_id: "echo",
			order_index: 0,
			pipeline_id: HUB_LOCAL_ID,
			pipeline_name: HUB_LOCAL_ID,
		}),
		event("wf-pn-junk", "step.started", {
			step_id: "blank",
			order_index: 1,
			pipeline_id: UNKNOWN_ID,
			pipeline_name: "   ",
		}),
	]);
	assert.deepEqual((await apiStep("wf-pn-junk", "echo")).pipeline, { id: HUB_LOCAL_ID, name: null });
	assert.deepEqual((await apiStep("wf-pn-junk", "blank")).pipeline, { id: UNKNOWN_ID, name: null });
});
