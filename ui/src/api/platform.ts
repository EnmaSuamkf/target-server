import type {
	AuthUser,
	DeletedPlatformOrg,
	FieldError,
	InviteActivation,
	InviteLinks,
	PlatformOrg,
	PlatformOrgStatus,
} from "./types.ts";

async function parseJson<T>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

export async function listPlatformOrgs() {
	const res = await fetch("/api/platform/orgs");
	if (!res.ok) throw new Error(`/api/platform/orgs → ${res.status}`);
	return parseJson<{ orgs: PlatformOrg[] }>(res);
}

export async function createPlatformOrg(body: {
	name: string;
	slug: string;
	admin_email: string;
	activation?: InviteActivation;
}) {
	const res = await fetch("/api/platform/orgs", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const payload = await res.json();
	if (res.status === 422 || res.status === 409) {
		return { ok: false as const, errors: (payload.errors ?? []) as FieldError[] };
	}
	if (!res.ok) throw new Error(`/api/platform/orgs → ${res.status}`);
	return {
		ok: true as const,
		org: payload.org as PlatformOrg,
		admin: payload.admin as AuthUser,
		invite: payload.invite as InviteLinks,
		mail: payload.mail as { sent: boolean; transport?: string; error?: string },
	};
}

export async function resendPlatformAdminInvite(orgId: string) {
	const res = await fetch(`/api/platform/orgs/${encodeURIComponent(orgId)}/admin-invite`, { method: "POST" });
	const payload = await res.json();
	if (res.status === 409) return { ok: false as const, error: "already_activated" as const };
	if (res.status === 404) return { ok: false as const, error: "not_found" as const };
	if (!res.ok) throw new Error(`/api/platform/orgs/${orgId}/admin-invite → ${res.status}`);
	return {
		ok: true as const,
		admin: payload.admin as AuthUser,
		invite: payload.invite as InviteLinks,
		mail: payload.mail as { sent: boolean; transport?: string; error?: string },
	};
}

export async function setPlatformOrgStatus(orgId: string, status: PlatformOrgStatus) {
	const res = await fetch(`/api/platform/orgs/${encodeURIComponent(orgId)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ status }),
	});
	const payload = await res.json();
	if (res.status === 409) return { ok: false as const, error: "default_org_protected" as const };
	if (res.status === 404) return { ok: false as const, error: "not_found" as const };
	if (res.status === 422) return { ok: false as const, error: "invalid" as const, errors: (payload.errors ?? []) as FieldError[] };
	if (!res.ok) throw new Error(`/api/platform/orgs/${orgId} → ${res.status}`);
	return { ok: true as const, org: payload.org as PlatformOrg };
}

export async function deletePlatformOrg(orgId: string, confirmSlug: string) {
	const res = await fetch(`/api/platform/orgs/${encodeURIComponent(orgId)}`, {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ confirm_slug: confirmSlug }),
	});
	const payload = await res.json();
	if (res.status === 409) return { ok: false as const, error: "default_org_protected" as const };
	if (res.status === 404) return { ok: false as const, error: "not_found" as const };
	if (res.status === 422) return { ok: false as const, error: "invalid" as const, errors: (payload.errors ?? []) as FieldError[] };
	if (!res.ok) throw new Error(`/api/platform/orgs/${orgId} → ${res.status}`);
	return { ok: true as const, deleted: payload.deleted as DeletedPlatformOrg };
}
