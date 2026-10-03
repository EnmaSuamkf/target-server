/**
 * OTLP/HTTP JSON sender: POST a request body to <endpoint>/v1/traces or
 * /v1/metrics with the retry rules of the OTLP spec. Node's global fetch only,
 * injectable for tests; no dependencies.
 *
 * It never throws for HTTP or network failures: the caller (a background
 * worker) reads `{ok, status, attempts, partialSuccess, error}`. `error` is a
 * short description (status or error name) and never carries header values,
 * which may be credentials, nor the request body.
 */
import { gzipSync } from "node:zlib";

/** Statuses the spec says to retry; every other 4xx is final. */
const RETRYABLE = new Set([429, 502, 503, 504]);
const BASE_DELAY_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** A server asking for more than this is not waited for in a single sleep. */
const MAX_RETRY_AFTER_MS = 60_000;

const SIGNALS = new Set(["traces", "metrics"]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The URL for one signal. An endpoint that already ends in a /v1/<signal>
 * path keeps it (another signal's path is swapped), so a pasted full URL is
 * never doubled; trailing slashes are ignored.
 */
export function otlpUrl(endpoint, signal) {
	const base = String(endpoint).trim().replace(/\/+$/, "");
	const pathed = base.replace(/\/v1\/(traces|metrics|logs)$/, "");
	return `${pathed}/v1/${signal}`;
}

/** Retry-After as milliseconds: delay-seconds or an HTTP date; null when absent or unusable. */
export function parseRetryAfter(value, nowMs = Date.now()) {
	if (value == null) return null;
	const text = String(value).trim();
	if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
	const at = Date.parse(text);
	if (Number.isNaN(at)) return null;
	return Math.min(Math.max(0, at - nowMs), MAX_RETRY_AFTER_MS);
}

/** Exponential backoff with jitter: half to all of base * 2^(attempt-1), capped. */
function backoffMs(attempt) {
	const ceiling = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
	return Math.round(ceiling * (0.5 + Math.random() / 2));
}

/** The caller's headers, minus the two this client owns. */
function requestHeaders(headers, gzip) {
	const out = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		const lower = name.toLowerCase();
		if (lower === "content-type" || lower === "content-encoding" || lower === "content-length") continue;
		out[name] = String(value);
	}
	out["Content-Type"] = "application/json";
	if (gzip) out["Content-Encoding"] = "gzip";
	return out;
}

const count = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};

/**
 * `partialSuccess` of a 2xx body, or null when the backend rejected nothing.
 * Backends answer `{"partialSuccess":{}}` for a clean accept (phase0 Q2).
 */
function readPartialSuccess(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const p = parsed?.partialSuccess;
	if (!p || typeof p !== "object") return null;
	const out = {
		rejectedSpans: count(p.rejectedSpans),
		rejectedDataPoints: count(p.rejectedDataPoints),
		errorMessage: typeof p.errorMessage === "string" ? p.errorMessage : "",
	};
	return out.rejectedSpans || out.rejectedDataPoints || out.errorMessage ? out : null;
}

/** One POST with its own timeout; the body is read inside it so a stalled stream times out too. */
async function attemptOnce(fetchImpl, url, init, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(url, { ...init, signal: controller.signal });
		const text = await res.text().catch(() => "");
		return { res, text };
	} catch (err) {
		if (controller.signal.aborted) return { failure: `timeout after ${timeoutMs}ms` };
		const code = err?.cause?.code ?? err?.code;
		return { failure: `network error: ${code ?? err?.name ?? "unknown"}` };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Send one OTLP/JSON request. `signal` is "traces" or "metrics"; `body` is the
 * request object (or an already serialised string). Retries 429/502/503/504
 * and network errors up to `maxAttempts`, waiting Retry-After when the server
 * sent one and an exponential backoff with jitter otherwise.
 */
export async function sendOtlp({
	endpoint,
	signal,
	body,
	headers = {},
	timeoutMs = 10_000,
	gzip = false,
	maxAttempts = 5,
	fetchImpl = globalThis.fetch,
	sleep = defaultSleep,
	now = Date.now,
} = {}) {
	const result = (fields) => ({ ok: false, status: null, attempts: 0, partialSuccess: null, error: null, ...fields });
	if (!SIGNALS.has(signal)) return result({ error: `unsupported signal: ${signal}` });
	if (typeof endpoint !== "string" || endpoint.trim() === "") return result({ error: "missing endpoint" });
	let url;
	let payload;
	try {
		url = otlpUrl(endpoint, signal);
		new URL(url);
		const json = typeof body === "string" ? body : JSON.stringify(body);
		payload = gzip ? gzipSync(json) : json;
	} catch {
		return result({ error: "invalid endpoint or body" });
	}
	const init = { method: "POST", headers: requestHeaders(headers, gzip), body: payload };
	const attemptsAllowed = Math.max(1, Math.floor(maxAttempts) || 1);

	let status = null;
	let error = null;
	for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
		const { res, text, failure } = await attemptOnce(fetchImpl, url, init, timeoutMs);
		let wait = null;
		if (failure) {
			status = null;
			error = failure;
		} else {
			status = res.status;
			if (res.status >= 200 && res.status < 300) {
				return { ok: true, status, attempts: attempt, partialSuccess: readPartialSuccess(text), error: null };
			}
			error = `HTTP ${res.status}`;
			if (!RETRYABLE.has(res.status)) return result({ status, attempts: attempt, error });
			wait = parseRetryAfter(res.headers?.get?.("retry-after"), now());
		}
		if (attempt < attemptsAllowed) await sleep(wait ?? backoffMs(attempt));
	}
	return result({ status, attempts: attemptsAllowed, error });
}
