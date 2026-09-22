import type {
	FieldError,
	SyncClientsResponse,
	SyncCommand,
	SyncCreateRemoteWorkflowResponse,
	SyncEventsResponse,
	SyncRemoteWorkflowDetailResponse,
	SyncRemoteWorkflowsResponse,
	RemoteResource,
	RemoteResourceDomain,
	RemoteResourceBundle,
	RemoteResourcesResponse,
} from "./types.ts";

export async function createRemoteWorkflow(body: {
	client_id: string;
	name: string;
	conversation_context?: string;
	agent?: string;
}): Promise<{ ok: true; data: SyncCreateRemoteWorkflowResponse } | { ok: false; errors: FieldError[] }> {
	const res = await fetch("/api/sync/remote-workflows", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await res.json()) as SyncCreateRemoteWorkflowResponse | { errors: FieldError[] };
	if (!res.ok) {
		return { ok: false, errors: "errors" in data && Array.isArray(data.errors) ? data.errors : [{ field: "_", code: "request_failed", message: `HTTP ${res.status}` }] };
	}
	return { ok: true, data: data as SyncCreateRemoteWorkflowResponse };
}

export async function updateRemoteStepRunSelection(
	remoteId: string,
	stepKeys: string[],
): Promise<{ ok: true; step_keys: string[] } | { ok: false; errors: FieldError[] }> {
	const res = await fetch(`/api/sync/remote-workflows/${encodeURIComponent(remoteId)}/run-selection`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		credentials: "same-origin",
		body: JSON.stringify({ step_keys: stepKeys }),
	});
	const data = (await res.json()) as { step_keys?: string[]; errors?: FieldError[] };
	if (!res.ok) {
		return {
			ok: false,
			errors: data.errors ?? [{ field: "_", code: "request_failed", message: `HTTP ${res.status}` }],
		};
	}
	return { ok: true, step_keys: data.step_keys ?? stepKeys };
}

export async function enqueueRemoteCommand(
	remoteId: string,
	body: { type: string; payload?: Record<string, unknown> },
): Promise<{ ok: true; command: SyncCommand } | { ok: false; errors: FieldError[] }> {
	const res = await fetch(`/api/sync/remote-workflows/${remoteId}/commands`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await res.json()) as { command: SyncCommand; errors?: FieldError[] };
	if (!res.ok) {
		return { ok: false, errors: data.errors ?? [{ field: "_", code: "request_failed", message: `HTTP ${res.status}` }] };
	}
	return { ok: true, command: data.command };
}

export async function deleteRemoteWorkflow(
	remoteId: string,
): Promise<{ ok: true; command: SyncCommand } | { ok: false; error: string }> {
	const res = await fetch(`/api/sync/remote-workflows/${encodeURIComponent(remoteId)}`, {
		method: "DELETE",
		credentials: "same-origin",
	});
	const data = (await res.json().catch(() => ({}))) as { command?: SyncCommand; error?: string };
	if (!res.ok) {
		return { ok: false, error: data.error ?? `HTTP ${res.status}` };
	}
	if (!data.command) {
		return { ok: false, error: "missing command in response" };
	}
	return { ok: true, command: data.command };
}

export async function updateRemoteWorkflowContext(
	remoteId: string,
	conversationContext: string,
): Promise<{ ok: true; data: SyncRemoteWorkflowDetailResponse } | { ok: false; error: string }> {
	const res = await fetch(`/api/sync/remote-workflows/${encodeURIComponent(remoteId)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		credentials: "same-origin",
		body: JSON.stringify({ conversation_context: conversationContext }),
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as { error?: string };
		return { ok: false, error: data.error ?? `HTTP ${res.status}` };
	}
	return { ok: true, data: (await res.json()) as SyncRemoteWorkflowDetailResponse };
}

export async function mutateRemoteResource(
	clientId: string,
	domain: RemoteResourceDomain,
	method: "POST" | "PATCH" | "DELETE",
	resource?: { id: string; name: string; data: Record<string, unknown> },
) {
	const id = resource?.id;
	const endpoint = `/api/sync/clients/${encodeURIComponent(clientId)}/${domain}${method === "POST" ? "" : `/${encodeURIComponent(id ?? "")}`}`;
	const res = await fetch(endpoint, {
		method,
		headers: {
			...(method === "DELETE" ? {} : { "content-type": "application/json" }),
			"idempotency-key": `${domain}:${method}:${id ?? ""}:${JSON.stringify(resource ?? {})}`,
		},
		...(method === "DELETE" ? {} : { body: JSON.stringify({ resource }) }),
	});
	const data = (await res.json().catch(() => ({}))) as { command?: SyncCommand; error?: string; errors?: FieldError[]; detail?: string; idempotent?: boolean };
	if (!res.ok) {
		return { ok: false as const, error: data.detail ?? data.error ?? data.errors?.[0]?.message ?? `HTTP ${res.status}` };
	}
	return { ok: true as const, command: data.command as SyncCommand, idempotent: data.idempotent === true };
}

export async function exportRemoteResources(clientId: string, domain: RemoteResourceDomain) {
	const res = await fetch(`/api/sync/clients/${encodeURIComponent(clientId)}/${domain}/export`);
	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as { error?: string; permission?: string; detail?: string };
		return { ok: false as const, error: data.detail ?? data.error ?? `HTTP ${res.status}`, permission: data.permission };
	}
	const filename =
		res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `${domain}-export.json`;
	const bundle = (await res.json()) as RemoteResourceBundle;
	return { ok: true as const, filename, bundle };
}

export async function importRemoteResources(clientId: string, domain: RemoteResourceDomain, bundle: RemoteResourceBundle) {
	const res = await fetch(`/api/sync/clients/${encodeURIComponent(clientId)}/${domain}/import`, {
		method: "POST",
		headers: { "content-type": "application/json", "idempotency-key": `${domain}:import:${Date.now()}` },
		body: JSON.stringify(bundle),
	});
	const data = (await res.json().catch(() => ({}))) as {
		commands?: Array<{ command: SyncCommand; idempotent: boolean }>;
		error?: string;
		permission?: string;
		detail?: string;
		errors?: FieldError[];
	};
	if (!res.ok) {
		return {
			ok: false as const,
			error: data.detail ?? data.error ?? data.errors?.[0]?.message ?? `HTTP ${res.status}`,
			permission: data.permission,
		};
	}
	return { ok: true as const, commands: data.commands ?? [] };
}

export function downloadJson(filename: string, value: unknown) {
	const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}

export type { SyncClientsResponse, SyncRemoteWorkflowsResponse, SyncEventsResponse, SyncRemoteWorkflowDetailResponse, RemoteResourcesResponse, RemoteResource };
