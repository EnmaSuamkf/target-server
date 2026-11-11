/**
 * Conformance: the server validator (pipeline-yaml.mjs, a port of the hub's
 * hub/pipeline-yaml.ts) must reproduce every case of the shared fixture file
 * exactly. The hub runs the same fixture (hub/pipeline-conformance.test.ts).
 * Both copies must stay byte-identical; the last test checks that when the
 * sibling hub repo is present.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parsePipeline } from "../pipeline-yaml.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/pipeline-conformance.json");
const SIBLING_FIXTURE = resolve(here, "../../target/hub/fixtures/pipeline-conformance.json");

const cases = JSON.parse(readFileSync(FIXTURE, "utf8"));

test("the fixture has at least 25 cases, with unique names", () => {
	assert.ok(cases.length >= 25, `only ${cases.length} cases`);
	assert.equal(new Set(cases.map((c) => c.name)).size, cases.length);
});

for (const c of cases) {
	test(`conformance: ${c.name}`, () => {
		const result = parsePipeline(c.source);
		assert.equal(result.ok, c.ok);
		assert.deepEqual(result.ok ? [] : result.errors, c.errors);
	});
}

test("the fixture copy in target is byte-identical (skipped if the sibling repo is absent)", (t) => {
	if (!existsSync(SIBLING_FIXTURE)) {
		t.skip(`sibling repo not found at ${SIBLING_FIXTURE}`);
		return;
	}
	assert.equal(readFileSync(FIXTURE, "utf8"), readFileSync(SIBLING_FIXTURE, "utf8"));
});
