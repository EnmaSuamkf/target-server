/**
 * Behaviour checks for the step notes timeline rules: order, tie-break,
 * edited marker and author label.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { authorLabel, isEdited, noteTimeLabel, orderNotesForTimeline } from "../ui/src/lib/stepTimeline.ts";

test("orderNotesForTimeline puts notes oldest first by createdAt", () => {
	const notes = [
		{ id: "c", createdAt: "2026-01-03T10:00:00.000Z" },
		{ id: "a", createdAt: "2026-01-01T10:00:00.000Z" },
		{ id: "b", createdAt: "2026-01-02T10:00:00.000Z" },
	];
	assert.deepEqual(
		orderNotesForTimeline(notes).map((n) => n.id),
		["a", "b", "c"],
	);
});

test("orderNotesForTimeline keeps the original order for notes created in the same instant", () => {
	const at = "2026-01-01T10:00:00.000Z";
	const notes = [
		{ id: "first", createdAt: at },
		{ id: "second", createdAt: at },
		{ id: "third", createdAt: at },
	];
	assert.deepEqual(
		orderNotesForTimeline(notes).map((n) => n.id),
		["first", "second", "third"],
	);
});

test("orderNotesForTimeline sorts an unreadable timestamp as the epoch and does not mutate the input", () => {
	const notes = [
		{ id: "dated", createdAt: "2026-01-01T10:00:00.000Z" },
		{ id: "broken", createdAt: "not-a-date" },
	];
	const before = notes.map((n) => n.id);
	assert.deepEqual(
		orderNotesForTimeline(notes).map((n) => n.id),
		["broken", "dated"],
	);
	assert.deepEqual(
		notes.map((n) => n.id),
		before,
	);
});

test("isEdited is true only when updatedAt is later than createdAt", () => {
	assert.equal(isEdited({ createdAt: "2026-01-01T10:00:00.000Z", updatedAt: "2026-01-01T11:00:00.000Z" }), true);
	assert.equal(isEdited({ createdAt: "2026-01-01T10:00:00.000Z", updatedAt: "2026-01-01T10:00:00.000Z" }), false);
	assert.equal(isEdited({ createdAt: "2026-01-01T10:00:00.000Z", updatedAt: "2025-12-31T10:00:00.000Z" }), false);
});

test("isEdited is false when either timestamp cannot be read", () => {
	assert.equal(isEdited({ createdAt: "garbage", updatedAt: "2026-01-01T10:00:00.000Z" }), false);
	assert.equal(isEdited({ createdAt: "2026-01-01T10:00:00.000Z", updatedAt: "garbage" }), false);
});

test("authorLabel names an agent note Agent and every other source Operator", () => {
	assert.equal(authorLabel("agent"), "Agent");
	assert.equal(authorLabel("operator"), "Operator");
	assert.equal(authorLabel("robot"), "Operator");
	assert.equal(authorLabel(""), "Operator");
});

test("noteTimeLabel shows only the clock time for a note created today, with the date otherwise", () => {
	const now = new Date(2026, 0, 10, 15, 0, 0);
	const today = new Date(2026, 0, 10, 9, 30, 0).toISOString();
	const earlier = new Date(2026, 0, 2, 9, 30, 0).toISOString();
	assert.equal(noteTimeLabel(today, now), new Date(today).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
	assert.match(noteTimeLabel(earlier, now), /Jan/);
	assert.equal(noteTimeLabel("not-a-date", now), "");
});
