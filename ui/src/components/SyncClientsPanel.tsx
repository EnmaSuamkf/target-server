import type { SyncClientRow } from "../api/types.ts";
import { shortId, timeAgo } from "../lib/format.ts";

function AvailabilityBadge({ availability }: { availability: SyncClientRow["availability"] }) {
	if (availability === "idle") {
		return <span className="badge badge--success">idle</span>;
	}
	if (availability === "busy") {
		return (
			<span className="badge badge--info">
				<span className="badge__dot" />
				busy
			</span>
		);
	}
	return <span className="badge badge--neutral">unknown</span>;
}

/** Connected Target sync clients (remote control fleet). */
export function SyncClientsPanel({ clients }: { clients: SyncClientRow[] | null }) {
	if (!clients) return <div className="empty">Loading clients…</div>;
	if (clients.length === 0) {
		return (
			<div className="empty">
				No clients online — start Target on a machine with remote sync enabled (
				<code className="mono">TARGET_SYNC_ENABLED=true</code>). Clients disappear ~90s after the hub stops
				heartbeating.
			</div>
		);
	}

	return (
		<table>
			<thead>
				<tr>
					<th>Client</th>
					<th>Account</th>
					<th>Availability</th>
					<th>Last seen</th>
					<th>Capabilities</th>
				</tr>
			</thead>
			<tbody>
				{clients.map((c) => (
					<tr key={c.id}>
						<td className="mono" title={c.id}>
							{shortId(c.id)}
						</td>
						<td>{c.name || <span className="badge badge--neutral">unnamed</span>}</td>
						<td>
							<AvailabilityBadge availability={c.availability} />
							{c.status !== "active" ? (
								<span className="badge badge--warn" style={{ marginLeft: "0.35rem" }}>
									{c.status}
								</span>
							) : null}
						</td>
						<td className="mono">{c.last_seen_at ? timeAgo(c.last_seen_at) : "—"}</td>
						<td className="sync-caps">
							{(c.capabilities?.commands ?? []).length ? (
								c.capabilities!.commands.slice(0, 4).map((cmd) => (
									<span key={cmd} className="badge badge--neutral" title={cmd}>
										{cmd.replace("workflow.", "wf.").replace("step.", "st.")}
									</span>
								))
							) : (
								<span className="badge badge--neutral">none reported</span>
							)}
							{(c.capabilities?.runners ?? [])
								.filter((r) => r.installed)
								.map((r) => (
									<span key={r.id} className="badge badge--agent" title={`Installed runner: ${r.id}`}>
										{r.id}
									</span>
								))}
							{c.capabilities?.version ? (
								<span className="badge badge--agent" title="Hub version">
									v{c.capabilities.version}
								</span>
							) : null}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
