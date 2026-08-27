/**
 * The workflow list is paged: the dashboard must never be able to ask for
 * "every workflow". These tests pin the contract the pager reads — one page of
 * rows plus the unpaged `total` — and the separate id+name list the filter
 * dropdown needs so paging cannot hide workflows from it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { once } from "node:events";
import { login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-page-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = "";

after(() => server.close());

const TOTAL = 30;

before(async () => {
	cookie = await login(base);
	// 30 workflows, each one event, with strictly increasing created_at so the
	// "newest activity first" order is deterministic: wf-29 … wf-00.
	const events = [];
	for (let i = 0; i < TOTAL; i++) {
		events.push({
			id: `ev-${i}`,
			kind: "workflow.created",
			workflow_id: `wf-${String(i).padStart(2, "0")}`,
			created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
			data: { name: `workflow ${i}`, agent: i % 2 === 0 ? "claude" : "free-code" },
		});
	}
	const res = await fetch(`${base}/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			batch_id: "b-page",
			instance_id: "inst-page",
			version: "0.2.0",
			sent_at: new Date().toISOString(),
			user: { display_name: "Ada" },
			events,
		}),
	});
	assert.equal(res.status, 200);
});

const list = async (qs = "") => (await fetch(`${base}/api/workflows${qs}`, { headers: { cookie } })).json();

test("the list is paged by default — an unqualified GET does not return everything", async () => {
	const page = await list();
	assert.equal(page.total, TOTAL);
	assert.equal(page.limit, 25); // the server's default page size
	assert.equal(page.offset, 0);
	assert.equal(page.workflows.length, 25);
});

test("limit + offset walk the list without gaps or repeats", async () => {
	const seen = [];
	for (let offset = 0; offset < TOTAL; offset += 10) {
		const page = await list(`?limit=10&offset=${offset}`);
		assert.equal(page.total, TOTAL);
		assert.equal(page.offset, offset);
		seen.push(...page.workflows.map((w) => w.workflowId));
	}
	assert.equal(seen.length, TOTAL);
	assert.equal(new Set(seen).size, TOTAL, "pages must not overlap");
	// Newest activity first, and the ingest order above makes that wf-29 … wf-00.
	assert.equal(seen[0], "wf-29");
	assert.equal(seen.at(-1), "wf-00");
});

test("a partial last page reports the real total, not the page length", async () => {
	const page = await list("?limit=25&offset=25");
	assert.equal(page.workflows.length, 5);
	assert.equal(page.total, TOTAL);
});

test("an offset past the end is an empty page, not an error", async () => {
	const page = await list("?limit=10&offset=999");
	assert.equal(page.workflows.length, 0);
	assert.equal(page.total, TOTAL);
});

test("limit is clamped: a client cannot ask for the whole table", async () => {
	const huge = await list("?limit=100000");
	assert.equal(huge.limit, 200); // MAX_PAGE_SIZE
	const zero = await list("?limit=0");
	assert.equal(zero.limit, 1);
	const junk = await list("?limit=abc&offset=-5");
	assert.equal(junk.limit, 25);
	assert.equal(junk.offset, 0);
});

test("`total` counts the filtered list, so the pager's 'of N' follows the filters", async () => {
	const filtered = await list("?agent=claude&limit=5");
	assert.equal(filtered.total, TOTAL / 2);
	assert.equal(filtered.workflows.length, 5);
	assert.ok(filtered.workflows.every((w) => w.agent === "claude"));
});

test("/api/workflows/names lists every match, so paging cannot hide one from the dropdown", async () => {
	const { workflows } = await (await fetch(`${base}/api/workflows/names`, { headers: { cookie } })).json();
	assert.equal(workflows.length, TOTAL);
	assert.deepEqual(Object.keys(workflows[0]).sort(), ["name", "workflowId"]);
	assert.equal(workflows[0].workflowId, "wf-29");
	assert.equal(workflows[0].name, "workflow 29");
	// It honours the same filters as the list itself.
	const claude = await (await fetch(`${base}/api/workflows/names?agent=claude`, { headers: { cookie } })).json();
	assert.equal(claude.workflows.length, TOTAL / 2);
});

test("the detail route still resolves — 'names' must not be read as a workflow id", async () => {
	const detail = await (await fetch(`${base}/api/workflows/wf-07`, { headers: { cookie } })).json();
	assert.equal(detail.workflow.workflowId, "wf-07");
	const missing = await fetch(`${base}/api/workflows/wf-nope`, { headers: { cookie } });
	assert.equal(missing.status, 404);
});
