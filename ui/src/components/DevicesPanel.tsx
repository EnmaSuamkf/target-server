import { useState } from "react";
import type { LinkedDevice } from "../api/types.ts";
import { revokeDevice } from "../api/devices.ts";
import { timeAgo } from "../lib/format.ts";

function DeviceStatus({ status }: { status: LinkedDevice["operationalStatus"] }) {
	const className = status === "online" ? "badge--success" : status === "revoked" ? "badge--warn" : "badge--info";
	return <span className={`badge ${className}`}>{status}</span>;
}

/** Management view deliberately receives only the server's secret-free device projection. */
export function DevicesPanel({ devices, onChanged }: { devices: LinkedDevice[] | null; onChanged: () => void }) {
	const [busyId, setBusyId] = useState<string | null>(null);
	const [error, setError] = useState("");

	async function revoke(device: LinkedDevice) {
		if (!window.confirm(`Revoke ${device.name}? The hub will remain fully usable locally and must be linked again for remote services.`)) return;
		setBusyId(device.id);
		setError("");
		const result = await revokeDevice(device.id, "Revoked from dashboard");
		setBusyId(null);
		if (!result.ok) {
			setError(`Could not revoke device: ${result.error}`);
			return;
		}
		onChanged();
	}

	if (!devices) return <div className="empty">Loading linked devices…</div>;
	if (devices.length === 0) {
		return <div className="empty">No linked devices. Start “Connect to server” from a Target hub; approval happens in your browser and never reveals a device secret here.</div>;
	}

	return (
		<div>
			<p className="panel-note">A device identity is separate from your dashboard account. Secrets and pairing codes are never displayed. Revoking stops only remote traffic; local hub workflows continue.</p>
			{error ? <p role="alert" className="panel-note">{error}</p> : null}
			<table>
				<thead><tr><th>Device</th><th>Status</th><th>Scopes</th><th>Last use</th><th>Action</th></tr></thead>
				<tbody>
					{devices.map((device) => (
						<tr key={device.id}>
							<td><strong>{device.name}</strong><br /><span className="mono" title={device.id}>{device.id.slice(0, 14)}…</span></td>
							<td><DeviceStatus status={device.operationalStatus} />{device.revocationReason ? <div className="panel-note">{device.revocationReason}</div> : null}</td>
							<td>{device.scopes.map((scope) => <span className="badge badge--neutral" key={scope}>{scope}</span>)}</td>
							<td className="mono">{device.lastUsedAt ? timeAgo(device.lastUsedAt) : "never"}</td>
							<td>{device.status === "active" ? <button type="button" className="btn btn--ghost btn--sm" disabled={busyId === device.id} onClick={() => void revoke(device)}>{busyId === device.id ? "Revoking…" : "Revoke"}</button> : <span className="panel-note">Re-authorize from the hub</span>}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
