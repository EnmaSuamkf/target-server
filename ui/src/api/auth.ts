import type { AuthUser, FieldError } from "./types.ts";

async function parseJson<T>(res: Response): Promise<T> {
	const body = (await res.json()) as T;
	return body;
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

export async function createAuthUser(email: string) {
	const res = await fetch("/api/auth/users", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email }),
	});
	const body = await res.json();
	if (res.status === 422) return { ok: false as const, errors: body.errors as FieldError[] };
	if (res.status === 409) return { ok: false as const, errors: body.errors as FieldError[] };
	if (!res.ok) throw new Error(`/api/auth/users → ${res.status}`);
	return {
		ok: true as const,
		user: body.user as AuthUser,
		invite: body.invite as { url: string; expiresAt: string },
		mail: body.mail as { sent: boolean; transport?: string; error?: string },
	};
}

export async function resendInvite(userId: string) {
	const res = await fetch(`/api/auth/users/${userId}/invite`, { method: "POST" });
	const body = await res.json();
	if (res.status === 409) return { ok: false as const, error: "already_activated" as const };
	if (!res.ok) throw new Error(`/api/auth/users/${userId}/invite → ${res.status}`);
	return {
		ok: true as const,
		invite: body.invite as { url: string; expiresAt: string },
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
