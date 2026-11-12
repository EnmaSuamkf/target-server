/**
 * A command step's branch agents (the hub's docs/pipelines.md, "Branch agents")
 * on the server: the template keeps the two tasks and the retry budget, the
 * step.add sent to a hub carries them, and the workflow detail (what the canvas
 * draws) exposes them from the hub's plan, with the branch phases.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-branch-agents-")), "test.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";

const db = await import("../db.mjs");
const { templateStepToAddPayload, server } = await import("../server.mjs");
const { validate } = await import("../blueprint.mjs");
db.open(tmpDb);
after(() => server.close());

const PIPELINE_SOURCE = "name: branchy\nsteps:\n  - run: echo ok\n";
const NOW = new Date().toISOString();

test("a template command step keeps its retries and its two branch agents; an agent step never gets them", () => {
	const pipeline = db.createPipeline({ source: PIPELINE_SOURCE });
	const template = db.createTemplate({
		name: "With agents",
		steps: [
			{
				kind: "command",
				pipelineId: pipeline.id,
				pipelineInputs: {},
				maxRetries: 2,
				retryIntervalSeconds: 5,
				onSuccessTask: "  Write the release notes  ",
				onFailureTask: "Fix the build",
			},
			{ kind: "command", pipelineId: pipeline.id, pipelineInputs: {}, onSuccessTask: "   " },
			{ description: "agent", onSuccessTask: "dropped" },
		],
	});
	const [withAgents, blank, agent] = template.steps;
	assert.equal(withAgents.maxRetries, 2);
	assert.equal(withAgents.retryIntervalSeconds, 5);
	assert.equal(withAgents.onSuccessTask, "Write the release notes");
	assert.equal(withAgents.onFailureTask, "Fix the build");
	assert.equal("onSuccessTask" in blank, false, "a blank task is no agent, and leaves no key");
	assert.equal("onSuccessTask" in agent, false);
});

test("the template API schema keeps the branch tasks instead of stripping them", () => {
	const result = validate("catalog.template.create", {
		name: "API",
		steps: [{ kind: "command", pipelineId: "p1", maxRetries: 1, onSuccessTask: "Ship", onFailureTask: "Fix" }],
	});
	assert.equal(result.ok, true);
	const [step] = result.value.steps;
	assert.equal(step.kind, "command", "still a command step, not stripped into an agent step");
	assert.equal(step.maxRetries, 1);
	assert.equal(step.onSuccessTask, "Ship");
	assert.equal(step.onFailureTask, "Fix");
});

test("step.add for a command step carries the retries and the branch agents, and the command schema keeps them", () => {
	const payload = templateStepToAddPayload(
		{
			kind: "command",
			pipelineId: "p1",
			pipelineInputs: { a: "b" },
			description: "Run",
			maxRetries: 3,
			retryIntervalSeconds: 10,
			onSuccessTask: "Ship",
			onFailureTask: "Fix",
		},
		"s1",
	);
	assert.equal(payload.kind, "command");
	assert.equal(payload.max_retries, 3);
	assert.equal(payload.retry_interval_seconds, 10);
	assert.equal(payload.on_success_task, "Ship");
	assert.equal(payload.on_failure_task, "Fix");
	const checked = validate("command.step.add", payload);
	assert.equal(checked.ok, true);
	assert.equal(checked.value.on_success_task, "Ship");
	assert.equal(checked.value.on_failure_task, "Fix");

	const without = templateStepToAddPayload({ kind: "command", pipelineId: "p1", description: "Run" }, "s2");
	assert.equal("on_success_task" in without, false, "no agent, no key: an older hub sees what it always saw");
});

test("the workflow detail exposes branch agents and branch phases from the hub's plan", () => {
	db.upsertInstance({ instance_id: "inst-branch", version: "0.2.0" }, NOW);
	db.insertEvent(
		"inst-branch",
		"0.2.0",
		{
			id: "plan-branch",
			kind: "workflow.plan",
			workflow_id: "wf-branch",
			created_at: NOW,
			data: {
				name: "branch wf",
				status: "running",
				steps: [
					{
						step_id: "cmd",
						kind: "command",
						pipeline_id: "p1",
						order_index: 0,
						description: "Run pipeline",
						status: "running",
						phase: "on_failure",
						max_retries: 2,
						retry_count: 1,
						on_success_task: "Ship",
						on_failure_task: "Fix",
						branch_failed: false,
					},
					{ step_id: "agent", order_index: 1, description: "agent", status: "pending", phase: "exec" },
				],
			},
		},
		NOW,
	);
	const [cmd, agent] = db.workflowDetail("wf-branch").steps;
	assert.equal(cmd.kind, "command");
	assert.equal(cmd.phase, "on_failure");
	assert.equal(cmd.onSuccessTask, "Ship");
	assert.equal(cmd.onFailureTask, "Fix");
	assert.equal(cmd.branchFailed, false);
	assert.equal(agent.onSuccessTask, null, "an agent step has no branch agents");
});
