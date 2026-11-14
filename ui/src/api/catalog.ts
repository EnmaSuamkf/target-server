import { downloadJson } from "./sync.ts";
import type {
	CatalogSyncRolesResponse,
	FieldError,
	Pipeline,
	PipelineInput,
	PipelineValidation,
	PipelinesResponse,
	ResourceSet,
	ResourceSetInput,
	Tcp,
	TcpInput,
	Template,
	TemplateImportResponse,
	TemplateInput,
} from "./types.ts";

type Fail = { ok: false; error: string; errors?: FieldError[]; permission?: string };

async function readError(res: Response): Promise<Fail> {
	const data = (await res.json().catch(() => ({}))) as {
		error?: string;
		detail?: string;
		permission?: string;
		errors?: FieldError[];
	};
	const fail: Fail = { ok: false, error: data.detail ?? data.error ?? data.errors?.[0]?.message ?? `HTTP ${res.status}` };
	if (data.errors) fail.errors = data.errors;
	if (data.permission) fail.permission = data.permission;
	return fail;
}

async function sendJson<T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<{ ok: true; data: T } | Fail> {
	const init: RequestInit = { method, credentials: "same-origin" };
	if (body !== undefined) {
		init.headers = { "content-type": "application/json" };
		init.body = JSON.stringify(body);
	}
	const res = await fetch(path, init);
	if (!res.ok) return readError(res);
	return { ok: true, data: (await res.json()) as T };
}

export async function createTemplate(input: TemplateInput) {
	return sendJson<{ template: Template }>("/api/templates", "POST", input);
}

export async function updateTemplate(id: string, input: TemplateInput) {
	return sendJson<{ template: Template }>(`/api/templates/${encodeURIComponent(id)}`, "PATCH", input);
}

export async function deleteTemplate(id: string) {
	return sendJson<{ ok: true }>(`/api/templates/${encodeURIComponent(id)}`, "DELETE");
}

export async function createTcp(input: TcpInput) {
	return sendJson<{ tcp: Tcp }>("/api/tcps", "POST", input);
}

export async function updateTcp(id: string, input: TcpInput) {
	return sendJson<{ tcp: Tcp }>(`/api/tcps/${encodeURIComponent(id)}`, "PATCH", input);
}

export async function deleteTcp(id: string) {
	return sendJson<{ ok: true }>(`/api/tcps/${encodeURIComponent(id)}`, "DELETE");
}

export async function createPipeline(input: PipelineInput) {
	return sendJson<{ pipeline: Pipeline }>("/api/pipelines", "POST", input);
}

export async function updatePipeline(id: string, input: Partial<PipelineInput>) {
	return sendJson<{ pipeline: Pipeline }>(`/api/pipelines/${encodeURIComponent(id)}`, "PATCH", input);
}

export async function deletePipeline(id: string) {
	return sendJson<{ ok: true }>(`/api/pipelines/${encodeURIComponent(id)}`, "DELETE");
}

/** Checks YAML on the server without saving it. Errors carry the line they are on. */
export async function validatePipeline(source: string) {
	return sendJson<PipelineValidation>("/api/pipelines/validate", "POST", { source });
}

export async function listPipelines() {
	const res = await fetch("/api/pipelines", { credentials: "same-origin" });
	if (!res.ok) return readError(res);
	return { ok: true as const, data: (await res.json()) as PipelinesResponse };
}

export async function createResourceSet(input: ResourceSetInput) {
	return sendJson<{ resourceSet: ResourceSet }>("/api/resource-sets", "POST", input);
}

export async function updateResourceSet(id: string, input: ResourceSetInput) {
	return sendJson<{ resourceSet: ResourceSet }>(`/api/resource-sets/${encodeURIComponent(id)}`, "PATCH", input);
}

export async function deleteResourceSet(id: string) {
	return sendJson<{ ok: true }>(`/api/resource-sets/${encodeURIComponent(id)}`, "DELETE");
}

export async function exportCatalog(path: string, filenameFallback: string) {
	const res = await fetch(path, { credentials: "same-origin" });
	if (!res.ok) return readError(res);
	const filename = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? filenameFallback;
	const bundle: unknown = await res.json();
	downloadJson(filename, bundle);
	return { ok: true as const, filename };
}

export async function importCatalog<T>(path: string, body: unknown) {
	return sendJson<T>(path, "POST", body);
}

/**
 * `POST /api/templates/import`: a version 1 or 2 bundle. The answer lists the templates,
 * the pipelines the bundle used (each created or reused) and the warnings. A refused
 * bundle keeps its code in `error`, and an invalid embedded pipeline lists its problems in `errors`.
 */
export function importTemplateBundle(body: unknown) {
	return importCatalog<TemplateImportResponse>("/api/templates/import", body);
}

export function splitTags(value: string): string[] {
	return value
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
}

/** Roles that can be stored on a catalog resource as `syncRoleIds`. */
export async function listCatalogSyncRoles() {
	const res = await fetch("/api/catalog/sync-roles", { credentials: "same-origin" });
	if (!res.ok) return readError(res);
	return { ok: true as const, data: (await res.json()) as CatalogSyncRolesResponse };
}
