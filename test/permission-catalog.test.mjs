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
	assert.ok(PERMISSIONS.includes("activity.read"));
	assert.ok(PERMISSIONS.includes("activity.read.own"));
	const viewAll = PERMISSION_CATALOG.find((item) => item.id === "activity.read");
	assert.equal(viewAll.label, "View all activity");
	assert.equal(viewAll.description, "View Activity and reporting data from every hub");
	assert.equal(viewAll.scope, "server");
	assert.equal(viewAll.group, "server.activity");
	const viewOwn = PERMISSION_CATALOG.find((item) => item.id === "activity.read.own");
	assert.equal(viewOwn.label, "View own activity");
	assert.equal(viewOwn.description, "View Activity and reporting data from your own linked hubs");
	assert.equal(viewOwn.scope, "server");
	assert.equal(viewOwn.group, "server.activity");
	assert.ok(PERMISSIONS.includes("client.read"));
	assert.ok(PERMISSIONS.includes("client.workflows.manage"));
	assert.ok(PERMISSIONS.includes("client.workflows.create"));
	assert.ok(PERMISSIONS.includes("client.workflows.steps.add"));
	assert.ok(PERMISSIONS.includes("client.workflows.steps.edit"));
	assert.ok(PERMISSIONS.includes("client.templates.create"));
	assert.ok(PERMISSIONS.includes("client.templates.sync"));
	assert.ok(PERMISSIONS.includes("client.tcp-tools.export"));
	assert.ok(PERMISSIONS.includes("client.tcp-tools.sync"));
	assert.ok(PERMISSIONS.includes("client.rci.import"));
	assert.ok(PERMISSIONS.includes("client.rci.sync"));
	const serverCatalogIds = [
		"templates.read",
		"templates.create",
		"templates.edit",
		"templates.delete",
		"templates.import",
		"templates.export",
		"tcp-tools.read",
		"tcp-tools.create",
		"tcp-tools.edit",
		"tcp-tools.delete",
		"tcp-tools.import",
		"tcp-tools.export",
		"rci.read",
		"rci.create",
		"rci.edit",
		"rci.delete",
		"rci.import",
		"rci.export",
	];
	for (const id of serverCatalogIds) {
		assert.ok(PERMISSIONS.includes(id), `missing ${id}`);
		const entry = PERMISSION_CATALOG.find((item) => item.id === id);
		assert.equal(entry.scope, "server");
		assert.ok(entry.group === "server.templates" || entry.group === "server.tcp" || entry.group === "server.rci");
	}
	for (const id of ["pricing.read", "pricing.edit", "pricing.import", "pricing.export"]) {
		const entry = PERMISSION_CATALOG.find((item) => item.id === id);
		assert.ok(entry, `missing ${id}`);
		assert.equal(entry.scope, "server");
		assert.equal(entry.group, "server.pricing");
	}
	for (const removed of REMOVED_RESOURCE_MANAGE) {
		assert.equal(PERMISSIONS.includes(removed), false);
	}
	for (const entry of PERMISSION_CATALOG.filter(({ scope }) => scope === "client")) {
		assert.ok(entry.id.startsWith("client."), `client permission ${entry.id} must use the client. prefix`);
	}
	assert.equal(PERMISSIONS.some((id) => id.startsWith("remote.")), false);
});

test("getPermissionCatalog groups the closed vocabulary by server and client scope", () => {
	const catalog = getPermissionCatalog();
	const groupIds = catalog.groups.map((group) => group.id);
	assert.deepEqual(groupIds, [
		"server.activity",
		"server.users",
		"server.devices",
		"server.templates",
		"server.tcp",
		"server.rci",
		"server.pricing",
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
	const activity = catalog.groups.find((group) => group.id === "server.activity");
	assert.equal(activity.label, "Activity");
	assert.equal(activity.permissions.find((permission) => permission.id === "activity.read").label, "View all activity");
	assert.equal(activity.permissions.find((permission) => permission.id === "activity.read.own").label, "View own activity");
	const clients = catalog.groups.find((group) => group.id === "client.remote");
	assert.equal(clients.label, "Clients");
	assert.equal(clients.permissions.find((permission) => permission.id === "client.read").label, "View clients");
	assert.deepEqual(
		catalog.groups.flatMap((group) => group.permissions.map((permission) => permission.id)).sort(),
		[...PERMISSIONS].sort(),
	);
});

test("role editor exposes every closed backend permission with readable device labels", () => {
	const source = fs.readFileSync(new URL("../ui/src/api/permissions.ts", import.meta.url), "utf8");
	const ids = [...source.matchAll(/id:\s*"([^"]+)"/g)].map((match) => match[1]);
	assert.deepEqual(ids.sort(), [...PERMISSIONS].sort());
	assert.match(source, /View all activity/);
	assert.match(source, /activity\.read\.own/);
	assert.match(source, /Approve or deny device-link requests/);
	assert.match(source, /Manage linked devices/);
	assert.match(source, /client\.templates\.sync/);
	assert.match(source, /client\.tcp-tools\.sync/);
	assert.match(source, /client\.rci\.sync/);
});

const CATALOG_SYNC_PERMISSIONS = [
	{
		id: "client.templates.sync",
		group: "client.templates",
		label: "Sync templates",
		description: "Pull server catalog templates onto a linked hub",
	},
	{
		id: "client.tcp-tools.sync",
		group: "client.tcp",
		label: "Sync TCP tools",
		description: "Pull server catalog TCP tools onto a linked hub",
	},
	{
		id: "client.rci.sync",
		group: "client.rci",
		label: "Sync RCI resources",
		description: "Pull server catalog RCI resources onto a linked hub",
	},
];

test("catalog includes client sync permissions in the matching resource groups", () => {
	const catalog = getPermissionCatalog();
	for (const expected of CATALOG_SYNC_PERMISSIONS) {
		const entry = PERMISSION_CATALOG.find((item) => item.id === expected.id);
		assert.ok(entry, `missing ${expected.id}`);
		assert.equal(entry.scope, "client");
		assert.equal(entry.group, expected.group);
		assert.equal(entry.label, expected.label);
		assert.equal(entry.description, expected.description);
		const group = catalog.groups.find((item) => item.id === expected.group);
		assert.ok(group, `missing group ${expected.group}`);
		assert.equal(group.scope, "client");
		const listed = group.permissions.find((permission) => permission.id === expected.id);
		assert.ok(listed, `${expected.id} missing from ${expected.group}`);
		assert.equal(listed.label, expected.label);
		assert.equal(listed.description, expected.description);
	}
});
