/**
 * Retry-wait projection: the workflow.plan snapshot may carry `retry_at` on a
 * pending step (the time of its next attempt). workflowDetail projects it as
 * `retryAt`; a snapshot without the field (older hub) projects null, and no
 * other field of the step changes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-retry-wait-projection-")), "test.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0"; // OS-assigned free port
process.env.HOST = "127.0.0.1";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { open, insertEvent, upsertInstance, workflowDetail } = await import("../db.mjs");
const { server } = await import("../server.mjs");
open(tmpDb);

// Importing server.mjs starts it listening on an ephemeral port; close it so the test process can exit.
after(() => server.close());

const NOW = "2026-06-01T12:00:00.000Z";
const RETRY_AT = "2026-06-01T12:01:30.000Z";
const INST = "inst-retry-wait";

function seedPlan(workflowId, steps) {
	insertEvent(
		INST,
		"0.2.0",
		{
			id: `plan-${workflowId}`,
			kind: "workflow.plan",
			workflow_id: workflowId,
			created_at: NOW,
			data: { name: `retry wf ${workflowId}`, status: "running", steps },
		},
		NOW,
	);
}

upsertInstance({ instance_id: INST, version: "0.2.0" }, NOW);

test("a plan step with retry_at projects retryAt equal to that string", () => {
	seedPlan("wf-retry-with", [
		{
			step_id: "step-retry",
			order_index: 0,
			description: "retrying work",
			status: "pending",
			retry_count: 1,
			max_retries: 3,
			retry_at: RETRY_AT,
		},
	]);
	const detail = workflowDetail("wf-retry-with");
	assert.ok(detail);
	const step = detail.steps.find((s) => s.stepId === "step-retry");
	assert.ok(step);
	assert.equal(step.retryAt, RETRY_AT);
	assert.equal(step.status, "pending");
});

test("a plan step without retry_at projects retryAt null", () => {
	seedPlan("wf-retry-without", [
		{
			step_id: "step-plain",
			order_index: 0,
			description: "plain pending work",
			status: "pending",
			retry_count: 0,
			max_retries: 3,
		},
	]);
	const detail = workflowDetail("wf-retry-without");
	assert.ok(detail);
	const step = detail.steps.find((s) => s.stepId === "step-plain");
	assert.ok(step);
	assert.equal(step.retryAt, null);
});

test("a retry_at on a step that is no longer pending is still projected (the UI decides)", () => {
	seedPlan("wf-retry-stale", [
		{
			step_id: "step-stale",
			order_index: 0,
			description: "finished work with a stale retry_at",
			status: "done",
			retry_count: 1,
			max_retries: 3,
			retry_at: RETRY_AT,
		},
	]);
	const detail = workflowDetail("wf-retry-stale");
	assert.ok(detail);
	const step = detail.steps.find((s) => s.stepId === "step-stale");
	assert.ok(step);
	assert.equal(step.status, "done");
	assert.equal(step.retryAt, RETRY_AT);
});

test("retry_at changes only retryAt: the rest of the step equals the same step without the field", () => {
	const base = {
		step_id: "step-same",
		order_index: 0,
		description: "same work",
		status: "pending",
		phase: "exec",
		retry_count: 2,
		max_retries: 3,
		started_at: NOW,
		use_subagent: false,
	};
	seedPlan("wf-same-without", [base]);
	seedPlan("wf-same-with", [{ ...base, retry_at: RETRY_AT }]);

	const without = workflowDetail("wf-same-without").steps.find((s) => s.stepId === "step-same");
	const withField = workflowDetail("wf-same-with").steps.find((s) => s.stepId === "step-same");
	assert.ok(without);
	assert.ok(withField);
	assert.equal(without.retryAt, null);
	assert.equal(withField.retryAt, RETRY_AT);

	const { retryAt: _a, ...restWithout } = without;
	const { retryAt: _b, ...restWith } = withField;
	assert.deepEqual(restWith, restWithout);
	assert.equal(withField.retryCount, 2);
	assert.equal(withField.maxRetries, 3);
	assert.equal(withField.status, "pending");
});
