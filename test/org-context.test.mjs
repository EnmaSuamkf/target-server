import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-org-context-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;

const { countAuthUsers, currentOrgId, DEFAULT_ORG_ID, open, runWithOrg } = await import("../db.mjs");

test("db queries throw outside org context and succeed inside runWithOrg", () => {
	assert.equal(currentOrgId(), null);
	assert.throws(() => countAuthUsers(), /org_context_missing/);
	assert.throws(() => open(), /org_context_missing/);
	const n = runWithOrg(DEFAULT_ORG_ID, () => {
		assert.equal(currentOrgId(), DEFAULT_ORG_ID);
		return countAuthUsers();
	});
	assert.equal(n, 1);
	assert.equal(currentOrgId(), null);
});
