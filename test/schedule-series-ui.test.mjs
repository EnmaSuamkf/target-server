import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
	DEFAULT_SCHEDULE_FILTER,
	SCHEDULE_FILTERS,
	describeNotice,
	filterRemoteWorkflows,
	seriesProblem,
	workflowBadges,
} from "../ui/src/lib/scheduleView.ts";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

const wf = (id, extra = {}) => ({
	id,
	client_id: "c1",
	name: id,
	status: "draft",
	local_id: null,
	sandbox: "docker",
	agent: null,
	conversation_context: null,
	step_count: 0,
	steps_pending_sync: 0,
	series_id: null,
	scheduled_for: null,
	schedule_state: null,
	next_run_at: null,
	archived_at: null,
	created_by: "server",
	created_at: "2026-03-01T00:00:00Z",
	...extra,
});

const SERIES = { id: "s1", name: "Nightly report", timezone: "Europe/Madrid", state: "active" };

const plain = wf("plain");
const armed = wf("armed", { series_id: "s1", schedule_state: "armed", next_run_at: "2026-03-11T08:00:00Z" });
const fired = wf("fired", { series_id: "s1", schedule_state: "fired", status: "completed", created_by: "hub" });
const archivedRun = wf("old", { series_id: "s1", schedule_state: "fired", archived_at: "2026-03-05T00:00:00Z" });
const archivedPlain = wf("archived-plain", { archived_at: "2026-03-02T00:00:00Z" });
const all = [plain, armed, fired, archivedRun, archivedPlain];
const ids = (list) => list.map((w) => w.id);

// --- Badges -----------------------------------------------------------------

test("the armed instance is badged 'Scheduled · next …' in the series timezone", () => {
	const [badge] = workflowBadges(armed, SERIES);
	assert.equal(badge.kind, "scheduled");
	assert.equal(badge.label, "Scheduled · next 2026-03-11 09:00");
	assert.match(badge.title, /Europe\/Madrid/);
});

test("a fired instance is badged 'Run of <series>', falling back to its own name", () => {
	assert.equal(workflowBadges(fired, SERIES)[0].label, "Run of Nightly report");
	assert.equal(workflowBadges(fired, null)[0].label, "Run of fired");
});

test("an archived workflow gets an Archived badge next to its series badge", () => {
	assert.deepEqual(workflowBadges(archivedRun, SERIES).map((b) => b.kind), ["run", "archived"]);
	assert.deepEqual(workflowBadges(archivedPlain, null).map((b) => b.label), ["Archived"]);
	assert.deepEqual(workflowBadges(plain, null), []);
});

// --- Filters ----------------------------------------------------------------

test("archived workflows are hidden by default", () => {
	assert.equal(DEFAULT_SCHEDULE_FILTER, "all");
	assert.deepEqual(ids(filterRemoteWorkflows(all, DEFAULT_SCHEDULE_FILTER)), ["plain", "armed", "fired"]);
});

test("Scheduled keeps only the armed instances", () => {
	assert.deepEqual(ids(filterRemoteWorkflows(all, "scheduled")), ["armed"]);
});

test("Scheduled runs keeps the series instances that are not armed, without archived ones", () => {
	assert.deepEqual(ids(filterRemoteWorkflows(all, "runs")), ["fired"]);
});

test("Archived shows only archived workflows, scheduled or not", () => {
	assert.deepEqual(ids(filterRemoteWorkflows(all, "archived")), ["old", "archived-plain"]);
});

test("the filter bar offers All, Scheduled, Scheduled runs and Archived", () => {
	assert.deepEqual(SCHEDULE_FILTERS.map((f) => f.label), ["All", "Scheduled", "Scheduled runs", "Archived"]);
});

// --- Notices ----------------------------------------------------------------

const notice = (extra) => ({ id: "n1", series_id: "s1", remote_id: null, kind: "missed", reason: null, occurrences: [], created_at: "2026-03-10T00:00:00Z", ...extra });

test("a missed notice counts the runs and lists them in the series timezone", () => {
	const view = describeNotice(
		notice({ occurrences: ["2026-03-09T08:00:00Z", "2026-03-10T08:00:00Z"] }),
		"Europe/Madrid",
	);
	assert.equal(view.tone, "warn");
	assert.equal(view.title, "2 runs missed");
	assert.match(view.detail, /2026-03-09 09:00, 2026-03-10 09:00/);
	assert.match(view.detail, /hub was offline/);
});

test("a skipped notice explains the reason", () => {
	assert.match(describeNotice(notice({ kind: "skipped", reason: "busy" }), "UTC").detail, /previous run was still in progress/);
	assert.match(describeNotice(notice({ kind: "skipped", reason: "forbidden" }), "UTC").detail, /permissions/);
	assert.match(describeNotice(notice({ kind: "skipped", reason: "stale" }), "UTC").detail, /too old/);
});

test("a broken series reports a problem, a healthy one does not", () => {
	assert.match(seriesProblem({ state: "broken" }), /broken/);
	assert.equal(seriesProblem({ state: "active" }), null);
});

// --- Components -------------------------------------------------------------

test("the series view lists instances with status and created_by, plus notices and the broken banner", () => {
	const source = read("../ui/src/components/SeriesView.tsx");
	assert.match(source, /export function SeriesView/);
	assert.match(source, /series\.instances\.map/);
	assert.match(source, /<th>Status<\/th>/);
	assert.match(source, /<th>Created by<\/th>/);
	assert.match(source, /<StatusBadge status=\{w\.status\} \/>/);
	assert.match(source, /w\.created_by/);
	assert.match(source, /series\.notices\.map/);
	assert.match(source, /describeNotice\(notice, series\.timezone\)/);
	assert.match(source, /seriesProblem\(series\)/);
	assert.match(source, /role="alert"/);
});

test("the remote workflows list badges, filters and shows the series", () => {
	const source = read("../ui/src/components/RemoteWorkflowsPanel.tsx");
	assert.match(source, /<ScheduleFilterBar value=\{scheduleFilter\}/);
	assert.match(source, /filterRemoteWorkflows\(workflows \?\? \[\], scheduleFilter\)/);
	assert.match(source, /useState<ScheduleFilter>\(DEFAULT_SCHEDULE_FILTER\)/);
	assert.match(source, /visibleWorkflows\.map/);
	assert.match(source, /<ScheduleBadges workflow=\{w\}/);
	assert.match(source, /<SeriesView key=\{series\.id\}/);
	assert.match(source, /Scheduled series/);
});

test("the activity workflows table badges and filters scheduled and archived workflows", () => {
	const source = read("../ui/src/components/WorkflowsTable.tsx");
	assert.match(source, /<ScheduleFilterBar value=\{filter\}/);
	assert.match(source, /matchesScheduleFilter\(remote, filter\)/);
	assert.match(source, /useState<ScheduleFilter>\(DEFAULT_SCHEDULE_FILTER\)/);
	assert.match(source, /<ScheduleBadges workflow=\{remote\}/);
	assert.match(source, /remoteByLocalId/);
	const app = read("../ui/src/App.tsx");
	assert.match(app, /remoteWorkflows=\{scheduleViewWorkflows\?\.remote_workflows \?\? null\}/);
	assert.match(app, /series=\{scheduleViewSeries\?\.series \?\? null\}/);
});

test("badges and filter bar render the labels the operator reads", () => {
	const badges = read("../ui/src/components/ScheduleBadges.tsx");
	assert.match(badges, /workflowBadges\(workflow, series\)/);
	assert.match(badges, /title=\{b\.title\}/);
	const bar = read("../ui/src/components/ScheduleFilterBar.tsx");
	assert.match(bar, /aria-label="Schedule filter"/);
	assert.match(bar, /aria-pressed=\{value === f\.id\}/);
});
