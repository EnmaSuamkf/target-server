/**
 * Hub → server schedule events (D18–D20): schedule.instance_created is judged
 * per event (D19) and creates the hub-cloned instance; the other schedule and
 * archive events are mirrored onto the series and its instances.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { authed, login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-schedule-events-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const cookie = await login(base);
const DAILY = { spec: { kind: "daily", time: "09:00" }, timezone: "Europe/Madrid" };

async function call(pathname, { method = "GET", headers = {}, body } = {}) {
	const res = await fetch(`${base}${pathname}`, {
		method,
		headers: { "content-type": "application/json", ...headers },
		body: body == null ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

const operator = (pathname, opts = {}) => call(pathname, { ...opts, headers: authed(cookie) });

async function registerHub(name) {
	const reg = await call("/api/sync/register", {
		method: "POST",
		body: {
			name,
			capabilities: {
				commands: ["workflow.create", "step.add", "workflow.set_schedule", "workflow.cancel_schedule"],
				runners: [{ id: "claude", installed: true }],
			},
		},
	});
	assert.equal(reg.status, 201);
	return { id: reg.body.client_id, headers: { authorization: `Bearer ${reg.body.client_token}` } };
}

async function postEvents(hub, events) {
	const res = await call("/api/sync/events", { method: "POST", headers: hub.headers, body: { events } });
	assert.equal(res.status, 200, JSON.stringify(res.body));
	return res.body;
}

/** A server series with its first (server-created) instance. */
async function scheduledSeries(hub, name) {
	const res = await operator("/api/sync/remote-workflows", {
		method: "POST",
		body: { client_id: hub.id, name, agent: "claude", schedule: DAILY },
	});
	assert.equal(res.status, 201, JSON.stringify(res.body));
	return { seriesId: res.body.series.id, firstRemoteId: res.body.remote_workflow.id };
}

function announcement(remoteId, payload) {
	return { id: `instance-created:${remoteId}`, type: "schedule.instance_created", remote_id: remoteId, payload };
}

function instancePayload(seriesId, previousRemoteId, extra = {}) {
	return {
		series_id: seriesId,
		previous_remote_id: previousRemoteId,
		name: "Nightly · 2026-10-02 09:00",
		scheduled_for: "2026-10-02T07:00:00.000Z",
		schedule: { ...DAILY, include_previous: true },
		agent: "claude",
		sandbox: "docker",
		conversation_context: "Background.",
		steps: [
			{
				step_key: "s1",
				description: "Collect",
				acceptance_criteria: "Collected",
				manual_review: false,
				use_subagent: true,
				max_retries: 2,
				retry_interval_seconds: 30,
			},
			{
				step_key: "s2",
				description: "Report",
				acceptance_criteria: null,
				manual_review: true,
				use_subagent: false,
				max_retries: 0,
				retry_interval_seconds: 0,
			},
		],
		tcp_selections: [{ tcpId: "tcp-1", toolNames: ["search"] }],
		resource_selections: [{ resourceSetId: "rs-1", resourceNames: null }],
		...extra,
	};
}

async function remoteDetail(remoteId) {
	return operator(`/api/sync/remote-workflows/${remoteId}`);
}

async function seriesEntry(seriesId) {
	const res = await operator("/api/sync/schedule-series");
	return res.body.series.find((s) => s.id === seriesId);
}

async function storedEventIds(remoteId) {
	const res = await operator(`/api/sync/events?remote_id=${remoteId}&limit=200`);
	return res.body.events.map((e) => e.id);
}

const hubA = await registerHub("Hub A");
const hubB = await registerHub("Hub B");

test("schedule.instance_created creates the hub-cloned instance with steps and selections", async () => {
	const { seriesId, firstRemoteId } = await scheduledSeries(hubA, "Nightly");
	const remoteId = randomUUID();
	const result = await postEvents(hubA, [announcement(remoteId, instancePayload(seriesId, firstRemoteId))]);
	assert.deepEqual(result, { accepted: [`instance-created:${remoteId}`], rejected: [], duplicates: [] });

	const detail = await remoteDetail(remoteId);
	assert.equal(detail.status, 200);
	const rw = detail.body.remote_workflow;
	assert.equal(rw.client_id, hubA.id);
	assert.equal(rw.name, "Nightly · 2026-10-02 09:00");
	assert.equal(rw.created_by, "hub");
	assert.equal(rw.local_id, null, "local mapping pending");
	assert.equal(rw.series_id, seriesId);
	assert.equal(rw.schedule_state, "armed");
	assert.equal(rw.scheduled_for, "2026-10-02T07:00:00.000Z");
	assert.equal(rw.agent, "claude");
	assert.equal(rw.sandbox, "docker");
	assert.equal(rw.conversation_context, "Background.");
	assert.deepEqual(rw.tcp_selections, [{ tcpId: "tcp-1", toolNames: ["search"] }]);
	assert.deepEqual(rw.resource_selections, [{ resourceSetId: "rs-1", resourceNames: null }]);
	assert.deepEqual(
		detail.body.steps.map((s) => [s.step_key, s.order_index, s.description, s.acceptance_criteria, s.manual_review, s.use_subagent, s.max_retries, s.retry_interval_seconds, s.on_client]),
		[
			["s1", 0, "Collect", "Collected", false, true, 2, 30, true],
			["s2", 1, "Report", null, true, false, 0, 0, true],
		],
	);
	assert.deepEqual(detail.body.pending_commands, [], "nothing is sent back to the hub");

	// The instance it was cloned from has fired.
	assert.equal((await remoteDetail(firstRemoteId)).body.remote_workflow.schedule_state, "fired");
	const entry = await seriesEntry(seriesId);
	assert.deepEqual(entry.instances.map((i) => i.id), [firstRemoteId, remoteId]);
	assert.deepEqual(await storedEventIds(remoteId), [`instance-created:${remoteId}`]);
});

test("a resent announcement is idempotent", async () => {
	const { seriesId, firstRemoteId } = await scheduledSeries(hubA, "Idempotent");
	const remoteId = randomUUID();
	const event = announcement(remoteId, instancePayload(seriesId, firstRemoteId));
	assert.deepEqual((await postEvents(hubA, [event])).accepted, [event.id]);

	// Same deterministic id (restart, lost response): a duplicate.
	const again = await postEvents(hubA, [event]);
	assert.deepEqual(again, { accepted: [], rejected: [], duplicates: [event.id] });
	// Same instance under another event id: accepted without a second row.
	const other = await postEvents(hubA, [{ ...event, id: `retry-${remoteId}` }]);
	assert.deepEqual(other.accepted, [`retry-${remoteId}`]);

	const entry = await seriesEntry(seriesId);
	assert.deepEqual(entry.instances.map((i) => i.id), [firstRemoteId, remoteId]);
	assert.equal((await remoteDetail(remoteId)).body.steps.length, 2);
});

test("D19 rejections: each reason refuses the announcement and writes nothing", async () => {
	const a = await scheduledSeries(hubA, "Alpha series");
	const b = await scheduledSeries(hubB, "Beta series");
	const cancelled = await scheduledSeries(hubA, "Cancelled series");
	const del = await operator(`/api/sync/remote-workflows/${cancelled.firstRemoteId}/schedule`, { method: "DELETE" });
	assert.equal(del.status, 200);
	const otherA = await scheduledSeries(hubA, "Other alpha series");
	const plainA = await operator("/api/sync/remote-workflows", { method: "POST", body: { client_id: hubA.id, name: "Plain" } });

	const cases = [
		["unknown_series", randomUUID(), instancePayload(randomUUID(), a.firstRemoteId)],
		["foreign_series", randomUUID(), instancePayload(b.seriesId, b.firstRemoteId)],
		["series_cancelled", randomUUID(), instancePayload(cancelled.seriesId, cancelled.firstRemoteId)],
		// Hub B's own instance id, announced by hub A.
		["foreign_remote_id", b.firstRemoteId, instancePayload(a.seriesId, a.firstRemoteId)],
		["invalid_previous_remote_id", randomUUID(), instancePayload(a.seriesId, otherA.firstRemoteId)],
		["invalid_previous_remote_id", randomUUID(), instancePayload(a.seriesId, null)],
		["invalid_previous_remote_id", randomUUID(), instancePayload(a.seriesId, b.firstRemoteId)],
		["remote_id_conflict", plainA.body.remote_workflow.id, instancePayload(a.seriesId, a.firstRemoteId)],
		["invalid_payload", randomUUID(), instancePayload(a.seriesId, a.firstRemoteId, { series_id: undefined })],
		["invalid_payload", randomUUID(), instancePayload(a.seriesId, a.firstRemoteId, { steps: [{ step_key: "x", description: "a" }, { step_key: "x", description: "b" }] })],
	];
	for (const [reason, remoteId, payload] of cases) {
		const before = await remoteDetail(remoteId);
		const event = announcement(remoteId, payload);
		const result = await postEvents(hubA, [event]);
		assert.deepEqual(result, { accepted: [], rejected: [{ id: event.id, reason }], duplicates: [] }, reason);
		const afterDetail = await remoteDetail(remoteId);
		assert.deepEqual(afterDetail.body, before.body, `${reason}: nothing written`);
		assert.ok(!(await storedEventIds(remoteId)).includes(event.id), `${reason}: event not stored`);
	}
	const noRemote = await postEvents(hubA, [{ id: "no-remote", type: "schedule.instance_created", payload: instancePayload(a.seriesId, a.firstRemoteId) }]);
	assert.deepEqual(noRemote.rejected, [{ id: "no-remote", reason: "remote_id_required" }]);

	// Every refused announcement left the series as it was; a valid one in the
	// same batch as a refused one still goes through.
	assert.deepEqual((await seriesEntry(a.seriesId)).instances.map((i) => i.id), [a.firstRemoteId]);
	const good = randomUUID();
	const mixed = await postEvents(hubA, [
		announcement(randomUUID(), instancePayload(randomUUID(), a.firstRemoteId)),
		announcement(good, instancePayload(a.seriesId, a.firstRemoteId)),
	]);
	assert.equal(mixed.rejected.length, 1);
	assert.deepEqual(mixed.accepted, [`instance-created:${good}`]);
});

test("workflow.schedule_changed mirrors instance state/next_run_at and the series state", async () => {
	const { seriesId, firstRemoteId } = await scheduledSeries(hubA, "Mirrored");
	const changed = (id, state, nextRunAt, remoteId = firstRemoteId, series = seriesId) => ({
		id,
		type: "workflow.schedule_changed",
		remote_id: remoteId,
		payload: { series_id: series, state, next_run_at: nextRunAt },
	});

	await postEvents(hubA, [changed("sc-1", "armed", "2026-10-01T07:00:00.000Z")]);
	let rw = (await remoteDetail(firstRemoteId)).body.remote_workflow;
	assert.equal(rw.schedule_state, "armed");
	assert.equal(rw.next_run_at, "2026-10-01T07:00:00.000Z");
	assert.equal((await seriesEntry(seriesId)).state, "active");

	await postEvents(hubA, [changed("sc-2", "broken", null)]);
	rw = (await remoteDetail(firstRemoteId)).body.remote_workflow;
	assert.equal(rw.schedule_state, "broken");
	assert.equal(rw.next_run_at, null);
	assert.equal((await seriesEntry(seriesId)).state, "broken");

	// Re-armed after the operator reschedules: the series is active again.
	await postEvents(hubA, [changed("sc-3", "armed", "2026-10-02T07:00:00.000Z")]);
	assert.equal((await seriesEntry(seriesId)).state, "active");

	// Hub B can't touch hub A's series (foreign remote_id), nor with its own remote_id.
	const b = await scheduledSeries(hubB, "B mirror");
	const foreign = await postEvents(hubB, [changed("sc-foreign", "broken", null)]);
	assert.deepEqual(foreign.rejected, [{ id: "sc-foreign", reason: "foreign_remote_id" }]);
	await postEvents(hubB, [changed("sc-foreign-series", "broken", null, b.firstRemoteId, seriesId)]);
	assert.equal((await seriesEntry(seriesId)).state, "active");
	assert.equal((await remoteDetail(b.firstRemoteId)).body.remote_workflow.schedule_state, null);

	// The server's cancel is final: a stale "armed" doesn't revive it; the
	// hub's own "cancelled" is mirrored on the instance.
	await operator(`/api/sync/remote-workflows/${firstRemoteId}/schedule`, { method: "DELETE" });
	await postEvents(hubA, [changed("sc-4", "armed", "2026-10-03T07:00:00.000Z")]);
	assert.equal((await seriesEntry(seriesId)).state, "cancelled");
	await postEvents(hubA, [changed("sc-5", "cancelled", null)]);
	assert.equal((await remoteDetail(firstRemoteId)).body.remote_workflow.schedule_state, "cancelled");
	assert.equal((await seriesEntry(seriesId)).state, "cancelled");
});

test("schedule.run_missed and schedule.run_skipped are stored as series notices", async () => {
	const { seriesId, firstRemoteId } = await scheduledSeries(hubA, "Noticed");
	await postEvents(hubA, [
		{
			id: "missed-1",
			type: "schedule.run_missed",
			remote_id: firstRemoteId,
			payload: { series_id: seriesId, occurrences: ["2026-09-28T07:00:00.000Z", "2026-09-29T07:00:00.000Z"] },
			created_at: "2026-09-30T08:00:00.000Z",
		},
		{
			id: "skipped-1",
			type: "schedule.run_skipped",
			remote_id: firstRemoteId,
			payload: { series_id: seriesId, reason: "busy", occurrence: "2026-09-30T07:00:00.000Z" },
			created_at: "2026-09-30T09:00:00.000Z",
		},
	]);
	const entry = await seriesEntry(seriesId);
	assert.deepEqual(entry.notices, [
		{
			id: "skipped-1",
			series_id: seriesId,
			remote_id: firstRemoteId,
			kind: "skipped",
			reason: "busy",
			occurrences: ["2026-09-30T07:00:00.000Z"],
			created_at: "2026-09-30T09:00:00.000Z",
		},
		{
			id: "missed-1",
			series_id: seriesId,
			remote_id: firstRemoteId,
			kind: "missed",
			reason: null,
			occurrences: ["2026-09-28T07:00:00.000Z", "2026-09-29T07:00:00.000Z"],
			created_at: "2026-09-30T08:00:00.000Z",
		},
	]);
	// A resend is a duplicate and adds no notice; another client's series gets none.
	const dup = await postEvents(hubA, [{ id: "missed-1", type: "schedule.run_missed", remote_id: firstRemoteId, payload: { series_id: seriesId, occurrences: [] } }]);
	assert.deepEqual(dup.duplicates, ["missed-1"]);
	await postEvents(hubB, [{ id: "skipped-foreign", type: "schedule.run_skipped", payload: { series_id: seriesId, reason: "forbidden" } }]);
	assert.equal((await seriesEntry(seriesId)).notices.length, 2);
});

test("workflow.archived / workflow.unarchived set and clear archived_at", async () => {
	const created = await operator("/api/sync/remote-workflows", { method: "POST", body: { client_id: hubA.id, name: "Archivable" } });
	const remoteId = created.body.remote_workflow.id;
	await postEvents(hubA, [{ id: "arch-1", type: "workflow.archived", remote_id: remoteId, payload: { archived_at: "2026-09-30T10:00:00.000Z" } }]);
	assert.equal((await remoteDetail(remoteId)).body.remote_workflow.archived_at, "2026-09-30T10:00:00.000Z");
	await postEvents(hubA, [{ id: "unarch-1", type: "workflow.unarchived", remote_id: remoteId, payload: { archived_at: null } }]);
	assert.equal((await remoteDetail(remoteId)).body.remote_workflow.archived_at, null);
	// Without a timestamp the event's own time is used.
	await postEvents(hubA, [{ id: "arch-2", type: "workflow.archived", remote_id: remoteId, payload: {}, created_at: "2026-09-30T11:00:00.000Z" }]);
	assert.equal((await remoteDetail(remoteId)).body.remote_workflow.archived_at, "2026-09-30T11:00:00.000Z");
	// Another client can't archive it.
	const foreign = await postEvents(hubB, [{ id: "unarch-foreign", type: "workflow.unarchived", remote_id: remoteId, payload: {} }]);
	assert.deepEqual(foreign.rejected, [{ id: "unarch-foreign", reason: "foreign_remote_id" }]);
	assert.equal((await remoteDetail(remoteId)).body.remote_workflow.archived_at, "2026-09-30T11:00:00.000Z");
});
