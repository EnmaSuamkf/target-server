import type { InstanceRow } from "../api/types.ts";
import { shortId, timeAgo } from "../lib/format.ts";

const COLUMNS = ["Instance", "User", "Version", "Events", "Last seen"];

/** The reporting fleet: one row per machine that has ever posted a batch. */
export function InstancesTable({ instances }: { instances: InstanceRow[] | null }) {
	if (!instances || instances.length === 0) return <div className="empty">No instances have reported yet.</div>;
	return (
		<table>
			<thead>
				<tr>
					{COLUMNS.map((c) => (
						<th key={c}>{c}</th>
					))}
				</tr>
			</thead>
			<tbody>
				{instances.map((i) => (
					<tr key={i.instanceId}>
						<td className="mono">{shortId(i.instanceId)}</td>
						<td>{i.displayName || <span className="badge badge--neutral">anonymous</span>}</td>
						<td className="mono">{i.version || "-"}</td>
						<td className="mono">{i.eventsCount}</td>
						<td className="mono">{timeAgo(i.lastSeenAt)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
