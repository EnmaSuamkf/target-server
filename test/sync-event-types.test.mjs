/**
 * Schedule series / archive event types (D20): accepted and stored with their
 * payload intact, not mirrored yet, and advertised to the hub through
 * `server_capabilities.events` on register and heartbeat.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { authed, login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-sync-event-types-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.TARGET_DEVICE_LINKING_MODE = "legacy";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
const { EVENT_TYPES } = await import("../blueprint.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

const cookie = await login(base);

const NEW_TYPES = [
	"schedule.instance_created",
	"workflow.schedule_changed",
	"schedule.run_missed",
	"schedule.run_skipped",
	"workflow.archived",
	"workflow.unarchived",
];

async function registerClient(name) {
	const res = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, capabilities: { commands: ["workflow.create"] } }),
	});
	assert.equal(res.status, 201);
	const body = await res.json();
	return {
		id: body.client_id,
		body,
		headers: { authorization: `Bearer ${body.client_token}`, "content-type": "application/json" },
	};
}

async function createRemote(clientId, name) {
	const res = await fetch(`${base}/api/sync/remote-workflows`, {
		method: "POST",
		headers: { "content-type": "application/json", ...authed(cookie) },
		body: JSON.stringify({ client_id: clientId, name, agent: "claude" }),
	});
	const body = await res.json();
	assert.equal(res.status, 201, JSON.stringify(body));
	return body.remote_workflow.id;
}

async function postEvents(client, events) {
	return fetch(`${base}/api/sync/events`, {
		method: "POST",
		headers: client.headers,
		body: JSON.stringify({ events }),
	});
}

function readDb(fn) {
	const handle = new DatabaseSync(tmpDb, { readOnly: true });
	try {
		return fn(handle);
	} finally {
		handle.close();
	}
}

const hub = await registerClient("Schedule hub");
const other = await registerClient("Other hub");
const hubRemote = await createRemote(hub.id, "Nightly report #3");
const otherRemote = await createRemote(other.id, "Other workflow");

test("EVENT_TYPES includes the schedule and archive types", () => {
	for (const type of NEW_TYPES) assert.ok(EVENT_TYPES.includes(type), type);
});

test("one event of each new type is accepted and stored with its payload intact", async () => {
	const events = [
		{
			id: "sched-instance",
			type: "schedule.instance_created",
			remote_id: hubRemote,
			payload: {
				series_id: "series-1",
				previous_remote_id: "rwf_previous",
				name: "Nightly report #3",
				scheduled_for: "2026-09-30T02:00:00.000Z",
				schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
				agent: "claude",
				sandbox: "docker",
				conversation_context: "Summarise yesterday's incidents.",
				steps: [
					{ step_key: "s1", description: "Collect incidents", acceptance_criteria: "List is non-empty" },
					{ step_key: "s2", description: "Write report", max_retries: 2 },
				],
				tcp_selections: [{ tcp_id: "tcp-1", tool_names: ["search"] }],
				resource_selections: [{ resource_set_id: "rs-1", resource_ids: ["r1"] }],
			},
		},
		{
			id: "sched-changed",
			type: "workflow.schedule_changed",
			payload: { series_id: "series-1", state: "paused", next_run_at: null },
		},
		{
			id: "sched-missed",
			type: "schedule.run_missed",
			payload: { series_id: "series-1", occurrences: ["2026-09-28T02:00:00.000Z", "2026-09-29T02:00:00.000Z"] },
		},
		{
			id: "sched-skipped",
			type: "schedule.run_skipped",
			payload: { series_id: "series-1", reason: "previous_run_active" },
		},
		{
			id: "wf-archived",
			type: "workflow.archived",
			remote_id: hubRemote,
			payload: { remote_id: hubRemote, archived_at: "2026-09-30T03:00:00.000Z" },
		},
		{ id: "wf-unarchived", type: "workflow.unarchived", remote_id: hubRemote, payload: { remote_id: hubRemote } },
	];
	const statusBefore = readDb((db) => db.prepare("SELECT status FROM remote_workflows WHERE id = ?").get(hubRemote).status);

	const res = await postEvents(hub, events);
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { accepted: events.map((e) => e.id), rejected: [], duplicates: [] });

	const rows = readDb((db) =>
		db.prepare("SELECT id, client_id, remote_id, type, payload_json FROM sync_events WHERE client_id = ?").all(hub.id),
	);
	for (const event of events) {
		const row = rows.find((r) => r.id === event.id);
		assert.ok(row, `${event.id} stored`);
		assert.equal(row.type, event.type);
		assert.equal(row.remote_id, event.remote_id ?? null);
		assert.deepEqual(JSON.parse(row.payload_json), event.payload);
	}
	// Stored only: nothing is mirrored into the plan yet.
	const statusAfter = readDb((db) => db.prepare("SELECT status FROM remote_workflows WHERE id = ?").get(hubRemote).status);
	assert.equal(statusAfter, statusBefore);
});

test("a new-type event for another client's remote_id is still rejected", async () => {
	const res = await postEvents(hub, [
		{ id: "steal-archive", type: "workflow.archived", remote_id: otherRemote, payload: { remote_id: otherRemote } },
	]);
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), {
		accepted: [],
		rejected: [{ id: "steal-archive", reason: "foreign_remote_id" }],
		duplicates: [],
	});
	assert.equal(readDb((db) => db.prepare("SELECT id FROM sync_events WHERE id = 'steal-archive'").get()), undefined);
});

test("register and heartbeat advertise server_capabilities.events = EVENT_TYPES", async () => {
	assert.deepEqual(hub.body.server_capabilities, { events: EVENT_TYPES });
	assert.ok("owner" in hub.body);

	const res = await fetch(`${base}/api/sync/heartbeat`, {
		method: "POST",
		headers: hub.headers,
		body: JSON.stringify({ status: "idle" }),
	});
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.ok("owner" in body);
	assert.deepEqual(body.server_capabilities, { events: EVENT_TYPES });
	for (const type of NEW_TYPES) assert.ok(body.server_capabilities.events.includes(type), type);
});

test("a batch with an unknown event type is rejected with 400 and stores nothing", async () => {
	const res = await postEvents(hub, [
		{ id: "ok-before-unknown", type: "schedule.run_skipped", payload: { series_id: "series-1", reason: "x" } },
		{ id: "unknown-type", type: "schedule.teleported", payload: {} },
	]);
	assert.equal(res.status, 400);
	const body = await res.json();
	assert.ok(body.errors.some((e) => e.field === "events.1.type"), JSON.stringify(body));
	const stored = readDb((db) =>
		db.prepare("SELECT id FROM sync_events WHERE id IN ('ok-before-unknown', 'unknown-type')").all(),
	);
	assert.deepEqual(stored, []);
});
