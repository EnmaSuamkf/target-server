import type { EventRow } from "../api/types.ts";
import { shortId, timeAgo } from "../lib/format.ts";
import { KindBadge } from "./Badges.tsx";
import { EventPayload } from "./EventPayload.tsx";

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
						<EventPayload kind={e.kind} data={e.data} />
					</div>
				</div>
			))}
		</div>
	);
}
