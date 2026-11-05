/**
 * Sticky notes on the dashboard: fold step.note.* events onto steps and show
 * them on list cards with the same layout as the Target hub client.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-notes-")), "test.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0"; // OS-assigned free port
process.env.HOST = "127.0.0.1";

const { open, insertEvent, upsertInstance, workflowDetail, normalizeNoteSource } = await import("../db.mjs");
const { templateStepToAddPayload, server } = await import("../server.mjs");
open(tmpDb);

// Importing server.mjs starts it listening on an ephemeral port; close it so the test process can exit.
after(() => server.close());

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

function addPlanStep(stepId) {
	insertEvent(
		"inst-1",
		"0.2.0",
		{
			id: `plan-${stepId}`,
			kind: "workflow.plan",
			workflow_id: "wf-source",
			created_at: NOW,
			data: {
				name: "source wf",
				status: "running",
				steps: [{ step_id: stepId, order_index: 0, description: "src", status: "done" }],
			},
		},
		NOW,
	);
}

function noteEvent(id, kind, stepId, data) {
	insertEvent(
		"inst-1",
		"0.2.0",
		{ id, kind, workflow_id: "wf-source", created_at: NOW, data: { step_id: stepId, ...data } },
		NOW,
	);
}

test("agent note keeps source agent", () => {
	addPlanStep("src-agent");
	noteEvent("sa1", "step.note.added", "src-agent", { note_id: "a1", theme: "neutral", content: "from agent", source: "agent" });
	const step = workflowDetail("wf-source").steps.find((s) => s.stepId === "src-agent");
	assert.equal(step.notes.length, 1);
	assert.equal(step.notes[0].source, "agent");
	assert.equal(step.notes[0].content, "from agent");
	assert.ok(step.notes[0].createdAt);
	assert.ok(step.notes[0].updatedAt);
});

test("missing source defaults to operator", () => {
	addPlanStep("src-missing");
	noteEvent("sm1", "step.note.added", "src-missing", { note_id: "m1", theme: "neutral", content: "no source" });
	const step = workflowDetail("wf-source").steps.find((s) => s.stepId === "src-missing");
	assert.equal(step.notes[0].source, "operator");
});

test("invalid source defaults to operator", () => {
	addPlanStep("src-invalid");
	noteEvent("si1", "step.note.added", "src-invalid", { note_id: "i1", theme: "neutral", content: "bad source", source: "robot" });
	const step = workflowDetail("wf-source").steps.find((s) => s.stepId === "src-invalid");
	assert.equal(step.notes[0].source, "operator");
});

test("modified note takes source from modified event and missing source becomes operator", () => {
	addPlanStep("src-mod");
	noteEvent("sd1", "step.note.added", "src-mod", { note_id: "d1", theme: "neutral", content: "v1", source: "agent" });
	noteEvent("sd2", "step.note.modified", "src-mod", { note_id: "d1", theme: "neutral", content: "v2" });
	const step = workflowDetail("wf-source").steps.find((s) => s.stepId === "src-mod");
	assert.equal(step.notes[0].content, "v2");
	assert.equal(step.notes[0].source, "operator");
});

test("normalizeNoteSource only keeps agent", () => {
	assert.equal(normalizeNoteSource("agent"), "agent");
	assert.equal(normalizeNoteSource("operator"), "operator");
	assert.equal(normalizeNoteSource(undefined), "operator");
	assert.equal(normalizeNoteSource("AGENT"), "operator");
});

test("step add payload notes include source, createdAt and updatedAt", () => {
	const payload = templateStepToAddPayload(
		{
			description: "d",
			notes: [
				{ id: "p1", content: "agent note", theme: "neutral", source: "agent" },
				{ id: "p2", content: "bad source", source: "nope" },
			],
		},
		"step-x",
	);
	assert.equal(payload.notes[0].source, "agent");
	assert.equal(payload.notes[1].source, "operator");
	for (const n of payload.notes) {
		assert.ok(typeof n.createdAt === "string" && n.createdAt);
		assert.ok(typeof n.updatedAt === "string" && n.updatedAt);
	}
});
