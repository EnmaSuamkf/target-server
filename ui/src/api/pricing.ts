import { downloadJson } from "./sync.ts";
import type { FieldError, PricingResponse, PricingRule, PricingRuleInput } from "./types.ts";

const BASE = "/api/settings/pricing";

type Fail = { ok: false; error: string; errors?: FieldError[] };
type Result<T> = { ok: true; data: T } | Fail;

async function readError(res: Response): Promise<Fail> {
	const data = (await res.json().catch(() => ({}))) as { error?: string; errors?: FieldError[] };
	// 409 is the table's UNIQUE key; say what it means instead of the code.
	if (res.status === 409 || data.error === "duplicate_rule") {
		return { ok: false, error: "A rule for this agent, model and effective date already exists." };
	}
	const fail: Fail = { ok: false, error: data.errors?.[0]?.message ?? data.error ?? `HTTP ${res.status}` };
	if (data.errors) fail.errors = data.errors;
	return fail;
}

async function send<T>(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<Result<T>> {
	const init: RequestInit = { method, credentials: "same-origin" };
	if (body !== undefined) {
		init.headers = { "content-type": "application/json" };
		init.body = JSON.stringify(body);
	}
	const res = await fetch(path, init);
	if (!res.ok) return readError(res);
	return { ok: true, data: (await res.json()) as T };
}

export async function loadPricing(): Promise<Result<PricingResponse>> {
	const res = await fetch(BASE, { credentials: "same-origin" });
	if (!res.ok) return readError(res);
	return { ok: true, data: (await res.json()) as PricingResponse };
}

export function createPricingRule(input: PricingRuleInput) {
	return send<{ rule: PricingRule }>(BASE, "POST", input);
}

export function updatePricingRule(id: number, input: PricingRuleInput) {
	return send<{ rule: PricingRule }>(`${BASE}/${id}`, "PUT", input);
}

export function deletePricingRule(id: number) {
	return send<{ ok: true }>(`${BASE}/${id}`, "DELETE");
}

export async function exportPricing(): Promise<Result<{ filename: string }>> {
	const res = await fetch(`${BASE}/export`, { credentials: "same-origin" });
	if (!res.ok) return readError(res);
	const filename = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "pricing-export.json";
	downloadJson(filename, await res.json());
	return { ok: true, data: { filename } };
}

export function importPricing(body: unknown, mode: "replace" | "merge") {
	const file = typeof body === "object" && body !== null && !Array.isArray(body) ? body : { rules: body };
	return send<{ rules: PricingRule[] }>(`${BASE}/import`, "POST", { ...file, mode });
}
