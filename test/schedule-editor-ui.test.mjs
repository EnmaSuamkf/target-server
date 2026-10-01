import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
	browserTimeZone,
	describeSchedule,
	draftFromSeries,
	draftSpec,
	draftToBody,
	emptyScheduleDraft,
	formatInZone,
	nextOccurrence,
	previewRuns,
	validateSchedule,
} from "../ui/src/lib/schedule.ts";
import { cancelRemoteWorkflowSchedule, createRemoteWorkflow, setRemoteWorkflowSchedule } from "../ui/src/api/sync.ts";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

// --- Next-run preview (mirror of hub/schedule.ts) ---------------------------

test("preview lists the next three daily runs as wall-clock times in the schedule zone", () => {
	const runs = previewRuns({ kind: "daily", time: "09:00" }, "Europe/Madrid", new Date("2026-03-10T10:00:00Z"));
	assert.deepEqual(
		runs.map((r) => formatInZone(r, "Europe/Madrid")),
		["2026-03-11 09:00", "2026-03-12 09:00", "2026-03-13 09:00"],
	);
});

test("preview of a weekly schedule only lands on the picked days", () => {
	// 2026-03-09 is a Monday.
	const runs = previewRuns({ kind: "weekly", days: [5, 1], time: "08:30" }, "UTC", new Date("2026-03-09T09:00:00Z"));
	assert.deepEqual(
		runs.map((r) => r.toISOString()),
		["2026-03-13T08:30:00.000Z", "2026-03-16T08:30:00.000Z", "2026-03-20T08:30:00.000Z"],
	);
});

test("a once schedule previews a single run, and nothing once it has passed", () => {
	const spec = { kind: "once", at: "2026-06-01T12:00" };
	assert.equal(previewRuns(spec, "UTC", new Date("2026-05-01T00:00:00Z")).length, 1);
	assert.deepEqual(previewRuns(spec, "UTC", new Date("2026-07-01T00:00:00Z")), []);
});

test("DST: a skipped local time runs at the transition and a repeated one runs once", () => {
	// New York springs forward 2026-03-08 02:00 → 03:00; 02:30 does not exist.
	const gap = nextOccurrence({ kind: "daily", time: "02:30" }, "America/New_York", new Date("2026-03-08T00:00:00Z"));
	assert.equal(formatInZone(gap, "America/New_York"), "2026-03-08 03:00");
	// It falls back 2026-11-01 02:00 → 01:00; 01:30 happens twice, first occurrence wins.
	const first = nextOccurrence({ kind: "daily", time: "01:30" }, "America/New_York", new Date("2026-11-01T00:00:00Z"));
	assert.equal(first.toISOString(), "2026-11-01T05:30:00.000Z");
	const after = nextOccurrence({ kind: "daily", time: "01:30" }, "America/New_York", first);
	assert.equal(formatInZone(after, "America/New_York"), "2026-11-02 01:30");
});

test("an invalid schedule previews nothing and reports field errors", () => {
	assert.deepEqual(previewRuns({ kind: "weekly", days: [], time: "09:00" }, "UTC", new Date()), []);
	const fields = (spec, tz) => validateSchedule(spec, tz).map((e) => e.field);
	assert.deepEqual(fields({ kind: "weekly", days: [], time: "09:00" }, "UTC"), ["days"]);
	assert.deepEqual(fields({ kind: "daily", time: "" }, "UTC"), ["time"]);
	assert.deepEqual(fields({ kind: "once", at: "2026-02-30T10:00" }, "UTC"), ["at"]);
	assert.deepEqual(fields({ kind: "daily", time: "09:00" }, "america/new_york"), ["timezone"]);
});

// --- Draft <-> request body -------------------------------------------------

test("the editor draft defaults to the browser's zone, off, with the previous-run reference on", () => {
	const draft = emptyScheduleDraft();
	assert.equal(draft.timezone, browserTimeZone());
	assert.equal(draft.enabled, false);
	assert.equal(draft.includePrevious, true);
});

test("a draft only sends the fields of its kind, with sorted weekdays", () => {
	const draft = { ...emptyScheduleDraft("Europe/Madrid"), enabled: true, kind: "weekly", days: [5, 1, 3], time: "07:15", at: "2026-01-01T00:00" };
	assert.deepEqual(draftSpec(draft), { kind: "weekly", days: [1, 3, 5], time: "07:15" });
	assert.deepEqual(draftToBody({ ...draft, includePrevious: false }), {
		spec: { kind: "weekly", days: [1, 3, 5], time: "07:15" },
		timezone: "Europe/Madrid",
		include_previous: false,
	});
	assert.equal(draftToBody({ ...draft, days: [] }), null);
});

test("editing an existing series seeds the draft from it", () => {
	const draft = draftFromSeries({ spec: { kind: "once", at: "2026-06-01T12:00" }, timezone: "Asia/Tokyo", include_previous: false });
	assert.equal(draft.enabled, true);
	assert.equal(draft.kind, "once");
	assert.equal(draft.at, "2026-06-01T12:00");
	assert.equal(draft.timezone, "Asia/Tokyo");
	assert.equal(draft.includePrevious, false);
	assert.equal(describeSchedule({ kind: "weekly", days: [3, 1], time: "09:00" }, "UTC"), "Every Mon, Wed at 09:00 (UTC)");
});

// --- API client -------------------------------------------------------------

function mockFetch(status, body) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, init });
		return { ok: status < 400, status, json: async () => body };
	};
	return calls;
}

const SERIES = { id: "s1", state: "active" };

test("create-with-schedule sends the schedule in the create body", async () => {
	const calls = mockFetch(201, { remote_workflow: { id: "r1" }, command: { id: "c1" }, series: SERIES });
	const schedule = { spec: { kind: "daily", time: "09:00" }, timezone: "UTC", include_previous: true };
	const res = await createRemoteWorkflow({ client_id: "cl", name: "nightly", schedule });
	assert.equal(res.ok, true);
	assert.equal(calls[0].url, "/api/sync/remote-workflows");
	assert.equal(calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(calls[0].init.body).schedule, schedule);
});

test("editing a schedule PUTs the full schedule to the workflow", async () => {
	const calls = mockFetch(200, { remote_workflow: { id: "r1" }, series: SERIES, command: { id: "c2" } });
	const schedule = { spec: { kind: "once", at: "2026-06-01T12:00" }, timezone: "UTC", include_previous: false };
	const res = await setRemoteWorkflowSchedule("r 1", schedule);
	assert.equal(res.ok, true);
	assert.equal(calls[0].url, "/api/sync/remote-workflows/r%201/schedule");
	assert.equal(calls[0].init.method, "PUT");
	assert.deepEqual(JSON.parse(calls[0].init.body), schedule);
});

test("a busy workflow and an unsupported client surface as errors, not throws", async () => {
	const schedule = { spec: { kind: "daily", time: "09:00" }, timezone: "UTC", include_previous: true };
	mockFetch(409, { error: "remote_workflow_busy", status: "running" });
	const busy = await setRemoteWorkflowSchedule("r1", schedule);
	assert.equal(busy.ok, false);
	assert.equal(busy.errors[0].code, "remote_workflow_busy");
	mockFetch(409, { error: "capability_unsupported", detail: "Client does not support workflow.set_schedule" });
	const unsupported = await setRemoteWorkflowSchedule("r1", schedule);
	assert.equal(unsupported.ok, false);
	assert.equal(unsupported.errors[0].code, "capability_unsupported");
	assert.match(unsupported.errors[0].message, /workflow\.set_schedule/);
});

test("cancelling DELETEs the schedule and tolerates an already-cancelled series", async () => {
	const calls = mockFetch(200, { series: { id: "s1", state: "cancelled" }, command: null });
	const res = await cancelRemoteWorkflowSchedule("r1");
	assert.equal(res.ok, true);
	assert.equal(res.command, null);
	assert.equal(calls[0].url, "/api/sync/remote-workflows/r1/schedule");
	assert.equal(calls[0].init.method, "DELETE");
	mockFetch(404, { error: "schedule_not_found" });
	const missing = await cancelRemoteWorkflowSchedule("r1");
	assert.equal(missing.ok, false);
	assert.equal(missing.errors[0].code, "schedule_not_found");
});

// --- Components -------------------------------------------------------------

test("ScheduleEditor offers kind, date/time, weekdays, timezone, include-previous and a next-runs preview", () => {
	const source = read("../ui/src/components/ScheduleEditor.tsx");
	assert.match(source, /import \{ Field \} from "\.\/Field\.tsx"/);
	assert.match(source, /export function ScheduleEditor/);
	assert.match(source, /label="Repeats"/);
	assert.match(source, /label="Date and time"/);
	assert.match(source, /type="datetime-local"/);
	assert.match(source, /label="Time"/);
	assert.match(source, /<legend className="label">Days<\/legend>/);
	assert.match(source, /label="Time zone"/);
	assert.match(source, /Defaults to this browser's zone/);
	assert.match(source, /includePrevious/);
	assert.match(source, /<h5>Next runs<\/h5>/);
	assert.match(source, /previewRuns\(/);
});

test("ScheduleEditor explains why it is disabled instead of hiding", () => {
	const source = read("../ui/src/components/ScheduleEditor.tsx");
	assert.match(source, /disabledReason/);
	assert.match(source, /Scheduling is unavailable: \{disabledReason\}/);
	assert.match(source, /disabled=\{disabled\}/);
});

test("the create form embeds the editor and sends the schedule only when enabled and supported", () => {
	const source = read("../ui/src/components/RemoteWorkflowsPanel.tsx");
	assert.match(source, /import \{ ScheduleEditor \} from "\.\/ScheduleEditor\.tsx"/);
	assert.match(source, /<legend>When it runs<\/legend>/);
	assert.match(source, /value=\{createSchedule\}/);
	assert.match(source, /createSchedule\.enabled && !createScheduleReason/);
	assert.match(source, /body\.schedule = schedule/);
	assert.match(source, /fieldErrors\(errors, "schedule"\)/);
});

test("the panel edits and cancels the schedule of an existing workflow", () => {
	const source = read("../ui/src/components/RemoteWorkflowsPanel.tsx");
	assert.match(source, /aria-label="Schedule"/);
	assert.match(source, /setRemoteWorkflowSchedule\(selected\.id, schedule\)/);
	assert.match(source, /cancelRemoteWorkflowSchedule\(selected\.id\)/);
	assert.match(source, /Save schedule/);
	assert.match(source, /Cancel schedule/);
	assert.match(source, /\/api\/sync\/schedule-series"/);
});

test("scheduling is disabled with an explanation for missing permission, capability and busy runs", () => {
	const source = read("../ui/src/components/RemoteWorkflowsPanel.tsx");
	assert.match(source, /SCHEDULE_COMMAND = "workflow\.set_schedule"/);
	assert.match(source, /capabilities\?\.commands\?\.includes\(SCHEDULE_COMMAND\)/);
	assert.match(source, /does not support scheduled workflows yet/);
	assert.match(source, /client\.workflows\.execute and client\.workflows\.manage/);
	assert.match(source, /SCHEDULE_BUSY_STATUSES = new Set\(\["running", "waiting", "paused", "deleting"\]\)/);
	assert.match(source, /its schedule can be changed once the run is over/);
	assert.match(source, /disabledReason=\{selectedScheduleReason\}/);
});
