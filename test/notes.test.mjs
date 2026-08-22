/**
 * Sticky notes on the dashboard: fold step.note.* events onto steps and show
 * them on list cards with the same layout as the Target hub client.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-notes-")), "test.db");
process.env.TARGET_SERVER_DB = tmpDb;

const { open, insertEvent, upsertInstance, workflowDetail } = await import("../db.mjs");

const WF = "wf-notes";
const STEP = "step-1";
const NOW = new Date().toISOString();

test("workflowDetail folds note events onto steps", () => {
	upsertInstance({ instance_id: "inst-1", version: "0.2.0" }, NOW);
	insertEvent(
		"inst-1",
		"0.2.0",
		{
			id: "plan-1",
			kind: "workflow.plan",
			workflow_id: WF,
			created_at: NOW,
			data: {
				name: "notes wf",
				status: "running",
				steps: [
					{
						step_id: STEP,
						order_index: 0,
						description: "do work",
						status: "done",
						acceptance_criteria: "must pass browser check",
						manual_review: true,
						use_subagent: false,
						max_retries: 3,
						retry_count: 1,
					},
				],
			},
		},
		NOW,
	);
	insertEvent(
		"inst-1",
		"0.2.0",
		{
			id: "n1",
			kind: "step.note.added",
			workflow_id: WF,
			created_at: NOW,
			data: {
				step_id: STEP,
				note_id: "note-1",
				theme: "success",
				content: "server restart note",
			},
		},
		NOW,
	);
	insertEvent(
		"inst-1",
		"0.2.0",
		{
			id: "n2",
			kind: "step.note.modified",
			workflow_id: WF,
			created_at: NOW,
			data: {
				step_id: STEP,
				note_id: "note-1",
				theme: "warning",
				content: "updated warning",
			},
		},
		NOW,
	);

	const detail = workflowDetail(WF);
	assert.ok(detail);
	const step = detail.steps.find((s) => s.stepId === STEP);
	assert.ok(step);
	assert.equal(step.acceptanceCriteria, "must pass browser check");
	assert.equal(step.manualReview, true);
	assert.equal(step.useSubagent, false);
	assert.equal(step.notes?.length, 1);
	assert.equal(step.notes[0].content, "updated warning");
	assert.equal(step.notes[0].theme, "warning");
});
