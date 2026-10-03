/**
 * SSRF guard for the OTLP destination an organization configures.
 *
 * The endpoint must be https and must not point at this host or an internal
 * network: loopback, link-local (including the 169.254.169.254 cloud metadata
 * address), private, CGNAT, multicast and reserved ranges, IPv4 and IPv6, and
 * IPv6 forms that embed an IPv4 address. A hostname is resolved and EVERY
 * address it returns must be public. Redirects are never followed (see
 * `noRedirectFetch`). TARGET_OTEL_ALLOW_PRIVATE=1 lifts the scheme and address
 * checks for local backends (Langfuse, otel-lgtm). Resolution happens at
 * validation time; callers validate again before each delivery round.
 */
import dns from "node:dns/promises";
import net from "node:net";

export const ENDPOINT_ERRORS = Object.freeze({
	invalid: "endpoint_invalid",
	scheme: "endpoint_scheme",
	credentials: "endpoint_credentials",
	private: "endpoint_private",
	unresolvable: "endpoint_unresolvable",
});

const MESSAGES = {
	endpoint_invalid: "Endpoint must be a valid absolute URL",
	endpoint_scheme: "Endpoint must use https",
	endpoint_credentials: "Endpoint must not contain a username or password; use a header instead",
	endpoint_private: "Endpoint points at a local or private address",
	endpoint_unresolvable: "Endpoint host could not be resolved",
};

const fail = (code) => ({ ok: false, code, message: MESSAGES[code] });

export const allowPrivateEndpoints = (env = process.env) => env.TARGET_OTEL_ALLOW_PRIVATE === "1";

/** [prefix, bits] IPv4 blocks that are never a public destination. */
const V4_BLOCKS = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
].map(([base, bits]) => [v4ToInt(base), bits]);

function v4ToInt(text) {
	return text.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

function isPrivateV4(text) {
	const n = v4ToInt(text);
	return V4_BLOCKS.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

/** IPv6 text → 16 bytes (handles `::` and a trailing dotted IPv4); null if malformed. */
function v6ToBytes(text) {
	let head = text.split("%")[0];
	const tailV4 = head.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (tailV4) {
		const n = v4ToInt(tailV4[1]);
		head = head.slice(0, -tailV4[1].length) + `${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
	}
	const halves = head.split("::");
	if (halves.length > 2) return null;
	const groups = (s) => (s === "" ? [] : s.split(":"));
	const left = groups(halves[0]);
	const right = halves.length === 2 ? groups(halves[1]) : [];
	const missing = 8 - left.length - right.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
	const all = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right];
	const bytes = [];
	for (const g of all) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
		const v = parseInt(g, 16);
		bytes.push(v >> 8, v & 0xff);
	}
	return bytes.length === 16 ? bytes : null;
}

function isPrivateV6(text) {
	const b = v6ToBytes(text);
	if (!b) return true;
	const embedded = (offset) => b.slice(offset, offset + 4).join(".");
	const zeros = (from, to) => b.slice(from, to).every((x) => x === 0);
	if (zeros(0, 15) && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
	if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateV4(embedded(12)); // ::ffff:a.b.c.d
	if (zeros(0, 12)) return true; // IPv4-compatible ::a.b.c.d (deprecated)
	if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return isPrivateV4(embedded(12)); // NAT64
	if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4(embedded(2)); // 6to4
	if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
	if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local (incl. fd00:ec2::254)
	if (b[0] === 0xff) return true; // multicast
	if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
	return false;
}

/** True for any IP literal that is not a public unicast address. Non-IPs return false. */
export function isPrivateAddress(address) {
	const kind = net.isIP(address);
	if (kind === 4) return isPrivateV4(address);
	if (kind === 6) return isPrivateV6(address);
	return false;
}

const INTERNAL_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/;

/**
 * Validate an OTLP endpoint. Resolves to `{ok: true, url}` or
 * `{ok: false, code, message}` with a stable `endpoint_*` code.
 * `lookup` is injectable for tests; it must behave like `dns.lookup(host, {all: true})`.
 */
export async function validateOtelEndpoint(endpoint, { allowPrivate = allowPrivateEndpoints(), lookup = dns.lookup } = {}) {
	let url;
	try {
		url = new URL(String(endpoint).trim());
	} catch {
		return fail(ENDPOINT_ERRORS.invalid);
	}
	if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
		return url.protocol === "http:" ? fail(ENDPOINT_ERRORS.scheme) : fail(ENDPOINT_ERRORS.invalid);
	}
	if (url.username || url.password) return fail(ENDPOINT_ERRORS.credentials);
	if (!url.hostname) return fail(ENDPOINT_ERRORS.invalid);
	if (allowPrivate) return { ok: true, url: url.href };

	// `new URL` already normalizes decimal/hex/octal IPv4 spellings to dotted form.
	const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
	if (net.isIP(host)) return isPrivateAddress(host) ? fail(ENDPOINT_ERRORS.private) : { ok: true, url: url.href };
	if (INTERNAL_NAME.test(host)) return fail(ENDPOINT_ERRORS.private);

	let addresses;
	try {
		addresses = await lookup(host, { all: true, verbatim: true });
	} catch {
		return fail(ENDPOINT_ERRORS.unresolvable);
	}
	if (!Array.isArray(addresses) || addresses.length === 0) return fail(ENDPOINT_ERRORS.unresolvable);
	if (addresses.some((a) => isPrivateAddress(a.address))) return fail(ENDPOINT_ERRORS.private);
	return { ok: true, url: url.href };
}

/** `fetch` that never follows redirects; a 3xx surfaces as a plain failed response. */
export function noRedirectFetch(url, init = {}) {
	return globalThis.fetch(url, { ...init, redirect: "manual" });
}
