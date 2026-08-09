import type { EventRow } from "../api/types.ts";
import { shortId, timeAgo } from "../lib/format.ts";
import { KindBadge } from "./Badges.tsx";

/** The live event stream, newest first. */
export function EventFeed({ events }: { events: EventRow[] | null }) {
	if (!events || events.length === 0) return <div className="empty">No events match these filters.</div>;
	return (
		<div className="feed">
			{events.map((e) => (
				<div className="event" key={e.id}>
					<span className="when" title={e.receivedAt}>
						{timeAgo(e.receivedAt)}
					</span>
					<div className="body">
						<KindBadge kind={e.kind} />
						<span className="kind-raw">{e.kind}</span>
						<div className="meta">
							{shortId(e.instanceId)}
							{e.workflowId ? ` · wf ${shortId(e.workflowId)}` : ""}
						</div>
						{e.data && Object.keys(e.data).length > 0 ? <div className="data">{JSON.stringify(e.data)}</div> : null}
					</div>
				</div>
			))}
		</div>
	);
}
