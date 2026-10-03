/**
 * OTLP encoding helpers: deterministic ids and AnyValue encoding.
 * Pure functions, so no server is started.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	anyValue,
	attr,
	attrs,
	resourceBlock,
	scopeBlock,
	sessionSpanId,
	spanIdFor,
	stepSpanId,
	toUnixNano,
	traceIdFor,
} from "../otel.mjs";

test("trace ids are stable lowercase hex of 32 chars", () => {
	const id = traceIdFor("wf-1");
	assert.equal(id, traceIdFor("wf-1"));
	assert.match(id, /^[0-9a-f]{32}$/);
	assert.equal(id, createHash("sha256").update("target:trace:wf-1").digest("hex").slice(0, 32));
});

test("different workflows get different trace ids", () => {
	assert.notEqual(traceIdFor("wf-1"), traceIdFor("wf-2"));
});

test("span ids are stable lowercase hex of 16 chars", () => {
	const id = spanIdFor("wf-1");
	assert.equal(id, spanIdFor("wf-1"));
	assert.match(id, /^[0-9a-f]{16}$/);
	assert.equal(id, createHash("sha256").update("target:span:wf-1").digest("hex").slice(0, 16));
});

test("step and session span ids use the documented keys and differ per attempt", () => {
	assert.equal(stepSpanId("wf", "s1", 0), spanIdFor("wf:s1:0"));
	assert.notEqual(stepSpanId("wf", "s1", 0), stepSpanId("wf", "s1", 1));
	assert.equal(sessionSpanId("wf", "sess"), spanIdFor("wf:sess"));
	assert.notEqual(sessionSpanId("wf", "sess"), spanIdFor("wf"));
});

test("toUnixNano returns a string and keeps millisecond precision", () => {
	const nano = toUnixNano("2026-10-03T12:34:56.789Z");
	assert.equal(typeof nano, "string");
	assert.equal(nano, `${Date.parse("2026-10-03T12:34:56.789Z")}000000`);
	assert.ok(nano.endsWith("789000000"));
	assert.equal(toUnixNano(1790000000123), "1790000000123000000");
	assert.equal(toUnixNano(new Date(5)), "5000000");
});

test("toUnixNano returns null for unparseable input", () => {
	assert.equal(toUnixNano("not a date"), null);
	assert.equal(toUnixNano(null), null);
	assert.equal(toUnixNano(undefined), null);
});

test("attribute encoding covers every value type", () => {
	assert.deepEqual(attr("a", "text"), { key: "a", value: { stringValue: "text" } });
	assert.deepEqual(attr("a", ""), { key: "a", value: { stringValue: "" } });
	assert.deepEqual(attr("a", 42), { key: "a", value: { intValue: "42" } });
	assert.deepEqual(attr("a", 0), { key: "a", value: { intValue: "0" } });
	assert.deepEqual(attr("a", -7), { key: "a", value: { intValue: "-7" } });
	assert.deepEqual(attr("a", 0.0123), { key: "a", value: { doubleValue: 0.0123 } });
	assert.deepEqual(attr("a", true), { key: "a", value: { boolValue: true } });
	assert.deepEqual(attr("a", false), { key: "a", value: { boolValue: false } });
});

test("large integers stay exact as strings", () => {
	assert.deepEqual(anyValue(Number.MAX_SAFE_INTEGER), { intValue: "9007199254740991" });
	assert.deepEqual(anyValue(9007199254740993n), { intValue: "9007199254740993" });
	assert.deepEqual(anyValue(1790000000000000000n), { intValue: "1790000000000000000" });
	assert.equal(typeof anyValue(16015192).intValue, "string");
});

test("null, undefined, non-finite numbers and objects are skipped", () => {
	assert.equal(attr("a", null), null);
	assert.equal(attr("a", undefined), null);
	assert.equal(attr("a", Number.NaN), null);
	assert.equal(attr("a", Number.POSITIVE_INFINITY), null);
	assert.equal(attr("a", { nested: 1 }), null);
	assert.deepEqual(
		attrs({ keep: "x", gone: null, alsoGone: undefined, zero: 0, flag: false }),
		[
			{ key: "keep", value: { stringValue: "x" } },
			{ key: "zero", value: { intValue: "0" } },
			{ key: "flag", value: { boolValue: false } },
		],
	);
	assert.deepEqual(attrs(null), []);
});

test("resource and scope blocks", () => {
	assert.deepEqual(resourceBlock({ org: "demo", serviceVersion: "0.1.0" }), {
		attributes: [
			{ key: "service.name", value: { stringValue: "target-server" } },
			{ key: "service.version", value: { stringValue: "0.1.0" } },
			{ key: "target.org", value: { stringValue: "demo" } },
		],
	});
	// Missing org / version are left out rather than sent as empty values.
	assert.deepEqual(resourceBlock().attributes.map((a) => a.key), ["service.name"]);
	assert.deepEqual(scopeBlock({ serviceVersion: "0.1.0" }), { name: "target-server.otel", version: "0.1.0" });
	assert.deepEqual(scopeBlock(), { name: "target-server.otel" });
});
