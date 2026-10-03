import type { FieldError, OtelSettings, OtelSettingsInput, OtelTestResult } from "./types.ts";

const BASE = "/api/settings/otel";

type Fail = { ok: false; error: string; errors?: FieldError[] };
type Result<T> = { ok: true; data: T } | Fail;

async function readError(res: Response): Promise<Fail> {
	const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string; errors?: FieldError[] };
	// 403 carries `{error:"forbidden",permission}`; the endpoint and secrets checks carry a readable `message`.
	if (res.status === 403) return { ok: false, error: "You do not have permission to do this." };
	const fail: Fail = { ok: false, error: data.errors?.[0]?.message ?? data.message ?? data.error ?? `HTTP ${res.status}` };
	if (data.errors) fail.errors = data.errors;
	return fail;
}

async function request<T>(path: string, method: "GET" | "PUT" | "POST" | "DELETE", body?: unknown): Promise<Result<T>> {
	const init: RequestInit = { method, credentials: "same-origin" };
	if (body !== undefined) {
		init.headers = { "content-type": "application/json" };
		init.body = JSON.stringify(body);
	}
	const res = await fetch(path, init);
	if (!res.ok) return readError(res);
	return { ok: true, data: (await res.json()) as T };
}

/** `GET /api/settings/otel` (`telemetry.read`): the saved config with masked headers, plus export status. */
export function loadOtelSettings() {
	return request<OtelSettings>(BASE, "GET");
}

/** `PUT /api/settings/otel` (`telemetry.write`): see `OtelSettingsInput` for the header semantics. */
export function saveOtelSettings(input: OtelSettingsInput) {
	return request<OtelSettings>(BASE, "PUT", input);
}

/** `POST /api/settings/otel/test` (`telemetry.write`): sends one test span and data point to the saved endpoint. */
export function testOtelConnection() {
	return request<OtelTestResult>(`${BASE}/test`, "POST");
}

/** `DELETE /api/settings/otel` (`telemetry.write`): removes the settings, outbox and export state. */
export function deleteOtelSettings() {
	return request<{ ok: true }>(BASE, "DELETE");
}
