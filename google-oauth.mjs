/**
 * Google OAuth 2.0 (authorization code) — native fetch only, no passport.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { publicUrl } from "./db.mjs";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const OAUTH_STATE_COOKIE = "target_google_oauth_state";
const STATE_TTL_SECONDS = 600;

function secureCookieFlag() {
	if (process.env.TARGET_AUTH_SECURE_COOKIE === "0") return false;
	if (process.env.TARGET_AUTH_SECURE_COOKIE === "1") return true;
	const pub = process.env.TARGET_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "";
	return pub.startsWith("https://");
}

export function isGoogleOAuthConfigured() {
	const clientId = (process.env.TARGET_GOOGLE_CLIENT_ID ?? "").trim();
	const clientSecret = (process.env.TARGET_GOOGLE_CLIENT_SECRET ?? "").trim();
	return Boolean(clientId && clientSecret);
}

export function googleRedirectUri(opts = {}) {
	return `${publicUrl(opts).replace(/\/$/, "")}/api/auth/google/callback`;
}

export function createOAuthState() {
	return randomBytes(32).toString("base64url");
}

function readCookie(req, name) {
	const cookie = req.headers.cookie ?? "";
	for (const part of cookie.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === name) return decodeURIComponent(rest.join("="));
	}
	return null;
}

export function readOAuthStateCookie(req) {
	return readCookie(req, OAUTH_STATE_COOKIE);
}

export function setOAuthStateCookie(res, state) {
	const flags = ["HttpOnly", "SameSite=Lax", "Path=/api/auth/google", `Max-Age=${STATE_TTL_SECONDS}`];
	if (secureCookieFlag()) flags.push("Secure");
	res.setHeader("Set-Cookie", `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; ${flags.join("; ")}`);
}

export function clearOAuthStateCookie(res) {
	const flags = ["HttpOnly", "SameSite=Lax", "Path=/api/auth/google", "Max-Age=0"];
	if (secureCookieFlag()) flags.push("Secure");
	res.setHeader("Set-Cookie", `${OAUTH_STATE_COOKIE}=; ${flags.join("; ")}`);
}

export function verifyOAuthState(req, state) {
	if (!state || typeof state !== "string") return false;
	const expected = readOAuthStateCookie(req);
	if (!expected) return false;
	const a = Buffer.from(state);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export function buildGoogleAuthUrl(state, opts = {}) {
	const clientId = (process.env.TARGET_GOOGLE_CLIENT_ID ?? "").trim();
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: googleRedirectUri(opts),
		response_type: "code",
		scope: "openid email profile",
		state,
		access_type: "online",
		include_granted_scopes: "true",
		prompt: "select_account",
	});
	return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleCode(code, opts = {}) {
	const clientId = (process.env.TARGET_GOOGLE_CLIENT_ID ?? "").trim();
	const clientSecret = (process.env.TARGET_GOOGLE_CLIENT_SECRET ?? "").trim();
	const body = new URLSearchParams({
		code,
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uri: googleRedirectUri(opts),
		grant_type: "authorization_code",
	});
	const res = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
	});
	let data;
	try {
		data = await res.json();
	} catch {
		throw new Error("google_token_invalid_json");
	}
	if (!res.ok || !data.access_token) {
		const err = new Error(data.error ?? "google_token_exchange_failed");
		err.details = data;
		throw err;
	}
	return data;
}

/** Requires verified email, `sub`, and `email` from Google userinfo. */
export async function fetchGoogleUserInfo(accessToken) {
	const res = await fetch(GOOGLE_USERINFO_URL, {
		headers: { authorization: `Bearer ${accessToken}` },
	});
	let data;
	try {
		data = await res.json();
	} catch {
		throw new Error("google_userinfo_invalid_json");
	}
	if (!res.ok) {
		const err = new Error("google_userinfo_failed");
		err.details = data;
		throw err;
	}
	if (!data.sub || !data.email) {
		throw new Error("google_userinfo_incomplete");
	}
	if (data.email_verified !== true) {
		throw new Error("google_email_unverified");
	}
	return {
		sub: String(data.sub),
		email: String(data.email).toLowerCase(),
		name: data.name ?? null,
		picture: data.picture ?? null,
	};
}
