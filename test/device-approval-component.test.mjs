import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("device approval page reuses TargetMark and declares every accessible link state", () => {
	const source = fs.readFileSync(new URL("../ui/src/components/DeviceApprovalPage.tsx", import.meta.url), "utf8");
	assert.match(source, /import \{ TargetMark \}/);
	assert.match(source, /<TargetMark \/>/);
	for (const state of ["working", "approved", "denied", "error"]) assert.match(source, new RegExp(`state === "${state}"`));
	assert.match(source, /aria-live="polite"/);
	assert.match(source, /Approve device/);
	assert.match(source, /Deny/);
	assert.doesNotMatch(source, /polling_credential|device_secret|Authorization/);
});
