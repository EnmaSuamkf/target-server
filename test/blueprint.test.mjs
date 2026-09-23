import assert from "node:assert/strict";
import test from "node:test";
import { BLUEPRINTS, validate, validateCommand } from "../blueprint.mjs";

test("blueprint normalises email", () => {
	const r = validate("auth.login", { email: "  ADMIN@Example.COM ", password: "x" });
	assert.equal(r.ok, true);
	assert.equal(r.value.email, "admin@example.com");
});

test("blueprint rejects bad emails and localhost", () => {
	for (const email of ["not-an-email", "a@b", "user@localhost", "a@.com"]) {
		const r = validate("user.create", { email });
		assert.equal(r.ok, false);
		assert.ok(r.errors.some((e) => e.field === "email"));
	}
});

test("blueprint password min length", () => {
	const r = validate("auth.setup", { token: "a".repeat(64), password: "short" });
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => e.code === "string.min"));
});

test("blueprint stripUnknown drops injected role", () => {
	const r = validate("user.create", { email: "someone@example.com", role: "superadmin" });
	assert.equal(r.ok, true);
	assert.equal(r.value.role, undefined);
});

test("user.create activation requires at least one method", () => {
	const r = validate("user.create", {
		email: "someone@example.com",
		activation: { password: false, google: false },
	});
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => e.field === "activation"));
});

test("user.create activation accepts password only", () => {
	const r = validate("user.create", {
		email: "someone@example.com",
		activation: { password: true },
	});
	assert.equal(r.ok, true);
	assert.equal(r.value.activation.password, true);
	assert.equal(r.value.activation.google, false);
});

test("blueprint error shape", () => {
	const r = validate("user.create", { email: "bad" });
	assert.equal(r.ok, false);
	for (const e of r.errors) {
		assert.match(e.field, /.+/);
		assert.match(e.code, /.+/);
		assert.match(e.message, /.+/);
	}
});

test("sync route blueprints exist", () => {
	for (const name of ["sync.register", "sync.heartbeat", "sync.command_ack", "sync.events"]) {
		assert.ok(name in BLUEPRINTS, name);
	}
});

test("command payload: workflow.create requires name", () => {
	const ok = validateCommand("workflow.create", { name: "Demo", workdir: "/tmp" });
	assert.equal(ok.ok, true);
	const bad = validateCommand("workflow.create", { workdir: "/tmp" });
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.some((e) => e.field === "name"));
});

test("command payload: step.add requires step_key and description", () => {
	const ok = validateCommand("step.add", { step_key: "s1", description: "Do work" });
	assert.equal(ok.ok, true);
	const bad = validateCommand("step.add", { step_key: "s1" });
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.some((e) => e.field === "description"));
});

test("command payload: step.add accepts optional notes", () => {
	const ok = validateCommand("step.add", {
		step_key: "s1",
		description: "Do work",
		notes: [{ id: "n1", content: "Check logs", theme: "warning" }],
	});
	assert.equal(ok.ok, true);
	assert.deepEqual(ok.value.notes, [{ id: "n1", content: "Check logs", theme: "warning" }]);
	const badTheme = validateCommand("step.add", {
		step_key: "s1",
		description: "Do work",
		notes: [{ content: "x", theme: "urgent" }],
	});
	assert.equal(badTheme.ok, false);
});

test("remote workflow create accepts optional template_id", () => {
	const ok = validate("sync.remote_workflow.create", {
		client_id: "cli-1",
		name: "From template",
		template_id: "tpl-1",
	});
	assert.equal(ok.ok, true);
	assert.equal(ok.value.template_id, "tpl-1");
});

test("steps from template requires template_id", () => {
	const ok = validate("sync.remote_workflow.steps_from_template", { template_id: "tpl-1" });
	assert.equal(ok.ok, true);
	const bad = validate("sync.remote_workflow.steps_from_template", {});
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.some((e) => e.field === "template_id"));
});

test("remote workflow selection payloads accept arrays", () => {
	const tcps = validate("sync.remote_workflow.set_tcps", {
		tcp_selections: [{ tcpId: "tcp-1", toolNames: ["status"] }],
	});
	assert.equal(tcps.ok, true);
	const resources = validate("sync.remote_workflow.set_resource_sets", {
		resource_selections: [{ resourceSetId: "rci-1" }],
	});
	assert.equal(resources.ok, true);
	const command = validateCommand("workflow.set_selection", {
		tcp_selections: [{ tcpId: "tcp-1" }],
		resource_selections: [{ resourceSetId: "rci-1" }],
	});
	assert.equal(command.ok, true);
});

test("command payload: workflow.start accepts empty payload", () => {
	const r = validateCommand("workflow.start", {});
	assert.equal(r.ok, true);
});

test("command payload: workflow.start accepts step_keys", () => {
	const r = validateCommand("workflow.start", { step_keys: ["step-1", "step-2"] });
	assert.equal(r.ok, true);
	assert.deepEqual(r.value.step_keys, ["step-1", "step-2"]);
});

test("resource import bundle requires at least one resource", () => {
	const ok = validate("sync.resource.import", {
		contract_version: "sync/v2",
		domain: "templates",
		resources: [{ id: "t1", name: "Audit", data: { steps: [] } }],
	});
	assert.equal(ok.ok, true);
	assert.equal(ok.value.resources[0].id, "t1");
	const bad = validate("sync.resource.import", { resources: [] });
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.some((e) => e.field === "resources"));
});

test("enqueue_command request keeps step_keys in payload", () => {
	const r = validate("sync.remote_workflow.enqueue_command", {
		type: "workflow.restart",
		payload: { step_keys: ["step-2"] },
	});
	assert.equal(r.ok, true);
	assert.deepEqual(r.value.payload.step_keys, ["step-2"]);
});

test("unknown command type returns field error on type", () => {
	const r = validateCommand("workflow.nope", {});
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => e.field === "type" && e.code === "unknown_command_type"));
});

test("sync heartbeat rejects invalid status with field errors", () => {
	const r = validate("sync.heartbeat", { status: "away" });
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => e.field === "status"));
});
