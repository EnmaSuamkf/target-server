import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PERMISSIONS } from "../db.mjs";

test("role editor exposes every closed backend permission with readable device labels", () => {
	const source = fs.readFileSync(new URL("../ui/src/api/permissions.ts", import.meta.url), "utf8");
	const ids = [...source.matchAll(/id:\s*"([^"]+)"/g)].map((match) => match[1]);
	assert.deepEqual(ids.sort(), [...PERMISSIONS].sort());
	assert.match(source, /Approve or deny device-link requests/);
	assert.match(source, /Manage linked devices/);
});
