/**
 * JWT sessions, scrypt passwords, cookie transport — zero external deps.
 */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getAuthUserById, getJwtSecret } from "./db.mjs";

const scryptAsync = promisify(scrypt);

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;

const COOKIE_NAME = "target_auth";
const TTL_HOURS = Number.parseInt(process.env.TARGET_AUTH_TTL_HOURS ?? "8", 10);

function secureCookieFlag() {
	if (process.env.TARGET_AUTH_SECURE_COOKIE === "0") return false;
	if (process.env.TARGET_AUTH_SECURE_COOKIE === "1") return true;
	const pub = process.env.TARGET_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "";
	return pub.startsWith("https://");
}

export function ttlSeconds() {
	return Math.max(1, TTL_HOURS) * 3600;
}

function b64url(data) {
	return Buffer.from(data).toString("base64url");
}

export function signJwt(payload, secret) {
	const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = b64url(JSON.stringify(payload));
	const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
	return `${header}.${body}.${sig}`;
}

export function verifyJwt(token, secret) {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [headerB64, bodyB64, sigB64] = parts;
	let header;
	try {
		header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (header.alg !== "HS256") return null;
	const expected = createHmac("sha256", secret).update(`${headerB64}.${bodyB64}`).digest();
	let actual;
	try {
		actual = Buffer.from(sigB64, "base64url");
	} catch {
		return null;
	}
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
	let payload;
	try {
		payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (typeof payload.exp === "number" && Date.now() / 1000 >= payload.exp) return null;
	return payload;
}

export async function hashPassword(plain) {
	const salt = randomBytes(16);
	const hash = await scryptAsync(plain, salt, 64, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
	return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(plain, stored) {
	if (!stored) return false;
	const m = stored.match(/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([^$]+)\$(.+)$/);
	if (!m) return false;
	const [, n, r, p, saltB64, hashB64] = m;
	const salt = Buffer.from(saltB64, "base64");
	const expected = Buffer.from(hashB64, "base64");
	const hash = await scryptAsync(plain, salt, expected.length, { N: +n, r: +r, p: +p });
	return hash.length === expected.length && timingSafeEqual(hash, expected);
}

/** Dummy hash for timing-equal login failures when the user does not exist. */
export const DUMMY_PASSWORD_HASH =
	"scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export function readToken(req) {
	const auth = req.headers.authorization ?? "";
	if (auth.startsWith("Bearer ")) return auth.slice(7);
	const cookie = req.headers.cookie ?? "";
	for (const part of cookie.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === COOKIE_NAME) return decodeURIComponent(rest.join("="));
	}
	return null;
}

export function sessionPayload(user) {
	const now = Math.floor(Date.now() / 1000);
	return {
		sub: user.id,
		email: user.email,
		role: user.role,
		tv: user.tokenVersion,
		iat: now,
		exp: now + ttlSeconds(),
	};
}

export function setAuthCookie(res, jwt) {
	const flags = ["HttpOnly", "SameSite=Strict", `Path=/`, `Max-Age=${ttlSeconds()}`];
	if (secureCookieFlag()) flags.push("Secure");
	res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(jwt)}; ${flags.join("; ")}`);
}

export function clearAuthCookie(res) {
	const flags = ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
	if (secureCookieFlag()) flags.push("Secure");
	res.setHeader("Set-Cookie", `${COOKIE_NAME}=; ${flags.join("; ")}`);
}

export function publicUser(row) {
	return {
		id: row.id,
		email: row.email,
		role: row.role,
		createdAt: row.createdAt,
		lastLoginAt: row.lastLoginAt,
		status: row.passwordHash ? "active" : "pending",
	};
}

/** Verify JWT + token_version against the DB. Optionally refresh a half-expired cookie. */
export async function authenticate(req, res = null) {
	const token = readToken(req);
	if (!token) return null;
	const secret = getJwtSecret();
	const payload = verifyJwt(token, secret);
	if (!payload || typeof payload.sub !== "string") return null;
	const user = getAuthUserById(payload.sub);
	if (!user || user.tokenVersion !== payload.tv) return null;

	if (res && typeof payload.iat === "number") {
		const half = ttlSeconds() / 2;
		if (Math.floor(Date.now() / 1000) - payload.iat >= half) {
			const jwt = signJwt(sessionPayload(user), secret);
			setAuthCookie(res, jwt);
		}
	}
	return user;
}

export async function requireAuth(req, res) {
	const user = await authenticate(req, res);
	if (!user) {
		res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify({ error: "unauthorized" }));
		return null;
	}
	return user;
}

export function signInUser(user, res) {
	const jwt = signJwt(sessionPayload(user), getJwtSecret());
	setAuthCookie(res, jwt);
	return jwt;
}

export function randomTokenBytes() {
	return randomBytes(32);
}

export function hashToken(raw) {
	return createHash("sha256").update(raw).digest("hex");
}
