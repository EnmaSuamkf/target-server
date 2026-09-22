import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { getPermissionCatalog, PERMISSION_CATALOG, PERMISSIONS } from "../db.mjs";

const REMOVED_RESOURCE_MANAGE = ["remote.templates.manage", "remote.tcp-tools.manage", "remote.rci.manage"];

test("every catalogue entry carries a closed id, scope and group", () => {
	assert.equal(PERMISSION_CATALOG.length, PERMISSIONS.length);
	for (const entry of PERMISSION_CATALOG) {
		assert.equal(typeof entry.id, "string");
		assert.equal(typeof entry.description, "string");
		assert.equal(typeof entry.label, "string");
		assert.ok(entry.scope === "server" || entry.scope === "client");
		assert.equal(typeof entry.group, "string");
		assert.ok(entry.group.startsWith(`${entry.scope}.`));
	}
	assert.ok(PERMISSIONS.includes("remote.workflows.manage"));
	assert.ok(PERMISSIONS.includes("remote.workflows.create"));
	assert.ok(PERMISSIONS.includes("remote.workflows.steps.add"));
	assert.ok(PERMISSIONS.includes("remote.workflows.steps.edit"));
	assert.ok(PERMISSIONS.includes("remote.templates.create"));
	assert.ok(PERMISSIONS.includes("remote.tcp-tools.export"));
	assert.ok(PERMISSIONS.includes("remote.rci.import"));
	for (const removed of REMOVED_RESOURCE_MANAGE) {
		assert.equal(PERMISSIONS.includes(removed), false);
	}
});

test("getPermissionCatalog groups the closed vocabulary by server and client scope", () => {
	const catalog = getPermissionCatalog();
	const groupIds = catalog.groups.map((group) => group.id);
	assert.deepEqual(groupIds, [
		"server.activity",
		"server.users",
		"server.devices",
		"client.remote",
		"client.workflows",
		"client.templates",
		"client.tcp",
		"client.rci",
	]);
	for (const group of catalog.groups) {
		assert.ok(group.scope === "server" || group.scope === "client");
		assert.ok(group.permissions.length > 0);
		for (const permission of group.permissions) {
			const entry = PERMISSION_CATALOG.find((item) => item.id === permission.id);
			assert.equal(entry.group, group.id);
			assert.equal(entry.scope, group.scope);
			assert.equal(permission.label, entry.label);
			assert.equal(permission.description, entry.description);
		}
	}
	assert.deepEqual(
		catalog.groups.flatMap((group) => group.permissions.map((permission) => permission.id)).sort(),
		[...PERMISSIONS].sort(),
	);
});

test("role editor exposes every closed backend permission with readable device labels", () => {
	const source = fs.readFileSync(new URL("../ui/src/api/permissions.ts", import.meta.url), "utf8");
	const ids = [...source.matchAll(/id:\s*"([^"]+)"/g)].map((match) => match[1]);
	assert.deepEqual(ids.sort(), [...PERMISSIONS].sort());
	assert.match(source, /Approve or deny device-link requests/);
	assert.match(source, /Manage linked devices/);
});
