/**
 * Schedule spec + timezone validation. The hub re-validates with
 * hub/schedule.ts validateSchedule and acks failed on disagreement, so these
 * cases mirror its rules.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { COMMAND_TYPES, isValidTimeZone, validate, validateCommand } from "../blueprint.mjs";

const schedule = (spec, timezone = "Europe/Madrid", extra = {}) =>
	validate("sync.remote_workflow.schedule", { spec, timezone, ...extra });

const fields = (r) => r.errors.map((e) => e.field).sort();

test("valid once / daily / weekly specs pass and include_previous defaults to true", () => {
	for (const spec of [
		{ kind: "once", at: "2026-10-01T09:00" },
		{ kind: "once", at: "2028-02-29T23:59" },
		{ kind: "daily", time: "00:00" },
		{ kind: "daily", time: "23:59" },
		{ kind: "weekly", days: [0], time: "07:15" },
		{ kind: "weekly", days: [6, 0, 3], time: "12:00" },
	]) {
		const r = schedule(spec);
		assert.equal(r.ok, true, JSON.stringify({ spec, errors: r.errors }));
		assert.deepEqual(r.value.spec, spec);
		assert.equal(r.value.include_previous, true);
	}
	assert.equal(schedule({ kind: "daily", time: "09:00" }, "UTC", { include_previous: false }).value.include_previous, false);
});

test("invalid kind, time and at are refused on the right field", () => {
	const cases = [
		[{}, ["spec.kind"]],
		[{ kind: "monthly", time: "09:00" }, ["spec.kind"]],
		[{ kind: "daily" }, ["spec.time"]],
		[{ kind: "daily", time: "24:00" }, ["spec.time"]],
		[{ kind: "daily", time: "9:00" }, ["spec.time"]],
		[{ kind: "daily", time: "09:60" }, ["spec.time"]],
		[{ kind: "daily", time: "09:00:00" }, ["spec.time"]],
		[{ kind: "once" }, ["spec.at"]],
		[{ kind: "once", at: "2026-10-01 09:00" }, ["spec.at"]],
		[{ kind: "once", at: "2026-10-01T09:00:00Z" }, ["spec.at"]],
		[{ kind: "once", at: "2026-02-30T09:00" }, ["spec.at"]],
		[{ kind: "once", at: "2027-02-29T09:00" }, ["spec.at"]],
		[{ kind: "once", at: "2026-13-01T09:00" }, ["spec.at"]],
		// Keys of another kind are refused rather than silently dropped.
		[{ kind: "once", at: "2026-10-01T09:00", time: "09:00" }, ["spec.time"]],
		[{ kind: "daily", time: "09:00", days: [1] }, ["spec.days"]],
	];
	for (const [spec, expected] of cases) {
		const r = schedule(spec);
		assert.equal(r.ok, false, JSON.stringify(spec));
		assert.deepEqual(fields(r), expected, JSON.stringify({ spec, errors: r.errors }));
	}
	assert.equal(schedule("daily at 9").ok, false);
	assert.equal(validate("sync.remote_workflow.schedule", { timezone: "UTC" }).ok, false);
});

test("weekly days must be unique integers 0-6, at least one", () => {
	for (const days of [[], [7], [-1], [1.5], ["1"], [1, 1], null]) {
		const r = schedule({ kind: "weekly", days, time: "09:00" });
		assert.equal(r.ok, false, JSON.stringify(days));
		assert.ok(r.errors.every((e) => e.field.startsWith("spec.days")), JSON.stringify(r.errors));
	}
	assert.equal(schedule({ kind: "weekly", time: "09:00" }).ok, false);
	const dup = schedule({ kind: "weekly", days: [2, 2], time: "09:00" });
	assert.equal(dup.errors[0].message, "days must not repeat");
});

test("timezone must be a real IANA zone, as the hub accepts it", () => {
	for (const tz of ["Europe/Madrid", "America/New_York", "UTC", "Asia/Calcutta"]) {
		assert.equal(isValidTimeZone(tz), true, tz);
		assert.equal(schedule({ kind: "daily", time: "09:00" }, tz).ok, true, tz);
	}
	for (const tz of Intl.supportedValuesOf("timeZone")) assert.equal(isValidTimeZone(tz), true, tz);
	for (const tz of ["", "Mars/Olympus", "america/new_york", "GMT+2", "Europe/Madrid ", 42, null]) {
		assert.equal(isValidTimeZone(tz), false, String(tz));
		const r = schedule({ kind: "daily", time: "09:00" }, tz);
		assert.equal(r.ok, false, String(tz));
		assert.deepEqual(fields(r), ["timezone"]);
	}
	const r = schedule({ kind: "daily", time: "09:00" }, "Nowhere/City");
	assert.equal(r.errors[0].message, "timezone must be a valid IANA time zone (e.g. Europe/Madrid)");
});

test("workflow.set_schedule and workflow.cancel_schedule are command types with validated payloads", () => {
	assert.ok(COMMAND_TYPES.includes("workflow.set_schedule"));
	assert.ok(COMMAND_TYPES.includes("workflow.cancel_schedule"));

	const ok = validateCommand("workflow.set_schedule", {
		series_id: "ser_1",
		spec: { kind: "weekly", days: [1, 5], time: "08:30" },
		timezone: "Europe/Madrid",
		include_previous: false,
	});
	assert.equal(ok.ok, true);
	assert.deepEqual(ok.value, {
		series_id: "ser_1",
		spec: { kind: "weekly", days: [1, 5], time: "08:30" },
		timezone: "Europe/Madrid",
		include_previous: false,
	});

	const missing = validateCommand("workflow.set_schedule", { spec: { kind: "daily", time: "08:30" } });
	assert.equal(missing.ok, false);
	assert.deepEqual(fields(missing), ["series_id", "timezone"]);

	const bad = validateCommand("workflow.set_schedule", {
		series_id: "ser_1",
		spec: { kind: "daily", time: "25:00" },
		timezone: "UTC",
		include_previous: "yes",
	});
	assert.deepEqual(fields(bad), ["include_previous", "spec.time"]);

	assert.equal(validateCommand("workflow.cancel_schedule", { series_id: "ser_1" }).ok, true);
	assert.equal(validateCommand("workflow.cancel_schedule", {}).ok, false);
});

test("a hub advertising the schedule commands registers", () => {
	const r = validate("sync.register", {
		name: "hub",
		capabilities: { commands: ["workflow.create", "workflow.set_schedule", "workflow.cancel_schedule"] },
	});
	assert.equal(r.ok, true, JSON.stringify(r.errors));
});
