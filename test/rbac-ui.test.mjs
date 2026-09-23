import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("role editor groups catalog by Server and Client with select-all", () => {
	const source = read("../ui/src/components/UsersPanel.tsx");
	assert.match(source, /resolvePermissionCatalog/);
	assert.match(source, /label: "Server"/);
	assert.match(source, /label: "Client"/);
	assert.match(source, /Select all/);
	assert.doesNotMatch(source, /catalogPermissionEntries/);
});

test("remote workflow actions are independently gated", () => {
	const app = read("../ui/src/App.tsx");
	assert.match(app, /activity\.read/);
	assert.match(app, /users\.manage/);
	assert.match(app, /client\.read/);
	assert.match(app, /devices\.manage/);
	assert.match(app, /client\.workflows\.create/);
	assert.match(app, /client\.workflows\.steps\.add/);
	assert.match(app, /client\.workflows\.steps\.edit/);
	assert.match(app, /client\.workflows\.execute/);
	assert.doesNotMatch(app, /remote\.templates\.manage/);
	assert.doesNotMatch(app, /"remote\.(read|workflows|templates|tcp-tools|rci)/);

	const workflows = read("../ui/src/components/RemoteWorkflowsPanel.tsx");
	assert.match(workflows, /permissions\.create/);
	assert.match(workflows, /permissions\.addStep/);
	assert.match(workflows, /permissions\.editStep/);
	assert.match(workflows, /permissions\.execute/);
	assert.match(workflows, /permissions\.manage/);
	assert.match(workflows, /Create remote workflow/);
	assert.match(workflows, /\+ Add step/);
	assert.match(workflows, /Start from template/);
	assert.match(workflows, /No template — start empty/);
	assert.match(workflows, /Append a template's steps/);
	assert.match(workflows, /appendRemoteTemplate/);
	assert.match(workflows, /setRemoteWorkflowTcps/);
	assert.match(workflows, /setRemoteWorkflowResourceSets/);
	assert.match(workflows, /<h4>TCP<\/h4>/);
	assert.match(workflows, /<h4>RCI<\/h4>/);
	assert.match(app, /templatesRead: can\("templates\.read"\)/);
	assert.match(app, /tcpRead: can\("tcp-tools\.read"\)/);
	assert.match(app, /rciRead: can\("rci\.read"\)/);
});

test("Agent Resources tab is gated on server catalog read permissions", () => {
	const app = read("../ui/src/App.tsx");
	assert.match(app, /type DashboardTab = "activity" \| "users" \| "remote" \| "library"/);
	assert.match(app, /templates\.read/);
	assert.match(app, /tcp-tools\.read/);
	assert.match(app, /rci\.read/);
	assert.match(app, /canLibrary/);
	assert.match(app, /setTab\("library"\)/);
	assert.match(app, /<LibraryPanel user=\{user\} \/>/);
	assert.match(app, /\{canLibrary \? <button/);
	assert.match(app, />\s*Agent Resources\s*</);
	assert.match(app, /page-title">Agent Resources</);
	assert.doesNotMatch(app, />Library</);
	const panel = read("../ui/src/components/LibraryPanel.tsx");
	assert.match(panel, /<h2>Agent Resources<\/h2>/);
	assert.match(panel, /aria-label="Agent Resources catalogs"/);
	assert.match(panel, />\s*Templates\s*</);
	assert.match(panel, />\s*TCP tools\s*</);
	assert.match(panel, />\s*RCI\s*</);
	assert.doesNotMatch(panel, />Library</);
});

test("remote resources expose independent create/edit/delete/import/export actions", () => {
	const source = read("../ui/src/components/RemoteResourcesPanel.tsx");
	assert.match(source, /exportRemoteResources/);
	assert.match(source, /importRemoteResources/);
	assert.match(source, /actions\.create/);
	assert.match(source, /actions\.edit/);
	assert.match(source, /actions\.delete/);
	assert.match(source, /actions\.import/);
	assert.match(source, /actions\.export/);
	assert.match(source, />Import</);
	assert.match(source, />Export</);
	assert.doesNotMatch(source, /canManageTemplates/);
});
