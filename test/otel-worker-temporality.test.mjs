/**
 * The worker honors the saved metricsTemporality: cumulative totals are
 * persisted with the sent mark and only then; delta never writes series.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-otel-wtemp-"));
process.env.TARGET_SERVER_DB = path.join(tmpDir, "default.db");
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");
process.env.TARGET_SECRETS_KEY = randomBytes(32).toString("hex");
delete process.env.TARGET_OTEL_ALLOW_PRIVATE;
mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);

const db = await import("../db.mjs");
const { createOtelWorker } = await import("../otel-worker.mjs");
const { DEFAULT_ORG_ID, runWithOrg } = db;
const inDefault = (fn) => runWithOrg(DEFAULT_ORG_ID, fn);

function fakeDestination(replies = [200]) {
	const requests = [];
	let i = 0;
	const fetchImpl = async (url, init) => {
		const status = replies[Math.min(i++, replies.length - 1)];
		requests.push({ url: String(url), body: JSON.parse(init.body) });
		return new Response("{}", { status });
	};
	return { requests, fetchImpl };
}
const clock = () => {
	let t = Date.now() + 5000;
	return { now: () => new Date(t), advance: (s) => (t += s * 1000) };
};
let n = 0;
const uid = (p) => `${p}-${++n}-${randomBytes(3).toString("hex")}`;
const iso = () => new Date().toISOString();
const put = (kind, workflowId, sessionId, data) => {
	const event = { id: uid("e"), kind, workflow_id: workflowId, session_id: sessionId, created_at: iso(), data };
	assert.equal(db.insertEvent("inst-1", "0.1", event, iso()), "inserted");
	return event;
};
const enqueue = (e) => db.enqueueOtelEvent(e.id, e.kind);
const usage = (uncached, out) => ({ input_tokens: uncached, cache_read: 0, cache_creation: 0, output_tokens: out, model: "claude-opus-4", cost_usd: null });
const configure = (metricsTemporality) => {
	db.deleteOtelConfig();
	return db.saveOtelConfig({ enabled: true, endpoint: "https://otlp.example.com", headers: { Authorization: "Bearer x-1234567" }, signals: ["metrics"], metricsTemporality });
};
const metrics = (body) => body.resourceMetrics[0].scopeMetrics[0].metrics;
const inputPoint = (body) =>
	metrics(body)
		.find((m) => m.name === "target.tokens")
		.sum.dataPoints.find((p) => p.attributes.some((a) => a.key === "token.type" && a.value.stringValue === "input"));
const seriesCount = () => Object.keys(db.loadOtelMetricSeries()).length;

test("cumulative: running totals reach the destination and series are persisted with the sent mark", async () => {
	const dest = fakeDestination();
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		configure("cumulative");
		const wf = uid("wf");
		enqueue(put("usage.snapshot", wf, "s", usage(100, 10)));
		await worker.runOnce();
		enqueue(put("usage.snapshot", wf, "s", usage(300, 40)));
		await worker.runOnce();
		const [a, b] = dest.requests.map((r) => inputPoint(r.body));
		assert.equal(metrics(dest.requests[0].body)[0].sum.aggregationTemporality, 2);
		assert.equal(a.asInt, "100");
		assert.equal(b.asInt, "300");
		assert.equal(a.startTimeUnixNano, b.startTimeUnixNano, "stable start across batches");
		const stored = Object.values(db.loadOtelMetricSeries()).find((s) => s.name === "target.tokens" && s.attributes.some((x) => x.value.stringValue === "input"));
		assert.equal(stored.value, 300);
		assert.equal(stored.startTimeUnixNano, a.startTimeUnixNano);
	});
});

test("delta: aggregationTemporality 1, per-batch values and no series written", async () => {
	const dest = fakeDestination();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: clock().now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		configure("delta");
		const wf = uid("wf");
		enqueue(put("usage.snapshot", wf, "s", usage(100, 10)));
		await worker.runOnce();
		enqueue(put("usage.snapshot", wf, "s", usage(300, 40)));
		await worker.runOnce();
		assert.equal(metrics(dest.requests[0].body)[0].sum.aggregationTemporality, 1);
		assert.deepEqual(dest.requests.map((r) => inputPoint(r.body).asInt), ["100", "200"]);
		assert.equal(seriesCount(), 0);
	});
});

test("a failed delivery leaves series and export state unadvanced; the retry carries the same totals", async () => {
	const dest = fakeDestination([503, 200]);
	const c = clock();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: c.now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		configure("cumulative");
		const wf = uid("wf");
		enqueue(put("usage.snapshot", wf, "s", usage(500, 50)));
		await worker.runOnce();
		assert.equal(seriesCount(), 0);
		assert.equal(db.getOtelExportState(wf, "s"), null);
		c.advance(11);
		await worker.runOnce();
		assert.deepEqual(dest.requests.map((r) => inputPoint(r.body).asInt), ["500", "500"]);
		assert.equal(seriesCount() > 0, true);
	});
});

test("a crash between send and commit does not advance series; the re-send is the same total", async () => {
	const dest = fakeDestination();
	let crash = true;
	const worker = createOtelWorker({
		fetchImpl: dest.fetchImpl,
		now: clock().now,
		listOrgIds: () => [DEFAULT_ORG_ID],
		beforeCommit: () => {
			if (crash) throw new Error("simulated crash");
		},
	});
	await inDefault(async () => {
		configure("cumulative");
		const wf = uid("wf");
		enqueue(put("usage.snapshot", wf, "s", usage(700, 70)));
		await worker.runOnce();
		assert.equal(seriesCount(), 0);
		crash = false;
		await worker.runOnce();
		assert.deepEqual(dest.requests.map((r) => inputPoint(r.body).asInt), ["700", "700"]);
		assert.equal(Object.values(db.loadOtelMetricSeries()).find((s) => s.name === "target.tokens")?.value > 0, true);
	});
});

test("changing the temporality on save clears the series; an unchanged save keeps them; export state is kept", async () => {
	const dest = fakeDestination();
	const worker = createOtelWorker({ fetchImpl: dest.fetchImpl, now: clock().now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		configure("cumulative");
		const wf = uid("wf");
		enqueue(put("usage.snapshot", wf, "s", usage(100, 10)));
		await worker.runOnce();
		assert.ok(seriesCount() > 0);
		db.saveOtelConfig({ endpoint: "https://other.example.com", metricsTemporality: "cumulative" });
		db.saveOtelConfig({ endpoint: "https://other.example.com" });
		assert.ok(seriesCount() > 0, "same value, or omitted: series stay");
		db.saveOtelConfig({ metricsTemporality: "delta" });
		assert.equal(seriesCount(), 0);
		assert.deepEqual(db.getOtelExportState(wf, "s").tokens.input, 100, "export state is not reset");
		// Back to cumulative: starts from zero for what is exported next.
		db.saveOtelConfig({ metricsTemporality: "cumulative" });
		enqueue(put("usage.snapshot", wf, "s", usage(250, 10)));
		await worker.runOnce();
		assert.equal(inputPoint(dest.requests.at(-1).body).asInt, "150", "starts at 0 plus the unexported delta");
	});
});

test("DELETE config clears the series", async () => {
	const worker = createOtelWorker({ fetchImpl: fakeDestination().fetchImpl, now: clock().now, listOrgIds: () => [DEFAULT_ORG_ID] });
	await inDefault(async () => {
		configure("cumulative");
		enqueue(put("usage.snapshot", uid("wf"), "s", usage(100, 10)));
		await worker.runOnce();
		assert.ok(seriesCount() > 0);
		assert.equal(db.deleteOtelConfig(), true);
		assert.equal(seriesCount(), 0);
	});
});

test("buildTestPayloads stamps the given temporality on the test sum", async () => {
	const { buildTestPayloads } = await import("../otel-test-payload.mjs");
	const t = (temporality) => buildTestPayloads({ orgId: "o", temporality }).metrics.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.aggregationTemporality;
	assert.equal(t("cumulative"), 2);
	assert.equal(t("delta"), 1);
	assert.equal(t(undefined), 1);
});
