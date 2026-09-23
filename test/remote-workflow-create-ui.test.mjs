import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("Field wraps a labelled control with hint, error and aria-invalid", () => {
	const source = read("../ui/src/components/Field.tsx");
	assert.match(source, /export function Field/);
	assert.match(source, /<label className="label" htmlFor=\{id\}>/);
	assert.match(source, /field-required/);
	assert.match(source, /aria-describedby/);
	assert.match(source, /"aria-invalid"/);
	assert.match(source, /className="hint"/);
	assert.match(source, /className="msg msg--error"/);
	assert.match(source, /role="alert"/);
	assert.doesNotMatch(source, /Field\.module\.css/);
});

test("Modal is a titled dialog with Escape, focus trap and backdrop dismiss", () => {
	const source = read("../ui/src/components/Modal.tsx");
	assert.match(source, /export function Modal/);
	assert.match(source, /role="dialog"/);
	assert.match(source, /aria-modal="true"/);
	assert.match(source, /aria-labelledby/);
	assert.match(source, /ev\.key === "Escape"/);
	assert.match(source, /ev\.key !== "Tab"/);
	assert.match(source, /modal-backdrop/);
	assert.match(source, /aria-label="Close dialog"/);
	assert.doesNotMatch(source, /Modal\.module\.css/);
});

test("remote workflow create is a labelled modal, not a cramped always-on row", () => {
	const source = read("../ui/src/components/RemoteWorkflowsPanel.tsx");
	assert.match(source, /import \{ Field \} from "\.\/Field\.tsx"/);
	assert.match(source, /import \{ Modal \} from "\.\/Modal\.tsx"/);
	assert.match(source, /\+ New remote workflow/);
	assert.match(source, /title="New remote workflow"/);
	assert.match(source, /<legend>Where it runs<\/legend>/);
	assert.match(source, /<legend>What it does<\/legend>/);
	assert.match(source, /label="Client"/);
	assert.match(source, /label="Agent"/);
	assert.match(source, /label="Name"/);
	assert.match(source, /label="Start from template"/);
	assert.match(source, /label="Conversation context"/);
	assert.match(source, /placeholder="e\.g\. release-notes"/);
	assert.doesNotMatch(source, /placeholder="Workflow name"/);
	assert.doesNotMatch(source, /sync-create--stacked/);
	assert.match(source, /fieldErrors\(errors, "client_id"\)/);
	assert.match(source, /fieldErrors\(errors, "name"\)/);
	assert.match(source, /fieldErrors\(errors, "agent"\)/);
	assert.match(source, /fieldErrors\(errors, "template_id"\)/);
	assert.match(source, /fieldErrors\(errors, "_"\)/);
	assert.match(source, /Pick a client first/);
	assert.match(source, /Waiting for the client to report installed agents \(next heartbeat\)/);
	assert.match(source, /always run in the <strong>docker<\/strong> sandbox/);
	assert.match(source, /only installed CLIs are selectable/);
	assert.match(source, /Create remote workflow/);
});

test("create, template-read and add-step gates stay on the remote workflow panel", () => {
	const source = read("../ui/src/components/RemoteWorkflowsPanel.tsx");
	assert.match(source, /permissions\.create/);
	assert.match(source, /permissions\.templatesRead/);
	assert.match(source, /permissions\.addStep/);
	assert.match(source, /permissions\.manage/);
	assert.match(source, /permissions\.execute/);
	assert.match(source, /\+ Add step/);
	assert.match(source, /label="Append a template's steps"/);
	assert.match(source, /label="Task description"/);
	assert.match(source, /label="Acceptance criteria"/);
	assert.match(source, /label="Manual review"/);
	assert.match(source, /label="Use subagent"/);
	assert.match(source, /label="Max retries"/);
	assert.match(source, /label="Interval \(s\)"/);
});
