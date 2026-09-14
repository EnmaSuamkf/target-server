import type {
	FieldError,
	SyncClientsResponse,
	SyncCommand,
	SyncCreateRemoteWorkflowResponse,
	SyncEventsResponse,
	SyncRemoteWorkflowDetailResponse,
	SyncRemoteWorkflowsResponse,
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

export type { SyncClientsResponse, SyncRemoteWorkflowsResponse, SyncEventsResponse, SyncRemoteWorkflowDetailResponse };
