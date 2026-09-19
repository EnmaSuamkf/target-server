import type { AuthRole, AuthUser, FieldError, InviteActivation, InviteLinks } from "./types.ts";

async function parseJson<T>(res: Response): Promise<T> {
	const body = (await res.json()) as T;
	return body;
}

export type AuthProviders = {
	google: boolean;
};

export async function fetchAuthProviders(): Promise<AuthProviders> {
	const res = await fetch("/api/auth/providers");
	if (!res.ok) throw new Error(`/api/auth/providers → ${res.status}`);
	return parseJson<AuthProviders>(res);
}

export async function fetchMe(): Promise<{ user: AuthUser } | null> {
	const res = await fetch("/api/auth/me");
	if (res.status === 401) return null;
	if (!res.ok) throw new Error(`/api/auth/me → ${res.status}`);
	return parseJson(res);
}

export async function login(email: string, password: string) {
	const res = await fetch("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	const body = await res.json();
	if (res.status === 401) return { ok: false as const, error: "invalid_credentials" as const };
	if (res.status === 422) return { ok: false as const, errors: body.errors as FieldError[] };
	if (!res.ok) throw new Error(`/api/auth/login → ${res.status}`);
	return { ok: true as const, user: body.user as AuthUser };
}

export async function logout() {
	await fetch("/api/auth/logout", { method: "POST" });
}

export async function forgotPassword(email: string) {
	const res = await fetch("/api/auth/forgot-password", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email }),
	});
	if (!res.ok && res.status !== 202) throw new Error(`/api/auth/forgot-password → ${res.status}`);
}

export async function setupPassword(token: string, password: string) {
	const res = await fetch("/api/auth/setup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token, password }),
	});
	const body = await res.json();
	if (res.status === 400) return { ok: false as const, error: "invalid_or_expired" as const };
	if (res.status === 409) return { ok: false as const, error: "already_activated" as const };
	if (res.status === 422) return { ok: false as const, errors: body.errors as FieldError[] };
	if (!res.ok) throw new Error(`/api/auth/setup → ${res.status}`);
	return { ok: true as const, user: body.user as AuthUser };
}

export async function resetPassword(token: string, password: string) {
	const res = await fetch("/api/auth/reset-password", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token, password }),
	});
	const body = await res.json();
	if (res.status === 400) return { ok: false as const, error: "invalid_or_expired" as const };
	if (res.status === 422) return { ok: false as const, errors: body.errors as FieldError[] };
	if (!res.ok) throw new Error(`/api/auth/reset-password → ${res.status}`);
	return { ok: true as const, user: body.user as AuthUser };
}

export async function listAuthUsers() {
	const res = await fetch("/api/auth/users");
	if (!res.ok) throw new Error(`/api/auth/users → ${res.status}`);
	return (await res.json()) as { users: AuthUser[] };
}

export async function createAuthUser(email: string, roleId: string, activation?: InviteActivation) {
	const payload: { email: string; role_id: string; activation?: InviteActivation } = { email, role_id: roleId };
	if (activation) payload.activation = activation;
	const res = await fetch("/api/auth/users", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	const body = await res.json();
	if (res.status === 422) return { ok: false as const, errors: body.errors as FieldError[] };
	if (res.status === 409) return { ok: false as const, errors: body.errors as FieldError[] };
	if (!res.ok) throw new Error(`/api/auth/users → ${res.status}`);
	return {
		ok: true as const,
		user: body.user as AuthUser,
		invite: body.invite as InviteLinks,
		mail: body.mail as { sent: boolean; transport?: string; error?: string },
	};
}

export async function listAuthRoles() {
	const res = await fetch("/api/auth/roles");
	if (!res.ok) throw new Error(`/api/auth/roles → ${res.status}`);
	return (await res.json()) as { roles: AuthRole[] };
}

async function roleMutation(method: "POST" | "PATCH", path: string, name: string, permissions: string[]) {
	const res = await fetch(path, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, permissions }),
	});
	const body = await res.json();
	if (res.status === 422) return { ok: false as const, errors: (body.errors ?? []) as FieldError[] };
	if (!res.ok) throw new Error(`${path} → ${res.status}`);
	return { ok: true as const, role: body.role as AuthRole };
}

export function createAuthRole(name: string, permissions: string[]) {
	return roleMutation("POST", "/api/auth/roles", name, permissions);
}

export function updateAuthRole(id: string, name: string, permissions: string[]) {
	return roleMutation("PATCH", `/api/auth/roles/${encodeURIComponent(id)}`, name, permissions);
}

export async function deleteAuthRole(id: string) {
	const res = await fetch(`/api/auth/roles/${encodeURIComponent(id)}`, { method: "DELETE" });
	if (res.status === 409) return { ok: false as const, error: (await res.json()).error as string };
	if (!res.ok) throw new Error(`/api/auth/roles/${id} → ${res.status}`);
	return { ok: true as const };
}

export async function reassignAuthUserRole(userId: string, roleId: string) {
	const res = await fetch(`/api/auth/users/${encodeURIComponent(userId)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ role_id: roleId }),
	});
	const body = await res.json();
	if (res.status === 409 || res.status === 404) return { ok: false as const, error: body.error as string };
	if (res.status === 422) return { ok: false as const, error: "invalid_role" as const };
	if (!res.ok) throw new Error(`/api/auth/users/${userId} → ${res.status}`);
	return { ok: true as const, user: body.user as AuthUser };
}

export async function resendInvite(userId: string) {
	const res = await fetch(`/api/auth/users/${userId}/invite`, { method: "POST" });
	const body = await res.json();
	if (res.status === 409) return { ok: false as const, error: "already_activated" as const };
	if (!res.ok) throw new Error(`/api/auth/users/${userId}/invite → ${res.status}`);
	return {
		ok: true as const,
		invite: body.invite as InviteLinks,
		mail: body.mail as { sent: boolean; transport?: string; error?: string },
	};
}

export async function deleteAuthUser(userId: string) {
	const res = await fetch(`/api/auth/users/${userId}`, { method: "DELETE" });
	if (res.status === 409) {
		const body = await res.json();
		return { ok: false as const, error: body.error as string };
	}
	if (!res.ok) throw new Error(`/api/auth/users/${userId} → ${res.status}`);
	return { ok: true as const };
}
