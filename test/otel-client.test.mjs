/**
 * OTLP/HTTP client against a real local server, plus an injected fetch for the
 * cases a socket cannot fake cheaply (timeouts, network errors).
 */
import assert from "node:assert/strict";
import http from "node:http";
import test, { after, beforeEach } from "node:test";
import { gunzipSync } from "node:zlib";
import { otlpUrl, parseRetryAfter, sendOtlp } from "../otel-client.mjs";

const SECRET = "Bearer TOKEN-that-must-not-leak";
const BODY = { resourceSpans: [{ scopeSpans: [{ spans: [{ name: "x", startTimeUnixNano: "1790000000000000000" }] }] }] };

/** Requests the server saw, and the scripted replies (last one repeats). */
let seen = [];
let replies = [];
const server = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		seen.push({ method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks) });
		const reply = replies[Math.min(seen.length - 1, replies.length - 1)] ?? { status: 200, body: "{}" };
		res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
		res.end(reply.body ?? "{}");
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
beforeEach(() => {
	seen = [];
	replies = [];
});

/** A sleep that records its delays instead of waiting. */
const fakeSleep = () => {
	const delays = [];
	const sleep = async (ms) => void delays.push(ms);
	return { sleep, delays };
};

test("success: POSTs JSON to /v1/traces with caller headers", async () => {
	replies = [{ status: 200, body: '{"partialSuccess":{}}' }];
	const r = await sendOtlp({ endpoint: base, signal: "traces", body: BODY, headers: { Authorization: SECRET, "x-extra": "1" } });
	assert.deepEqual(r, { ok: true, status: 200, attempts: 1, partialSuccess: null, error: null });
	assert.equal(seen.length, 1);
	assert.equal(seen[0].method, "POST");
	assert.equal(seen[0].url, "/v1/traces");
	assert.equal(seen[0].headers["content-type"], "application/json");
	assert.equal(seen[0].headers.authorization, SECRET);
	assert.equal(seen[0].headers["x-extra"], "1");
	assert.equal(seen[0].headers["content-encoding"], undefined);
	assert.deepEqual(JSON.parse(seen[0].raw.toString()), BODY);
});

test("caller headers cannot override Content-Type", async () => {
	await sendOtlp({ endpoint: base, signal: "metrics", body: BODY, headers: { "content-type": "text/plain", "Content-Encoding": "br" } });
	assert.equal(seen[0].headers["content-type"], "application/json");
	assert.equal(seen[0].headers["content-encoding"], undefined);
});

test("path: appended per signal, never doubled, trailing slashes ignored", async () => {
	assert.equal(otlpUrl("http://h:4318", "traces"), "http://h:4318/v1/traces");
	assert.equal(otlpUrl("http://h:4318/", "metrics"), "http://h:4318/v1/metrics");
	assert.equal(otlpUrl("http://h/api/public/otel///", "traces"), "http://h/api/public/otel/v1/traces");
	assert.equal(otlpUrl("http://h/v1/traces", "traces"), "http://h/v1/traces");
	assert.equal(otlpUrl("http://h/v1/traces/", "traces"), "http://h/v1/traces");
	assert.equal(otlpUrl("http://h/v1/traces", "metrics"), "http://h/v1/metrics");
	await sendOtlp({ endpoint: `${base}/v1/traces/`, signal: "traces", body: BODY });
	await sendOtlp({ endpoint: `${base}/otlp/`, signal: "metrics", body: BODY });
	assert.deepEqual(seen.map((s) => s.url), ["/v1/traces", "/otlp/v1/metrics"]);
});

test("gzip: Content-Encoding is set and the server recovers the same JSON", async () => {
	const r = await sendOtlp({ endpoint: base, signal: "traces", body: BODY, gzip: true });
	assert.equal(r.ok, true);
	assert.equal(seen[0].headers["content-encoding"], "gzip");
	assert.equal(seen[0].headers["content-type"], "application/json");
	assert.deepEqual(JSON.parse(gunzipSync(seen[0].raw).toString()), BODY);
});

test("503 then 200: two attempts, the delay is Retry-After", async () => {
	replies = [{ status: 503, headers: { "retry-after": "7" } }, { status: 200, body: '{"partialSuccess":{}}' }];
	const { sleep, delays } = fakeSleep();
	const r = await sendOtlp({ endpoint: base, signal: "traces", body: BODY, sleep });
	assert.equal(r.ok, true);
	assert.equal(r.attempts, 2);
	assert.equal(seen.length, 2);
	assert.deepEqual(delays, [7000]);
});

test("Retry-After as an HTTP date, and a sane cap", async () => {
	const now = Date.parse("2026-10-03T10:00:00Z");
	assert.equal(parseRetryAfter("Sat, 03 Oct 2026 10:00:12 GMT", now), 12_000);
	assert.equal(parseRetryAfter("Sat, 03 Oct 2026 09:00:00 GMT", now), 0);
	assert.equal(parseRetryAfter("86400", now), 60_000);
	assert.equal(parseRetryAfter("soon", now), null);
	assert.equal(parseRetryAfter(null, now), null);
	replies = [{ status: 429, headers: { "retry-after": "Sat, 03 Oct 2026 10:00:05 GMT" } }, { status: 200 }];
	const { sleep, delays } = fakeSleep();
	const r = await sendOtlp({ endpoint: base, signal: "traces", body: BODY, sleep, now: () => now });
	assert.equal(r.ok, true);
	assert.deepEqual(delays, [5000]);
});

test("without Retry-After the wait is a growing, jittered backoff", async () => {
	replies = [{ status: 502 }, { status: 502 }, { status: 502 }, { status: 200 }];
	const { sleep, delays } = fakeSleep();
	const r = await sendOtlp({ endpoint: base, signal: "traces", body: BODY, sleep });
	assert.equal(r.attempts, 4);
	assert.equal(delays.length, 3);
	delays.forEach((d, i) => {
		const ceiling = 500 * 2 ** i;
		assert.ok(d >= ceiling / 2 && d <= ceiling, `delay ${d} outside [${ceiling / 2}, ${ceiling}]`);
	});
});

test("429 is retried", async () => {
	replies = [{ status: 429 }, { status: 200 }];
	const { sleep } = fakeSleep();
	const r = await sendOtlp({ endpoint: base, signal: "metrics", body: BODY, sleep });
	assert.equal(r.ok, true);
	assert.equal(r.attempts, 2);
});

test("exhausted retries: ok false with the attempt count and no throw", async () => {
	replies = [{ status: 503 }];
	const { sleep, delays } = fakeSleep();
	const r = await sendOtlp({ endpoint: base, signal: "traces", body: BODY, maxAttempts: 3, sleep });
	assert.equal(r.ok, false);
	assert.equal(r.status, 503);
	assert.equal(r.attempts, 3);
	assert.equal(r.partialSuccess, null);
	assert.equal(r.error, "HTTP 503");
	assert.equal(seen.length, 3);
	assert.equal(delays.length, 2);
});

test("400 is not retried: exactly one attempt", async () => {
	replies = [{ status: 400, body: '{"code":3,"message":"bad id"}' }];
	const { sleep, delays } = fakeSleep();
	const r = await sendOtlp({ endpoint: base, signal: "traces", body: BODY, sleep });
	assert.equal(r.ok, false);
	assert.equal(r.status, 400);
	assert.equal(r.attempts, 1);
	assert.equal(seen.length, 1);
	assert.deepEqual(delays, []);
	for (const status of [401, 403, 404, 413]) {
		replies = [{ status }];
		seen = [];
		assert.equal((await sendOtlp({ endpoint: base, signal: "traces", body: BODY, sleep })).attempts, 1);
	}
});

test("partialSuccess is surfaced on a 200", async () => {
	replies = [{ status: 200, body: '{"partialSuccess":{"rejectedSpans":"3","errorMessage":"too old"}}' }];
	const r = await sendOtlp({ endpoint: base, signal: "traces", body: BODY });
	assert.equal(r.ok, true);
	assert.deepEqual(r.partialSuccess, { rejectedSpans: 3, rejectedDataPoints: 0, errorMessage: "too old" });
	replies = [{ status: 200, body: '{"partialSuccess":{"rejectedDataPoints":2}}' }];
	const m = await sendOtlp({ endpoint: base, signal: "metrics", body: BODY });
	assert.equal(m.partialSuccess.rejectedDataPoints, 2);
	// A non-OTLP 200 body (Langfuse echoes its job) is still a success.
	replies = [{ status: 200, body: "not json" }];
	assert.equal((await sendOtlp({ endpoint: base, signal: "traces", body: BODY })).ok, true);
});

test("timeout: the request is aborted, retried, then reported", async () => {
	let calls = 0;
	const fetchImpl = (url, init) =>
		new Promise((_, reject) => {
			calls++;
			init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
		});
	const { sleep } = fakeSleep();
	const r = await sendOtlp({ endpoint: base, signal: "traces", body: BODY, timeoutMs: 20, maxAttempts: 2, fetchImpl, sleep });
	assert.equal(r.ok, false);
	assert.equal(r.status, null);
	assert.equal(r.attempts, 2);
	assert.equal(calls, 2);
	assert.match(r.error, /timeout after 20ms/);
});

test("network errors are retried and then succeed", async () => {
	let calls = 0;
	const fetchImpl = async () => {
		if (++calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		return new Response('{"partialSuccess":{}}', { status: 200 });
	};
	const { sleep, delays } = fakeSleep();
	const r = await sendOtlp({ endpoint: base, signal: "traces", body: BODY, fetchImpl, sleep });
	assert.equal(r.ok, true);
	assert.equal(r.attempts, 2);
	assert.equal(delays.length, 1);
	const refused = await sendOtlp({ endpoint: "http://127.0.0.1:1", signal: "traces", body: BODY, maxAttempts: 1 });
	assert.equal(refused.ok, false);
	assert.match(refused.error, /^network error/);
});

test("error text never contains header values or the body", async () => {
	const headers = { Authorization: SECRET, "x-api-key": "key-that-must-not-leak" };
	const failures = [];
	replies = [{ status: 500, body: `{"echo":"${SECRET}"}` }];
	failures.push(await sendOtlp({ endpoint: base, signal: "traces", body: BODY, headers }));
	replies = [{ status: 503 }];
	failures.push(await sendOtlp({ endpoint: base, signal: "traces", body: BODY, headers, maxAttempts: 2, sleep: async () => {} }));
	const throwing = async () => {
		throw new Error(`connect failed with ${SECRET}`);
	};
	failures.push(await sendOtlp({ endpoint: base, signal: "traces", body: BODY, headers, maxAttempts: 1, fetchImpl: throwing }));
	for (const r of failures) {
		assert.equal(r.ok, false);
		const text = JSON.stringify(r);
		assert.ok(!text.includes("TOKEN-that-must-not-leak"));
		assert.ok(!text.includes("key-that-must-not-leak"));
		assert.ok(!text.includes("spans"));
	}
});

test("bad arguments return a result instead of throwing", async () => {
	assert.equal((await sendOtlp({ endpoint: base, signal: "logs", body: BODY })).ok, false);
	assert.equal((await sendOtlp({ signal: "traces", body: BODY })).attempts, 0);
	assert.equal((await sendOtlp({ endpoint: "not a url", signal: "traces", body: BODY })).ok, false);
	assert.equal((await sendOtlp()).ok, false);
});
