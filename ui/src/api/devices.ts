import type { LinkedDevicesResponse } from "./types.ts";

export async function revokeDevice(deviceId: string, reason?: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const response = await fetch(`/api/device-links/devices/${encodeURIComponent(deviceId)}/revoke`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		credentials: "same-origin",
		body: JSON.stringify(reason ? { reason } : {}),
	});
	if (response.ok) return { ok: true };
	const body = (await response.json().catch(() => ({}))) as { error?: string };
	return { ok: false, error: body.error ?? `HTTP ${response.status}` };
}

export type { LinkedDevicesResponse };
