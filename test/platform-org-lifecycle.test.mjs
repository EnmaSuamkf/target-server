/**
 * Superuser org lifecycle: disable / enable / delete (archive) and the
 * retired-path guard that stops a deleted org's DB from being re-created.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from "./helpers.mjs";
import { outboxDir } from "../mailer.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-platform-org-lifecycle-"));
process.env.TARGET_SERVER_DB = path.join(tmpDir, "t.db");
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");
process.env.TARGET_MULTI_ORG = "1";
process.env.TARGET_DEVICE_LINKING_MODE = "required";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_PUBLIC_URL = "http://127.0.0.1:8900";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";
process.env.TARGET_SUPERUSER_EMAIL = "lifecycle-su@example.com";
// Many logins in one file: give each request its own client IP so the auth rate limiter stays out of the way.
process.env.TARGET_TRUST_PROXY = "1";

const { server } = await import("../server.mjs");
const control = await import("../control-plane.mjs");
const { runWithOrg, open, retireOrgDbPath, unretireOrgDbPath, isOrgDbPathRetired } = await import("../db.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

let clientSeq = 0;
const json = (method, body, cookie) => ({
	method,
	headers: {
		"content-type": "application/json",
		"x-forwarded-for": `10.0.${Math.floor(++clientSeq / 250)}.${clientSeq % 250}`,
		...(cookie ? { cookie } : {}),
	},
	body: body == null ? undefined : JSON.stringify(body),
});

function mailForEmail(email) {
	return readdirSync(outboxDir())
		.filter((f) => f.endsWith(".eml"))
		.sort()
		.reverse()
		.map((f) => readFileSync(path.join(outboxDir(), f), "utf8"))
		.filter((t) => t.includes(email));
}

function setupTokenFromMail(email) {
	for (const text of mailForEmail(email)) {
		const m = text.match(/\/setup\?token=([A-Fa-f0-9]+)/);
		if (m) return m[1];
	}
	return null;
}

function cookieFrom(res) {
	return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function login(email = DEFAULT_ADMIN_EMAIL, password = DEFAULT_ADMIN_PASSWORD) {
	const res = await fetch(`${base}/api/auth/login`, json("POST", { email, password }));
	assert.equal(res.status, 200, `login ${email}: ${res.status}`);
	return cookieFrom(res);
}

let suCookie;
async function su() {
	if (suCookie) return suCookie;
	const token = setupTokenFromMail("lifecycle-su@example.com");
	assert.ok(token, "superuser setup token missing from mail");
	const setup = await fetch(`${base}/api/auth/setup`, json("POST", { token, password: "super-password-12" }));
	if (setup.status === 409) {
		suCookie = await login("lifecycle-su@example.com", "super-password-12");
	} else {
		assert.equal(setup.status, 200, await setup.text());
		suCookie = cookieFrom(setup);
	}
	return suCookie;
}

async function createOrg(slug, adminEmail, name = slug) {
	const res = await fetch(`${base}/api/platform/orgs`, json("POST", { name, slug, admin_email: adminEmail }, await su()));
	const body = await res.json();
	assert.equal(res.status, 201, JSON.stringify(body));
	return body.org;
}

/** Create an org and activate its admin via the mailed setup link; returns the admin's cookie. */
async function createActiveOrg(slug, adminEmail, password) {
	const org = await createOrg(slug, adminEmail);
	const token = setupTokenFromMail(adminEmail);
	assert.ok(token, `setup token for ${adminEmail} missing`);
	const setup = await fetch(`${base}/api/auth/setup`, json("POST", { token, password }));
	assert.equal(setup.status, 200, await setup.text());
	return { org, cookie: cookieFrom(setup) };
}

function patchStatus(orgId, status, cookie) {
	return fetch(`${base}/api/platform/orgs/${orgId}`, json("PATCH", { status }, cookie));
}

function deleteOrg(orgId, confirmSlug, cookie) {
	return fetch(`${base}/api/platform/orgs/${orgId}`, json("DELETE", confirmSlug === undefined ? {} : { confirm_slug: confirmSlug }, cookie));
}

function countRows(table, orgId) {
	return control.openControlDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`).get(orgId).n;
}

test("non-superuser gets 403 on PATCH and DELETE", async () => {
	const { org, cookie } = await createActiveOrg("lc-forbidden", "admin@lc-forbidden.example.com", "admin-password-12");
	assert.equal((await patchStatus(org.id, "disabled", cookie)).status, 403);
	assert.equal((await deleteOrg(org.id, org.slug, cookie)).status, 403);
	const seeded = await login();
	assert.equal((await patchStatus(org.id, "disabled", seeded)).status, 403);
	assert.equal((await deleteOrg(org.id, org.slug, seeded)).status, 403);
	assert.equal(control.getOrganization(org.id).status, "active");
});

test("default org is protected (409); unknown id 404; bad bodies 422", async () => {
	const cookie = await su();
	const patchDefault = await patchStatus("default", "disabled", cookie);
	assert.equal(patchDefault.status, 409);
	assert.deepEqual(await patchDefault.json(), { error: "default_org_protected" });
	const delDefault = await deleteOrg("default", control.getOrganization("default").slug, cookie);
	assert.equal(delDefault.status, 409);
	assert.deepEqual(await delDefault.json(), { error: "default_org_protected" });
	assert.equal(control.getOrganization("default").status, "active");

	assert.equal((await patchStatus("no-such-org", "disabled", cookie)).status, 404);
	assert.equal((await deleteOrg("no-such-org", "x", cookie)).status, 404);

	const org = await createOrg("lc-validate", "admin@lc-validate.example.com");
	assert.equal((await patchStatus(org.id, "archived", cookie)).status, 422);

	const wrong = await deleteOrg(org.id, "not-the-slug", cookie);
	assert.equal(wrong.status, 422);
	const wrongBody = await wrong.json();
	assert.ok(wrongBody.errors.some((e) => e.field === "confirm_slug" && e.code === "confirm_slug_mismatch"), JSON.stringify(wrongBody));

	const missing = await deleteOrg(org.id, undefined, cookie);
	assert.equal(missing.status, 422);
	assert.ok((await missing.json()).errors.some((e) => e.field === "confirm_slug"));

	const bodyless = await fetch(`${base}/api/platform/orgs/${org.id}`, { method: "DELETE", headers: { cookie } });
	assert.equal(bodyless.status, 422);
	assert.ok(control.getOrganization(org.id), "rejected deletes must not remove the org");
});

test("disable blocks the org admin; superuser still lists it; enable restores access", async () => {
	const cookie = await su();
	const password = "admin-password-12";
	const email = "admin@lc-disable.example.com";
	const { org, cookie: adminCookie } = await createActiveOrg("lc-disable", email, password);
	assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie: adminCookie } })).status, 200);

	const disabled = await patchStatus(org.id, "disabled", cookie);
	assert.equal(disabled.status, 200);
	const disabledBody = await disabled.json();
	assert.equal(disabledBody.org.id, org.id);
	assert.equal(disabledBody.org.status, "disabled");

	const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: adminCookie } });
	assert.equal(me.status, 403);
	assert.deepEqual(await me.json(), { error: "org_disabled" });
	const events = await fetch(`${base}/api/events`, { headers: { cookie: adminCookie } });
	assert.equal(events.status, 403);

	const loginRes = await fetch(`${base}/api/auth/login`, json("POST", { email, password }));
	assert.equal(loginRes.status, 403);
	assert.deepEqual(await loginRes.json(), { error: "org_disabled" });
	assert.ok(!(loginRes.headers.get("set-cookie") ?? "").includes("target_auth="));

	const list = await (await fetch(`${base}/api/platform/orgs`, { headers: { cookie } })).json();
	assert.equal(list.orgs.find((o) => o.id === org.id)?.status, "disabled");

	const audit = control
		.openControlDb()
		.prepare("SELECT detail_json FROM platform_audit WHERE action = 'organization.disabled'")
		.all()
		.map((r) => JSON.parse(r.detail_json));
	assert.ok(audit.some((d) => d.id === org.id));

	const enabled = await patchStatus(org.id, "active", cookie);
	assert.equal(enabled.status, 200);
	assert.equal((await enabled.json()).org.status, "active");
	assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie: adminCookie } })).status, 200);
	const relog = await fetch(`${base}/api/auth/login`, json("POST", { email, password }));
	assert.equal(relog.status, 200);
	assert.ok(
		control.openControlDb().prepare("SELECT 1 FROM platform_audit WHERE action = 'organization.enabled'").get(),
	);
});

test("two-org member: a disabled org is not offered and cannot be selected", async () => {
	const cookie = await su();
	const shared = "shared@lc-pick.example.com";
	const password = "shared-password-12";
	const { org: first } = await createActiveOrg("lc-pick-a", shared, password);
	const second = await createOrg("lc-pick-b", shared);

	const both = await (await fetch(`${base}/api/auth/login`, json("POST", { email: shared, password }))).json();
	assert.equal(both.selectOrg, true);
	assert.equal(both.organizations.length, 2);

	assert.equal((await patchStatus(second.id, "disabled", cookie)).status, 200);
	const single = await fetch(`${base}/api/auth/login`, json("POST", { email: shared, password }));
	assert.equal(single.status, 200);
	const singleBody = await single.json();
	assert.equal(singleBody.user.org.id, first.id);
	assert.deepEqual(singleBody.user.organizations.map((o) => o.id), [first.id]);

	const select = await fetch(`${base}/api/auth/select-org`, json("POST", { org_id: second.id }, cookieFrom(single)));
	assert.equal(select.status, 403);
	assert.deepEqual(await select.json(), { error: "org_disabled" });
	assert.equal((await patchStatus(second.id, "active", cookie)).status, 200);
});

test("delete archives files, cascades the control plane and keeps other orgs working", async () => {
	const cookie = await su();
	const password = "admin-password-12";
	const shared = "shared@lc-delete.example.com";

	// Org to delete: active shared admin (also a member of lc-keep), a pending invitee,
	// and seeded device rows.
	const { org } = await createActiveOrg("lc-delete", shared, password);
	const { org: keep } = await createActiveOrg("lc-keep", "admin@lc-keep.example.com", password);
	const invite = await fetch(`${base}/api/auth/users`, json("POST", { email: "pending@lc-delete.example.com", role_id: "admin" }, await login(shared, password)));
	// Shared admin has one membership so far, so login lands in lc-delete and the invite goes there.
	assert.equal(invite.status, 201, await invite.text());
	const pendingToken = setupTokenFromMail("pending@lc-delete.example.com");
	assert.ok(pendingToken);

	const sharedInKeep = await fetch(
		`${base}/api/auth/users`,
		json("POST", { email: shared, role_id: "admin" }, await login("admin@lc-keep.example.com", password)),
	);
	assert.equal(sharedInKeep.status, 201, await sharedInKeep.text());

	const pick = await (await fetch(`${base}/api/auth/login`, json("POST", { email: shared, password }))).json();
	assert.equal(pick.selectOrg, true);
	const selected = await fetch(`${base}/api/auth/select-org`, json("POST", { org_id: org.id, token: pick.selectToken }));
	assert.equal(selected.status, 200, await selected.text());
	const deletedOrgCookie = cookieFrom(selected);
	assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie: deletedOrgCookie } })).status, 200);

	const deviceId = randomUUID();
	control.upsertDeviceDirectory({ deviceId, orgId: org.id });
	const requestId = randomUUID();
	const now = new Date().toISOString();
	control.insertControlLinkRequest({
		id: requestId,
		idempotencyKey: randomUUID(),
		idempotencyFingerprint: "fp",
		deviceName: "hub",
		hubVersion: "1.0",
		publicKey: "pk",
		scopesJson: "[]",
		pollingCredentialHash: randomUUID(),
		createdAt: now,
		expiresAt: new Date(Date.now() + 600_000).toISOString(),
	});
	control.updateControlLinkRequestDecision({ requestId, decision: "approved", ownerUserId: "u", orgId: org.id, decidedAt: now });

	for (const table of ["token_directory", "user_directory", "device_directory", "device_link_requests"]) {
		assert.ok(countRows(table, org.id) > 0, `expected seeded ${table} rows`);
	}
	const dbPath = control.getOrganization(org.id).dbPath;
	assert.equal(fs.existsSync(dbPath), true);

	const res = await deleteOrg(org.id, org.slug, cookie);
	const body = await res.json();
	assert.equal(res.status, 200, JSON.stringify(body));
	assert.equal(body.deleted.id, org.id);
	assert.equal(body.deleted.slug, "lc-delete");
	assert.equal(body.deleted.name, "lc-delete");
	assert.equal(body.deleted.userCount, 2);
	assert.equal(typeof body.deleted.deviceCount, "number");
	assert.ok(body.deleted.archivedTo.length >= 1);

	// Files moved into deleted-orgs/, originals gone, protected DBs untouched.
	const archiveDir = path.join(tmpDir, "deleted-orgs");
	for (const archived of body.deleted.archivedTo) {
		assert.equal(path.dirname(archived), archiveDir);
		assert.match(path.basename(archived), /^org-lc-delete-\d{8}T\d{6}Z\.db(-wal|-shm)?$/);
		assert.equal(fs.existsSync(archived), true);
	}
	for (const suffix of ["", "-wal", "-shm"]) assert.equal(fs.existsSync(`${dbPath}${suffix}`), false);
	assert.equal(fs.existsSync(process.env.TARGET_SERVER_DB), true);
	assert.equal(fs.existsSync(process.env.TARGET_CONTROL_DB), true);

	// Control plane has no orphan pointing at the deleted org.
	for (const table of ["token_directory", "user_directory", "device_directory", "device_link_requests"]) {
		assert.equal(countRows(table, org.id), 0, `${table} still references the deleted org`);
	}
	assert.equal(control.getOrganization(org.id), null);
	assert.equal(control.getIdentityByEmail("pending@lc-delete.example.com"), null, "orphan identity must be removed");
	assert.ok(control.getIdentityByEmail(shared), "identity with a remaining membership must stay");
	assert.ok(control.getSuperuserByEmail("lifecycle-su@example.com"));

	const auditRow = control
		.openControlDb()
		.prepare("SELECT actor, detail_json FROM platform_audit WHERE action = 'organization.deleted'")
		.all()
		.map((r) => ({ actor: r.actor, detail: JSON.parse(r.detail_json) }))
		.find((r) => r.detail.id === org.id);
	assert.ok(auditRow, "organization.deleted audit row missing");
	assert.equal(auditRow.detail.slug, "lc-delete");
	assert.deepEqual(auditRow.detail.archivedTo, body.deleted.archivedTo);
	assert.ok(control.openControlDb().prepare("SELECT 1 FROM platform_audit WHERE action = 'organization.created'").get());

	// Old session and pending invite fail cleanly, never 500.
	const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: deletedOrgCookie } });
	assert.equal(me.status, 401);
	const events = await fetch(`${base}/api/events`, { headers: { cookie: deletedOrgCookie } });
	assert.equal(events.status, 401);
	const setup = await fetch(`${base}/api/auth/setup`, json("POST", { token: pendingToken, password: "pending-password-12" }));
	assert.ok(setup.status >= 400 && setup.status < 500, `setup with deleted-org token: ${setup.status}`);
	assert.equal(fs.existsSync(dbPath), false, "no request may re-create the deleted org DB");

	// The two-org member still reaches the remaining org, and the picker forgot the deleted one.
	const relog = await fetch(`${base}/api/auth/login`, json("POST", { email: shared, password }));
	assert.equal(relog.status, 200);
	const relogBody = await relog.json();
	assert.equal(relogBody.user.org.id, keep.id);
	assert.deepEqual(relogBody.user.organizations.map((o) => o.id), [keep.id]);
	assert.deepEqual(control.membershipOrgSummaries(shared).map((o) => o.id), [keep.id]);

	const list = await (await fetch(`${base}/api/platform/orgs`, { headers: { cookie } })).json();
	assert.ok(!list.orgs.some((o) => o.id === org.id));
	assert.ok(list.orgs.some((o) => o.id === keep.id));

	// Same slug can be provisioned again with a fresh DB.
	const again = await createOrg("lc-delete", "new-admin@lc-delete.example.com");
	assert.notEqual(again.id, org.id);
	assert.equal(again.userCount, 1);
	assert.equal(fs.existsSync(dbPath), true);
	for (const archived of body.deleted.archivedTo) assert.equal(fs.existsSync(archived), true);
});

test("retired DB path: runWithOrg with opts.dbPath throws org_deleted and creates no file", () => {
	const dbPath = path.join(tmpDir, "org-retired-guard.db");
	retireOrgDbPath(dbPath);
	try {
		assert.equal(isOrgDbPathRetired(dbPath), true);
		assert.throws(
			() => runWithOrg("retired-guard", () => open(), { dbPath }),
			(err) => err.code === "org_deleted",
		);
		assert.equal(fs.existsSync(dbPath), false);
	} finally {
		unretireOrgDbPath(dbPath);
	}
	assert.equal(isOrgDbPathRetired(dbPath), false);
});
