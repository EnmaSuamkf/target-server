import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("CollapsibleSection is accessible, persists safely and keeps actions out of the toggle", () => {
	const source = read("../ui/src/components/CollapsibleSection.tsx");
	assert.match(source, /export function CollapsibleSection/);
	assert.match(source, /aria-expanded=\{open\}/);
	assert.match(source, /aria-controls=\{bodyId\}/);
	assert.match(source, /localStorage\.getItem/);
	assert.match(source, /localStorage\.setItem/);
	assert.equal((source.match(/\btry \{/g) ?? []).length, 2);
	assert.match(source, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
});

test("the remote workflow detail wraps its sections and no longer says Live sync events", () => {
	const source = read("../ui/src/components/RemoteWorkflowsPanel.tsx");
	for (const id of ["append-template", "schedule", "tcp", "rci", "context", "client-activity", "recent-events"]) {
		assert.match(source, new RegExp(`id="${id}"`), id);
	}
	assert.match(source, /title="Recent events"/);
	assert.doesNotMatch(source, /Live sync events/);
});
