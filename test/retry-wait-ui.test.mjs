/**
 * Retry-wait UI rules, without a browser: the countdown text and its boundaries
 * (ui/src/lib/retryCountdown.ts), and the canvas state and edges of a step in its
 * retry wait (ui/src/lib/canvasLayout.ts). A pending step with `retryAt` is
 * `retrying`; every other status ignores `retryAt`; its incoming edges are active;
 * its judge circle stays pending.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { focusNodeId, layoutWorkflow } from "../ui/src/lib/canvasLayout.ts";
import { formatCountdown, retryCanvasLabel, retryCountdown, retryListLabel } from "../ui/src/lib/retryCountdown.ts";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
/** The ISO time `seconds` after NOW (negative = in the past). */
const at = (seconds) => new Date(NOW + seconds * 1000).toISOString();
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

function step(id, orderIndex, patch = {}) {
	return {
		id,
		orderIndex,
		description: `${id} work`,
		status: "pending",
		kind: "task",
		useSubagent: true,
		acceptanceCriteria: "must pass",
		maxRetries: 2,
		retryCount: 0,
		...patch,
	};
}

const nodeOf = (graph, id) => {
	const node = graph.nodes.find((n) => n.id === id);
	assert.ok(node, `node ${id}`);
	return node;
};
const edgeOf = (graph, id) => {
	const edge = graph.edges.find((e) => e.id === id);
	assert.ok(edge, `edge ${id}`);
	return edge;
};

test("a pending step with retryAt is retrying; without it (null or empty) it stays pending", () => {
	const graph = layoutWorkflow([
		step("a", 0, { retryAt: at(90) }),
		step("b", 1),
		step("c", 2, { retryAt: null }),
		step("d", 3, { retryAt: "" }),
	]);
	assert.equal(nodeOf(graph, "a").state, "retrying");
	assert.equal(nodeOf(graph, "b").state, "pending");
	assert.equal(nodeOf(graph, "c").state, "pending");
	assert.equal(nodeOf(graph, "d").state, "pending");
});

test("retryAt is read only for a pending step: every other status keeps its own state", () => {
	for (const status of ["queued", "running", "waiting", "done", "failed"]) {
		const graph = layoutWorkflow([step("x", 0, { status, retryAt: at(90), phase: "exec" })]);
		assert.equal(nodeOf(graph, "x").state, status, status);
	}
	const judging = layoutWorkflow([step("x", 0, { status: "running", phase: "judge", retryAt: at(90) })]);
	assert.equal(nodeOf(judging, "x").state, "judging");
});

test("a retry time already past is still retrying (drawn as due) until the attempt starts", () => {
	const graph = layoutWorkflow([step("a", 0, { retryAt: at(-5) })]);
	assert.equal(nodeOf(graph, "a").state, "retrying");
});

test("the incoming edges of a retrying step are active: the spine arrow, the subagent arrow and the retry loop", () => {
	const graph = layoutWorkflow([
		step("a", 0, { status: "done" }),
		step("b", 1, { retryAt: at(90), retryCount: 1 }),
	]);
	assert.equal(edgeOf(graph, "a->b").state, "active");
	assert.equal(edgeOf(graph, "b:from-subagent").state, "active");
	assert.equal(edgeOf(graph, "b:retry").state, "active");
});

test("the arrow leaving a retrying step is not active: only the step waiting to run lights its incoming edges", () => {
	const graph = layoutWorkflow([
		step("a", 0, { retryAt: at(90), retryCount: 1 }),
		step("b", 1, { status: "pending" }),
	]);
	assert.notEqual(edgeOf(graph, "a->b").state, "active");
});

test("a plain pending step (no retryAt) does not light its incoming edges", () => {
	const graph = layoutWorkflow([
		step("a", 0, { status: "done" }),
		step("b", 1, { retryCount: 0 }),
	]);
	assert.notEqual(edgeOf(graph, "a->b").state, "active");
	assert.notEqual(edgeOf(graph, "b:from-subagent").state, "active");
});

test("judgeState stays pending for a retrying step: the circle and its edge are pending", () => {
	const graph = layoutWorkflow([step("b", 0, { retryAt: at(90), retryCount: 1 })]);
	assert.equal(nodeOf(graph, "b").state, "retrying");
	assert.equal(nodeOf(graph, "b:judge").state, "pending");
	assert.equal(edgeOf(graph, "b:to-judge").state, "pending");
});

test("focusNodeId: a retrying step sits in the pending tier, so it is found and not skipped", () => {
	const after = layoutWorkflow([step("a", 0, { status: "done" }), step("b", 1, { retryAt: at(90) })]);
	assert.equal(focusNodeId(after.nodes), "b");
	const before = layoutWorkflow([step("a", 0, { retryAt: at(90) }), step("b", 1)]);
	assert.equal(focusNodeId(before.nodes), "a");
});

test("formatCountdown: exact text at and around every boundary", () => {
	const cases = [
		[0, "0s"],
		[1, "1s"],
		[45, "45s"],
		[59, "59s"],
		[60, "1m 00s"],
		[61, "1m 01s"],
		[125, "2m 05s"],
		[3599, "59m 59s"],
		[3600, "1h 00m"],
		[3720, "1h 02m"],
	];
	for (const [seconds, text] of cases) assert.equal(formatCountdown(seconds), text, String(seconds));
});

test("retryCountdown: a future time counts up in whole seconds; a reached or unreadable time is overdue", () => {
	assert.deepEqual(retryCountdown(at(90), NOW), { overdue: false, seconds: 90 });
	assert.deepEqual(retryCountdown(new Date(NOW + 1).toISOString(), NOW), { overdue: false, seconds: 1 });
	assert.deepEqual(retryCountdown(new Date(NOW + 1000).toISOString(), NOW), { overdue: false, seconds: 1 });
	assert.deepEqual(retryCountdown(new Date(NOW + 1001).toISOString(), NOW), { overdue: false, seconds: 2 });
	assert.deepEqual(retryCountdown(at(0), NOW), { overdue: true, seconds: 0 });
	assert.deepEqual(retryCountdown(at(-30), NOW), { overdue: true, seconds: 0 });
	assert.deepEqual(retryCountdown("not a time", NOW), { overdue: true, seconds: 0 });
});

test("the list label walks the countdown boundaries: 0, 1, 59, 60, 61, 3599, 3600 seconds", () => {
	const cases = [
		[0, "retry due"],
		[1, "retry in 1s"],
		[59, "retry in 59s"],
		[60, "retry in 1m 00s"],
		[61, "retry in 1m 01s"],
		[3599, "retry in 59m 59s"],
		[3600, "retry in 1h 00m"],
	];
	for (const [seconds, text] of cases) assert.equal(retryListLabel(at(seconds), NOW), text, String(seconds));
});

test("the four labels: list and canvas, future and due", () => {
	assert.equal(retryListLabel(at(45), NOW), "retry in 45s");
	assert.equal(retryListLabel(at(-1), NOW), "retry due");
	assert.equal(retryCanvasLabel(at(45), NOW), "retrying · 45s");
	assert.equal(retryCanvasLabel(at(-1), NOW), "retrying · due");
	assert.equal(retryCanvasLabel(at(45), NOW).includes("·"), true);
});

test("the helpers take the clock as a parameter: the same retryAt counts down as the clock moves", () => {
	assert.equal(retryListLabel(at(45), NOW + 10_000), "retry in 35s");
	assert.equal(retryCanvasLabel(at(45), NOW + 45_000), "retrying · due");
});

test("retryCountdown.ts exports the four helpers and reads no clock of its own", () => {
	const source = read("../ui/src/lib/retryCountdown.ts");
	for (const name of ["retryCountdown", "formatCountdown", "retryListLabel", "retryCanvasLabel"]) {
		assert.match(source, new RegExp(`export function ${name}\\(`), name);
	}
	assert.doesNotMatch(source, /Date\.now\(/);
	assert.doesNotMatch(source, /new Date\(/);
});
