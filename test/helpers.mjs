/**
 * Shared helpers for API tests — login as the seeded admin and return Cookie header.
 */
export const DEFAULT_ADMIN_EMAIL = "admin@admin.com";
export const DEFAULT_ADMIN_PASSWORD = "password-target-server";

export async function login(base, { email = DEFAULT_ADMIN_EMAIL, password = DEFAULT_ADMIN_PASSWORD } = {}) {
	const res = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	if (!res.ok) throw new Error(`login failed: ${res.status}`);
	const setCookie = res.headers.getSetCookie?.() ?? [];
	const raw = res.headers.get("set-cookie") ?? "";
	const cookie = setCookie.length ? setCookie.map((c) => c.split(";")[0]).join("; ") : raw.split(";")[0];
	return cookie;
}

export function authed(cookie) {
	return cookie ? { cookie } : {};
}
