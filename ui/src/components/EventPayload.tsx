import { summarizeEvent } from "../lib/eventSummary.ts";

/**
 * One event's payload, read as prose.
 *
 * The feed used to print `JSON.stringify(data)` — every field, no hierarchy, a
 * plan snapshot as a single unbroken line. This renders the same payload the
 * way `summarizeEvent` folds it: a headline sentence, the event's own words,
 * the rest as labelled facts, and a plan's steps as a list you can open. The
 * raw JSON stays one click away so nothing this view chooses not to lift is
 * lost.
 */
export function EventPayload({ kind, data }: { kind: string; data: Record<string, unknown> }) {
	if (!data || Object.keys(data).length === 0) return null;
	const s = summarizeEvent(kind, data);
	return (
		<div className="ev-payload">
			{s.headline ? <div className={`ev-headline${s.tone ? ` ev-headline--${s.tone}` : ""}`}>{s.headline}</div> : null}
			{s.text ? <p className="ev-text">{s.text}</p> : null}
			{s.facts.length > 0 ? (
				<dl className="ev-facts">
					{s.facts.map((f) => (
						<div className="ev-fact" key={f.label}>
							<dt>{f.label}</dt>
							<dd className={f.mono ? "mono" : undefined}>{f.value}</dd>
						</div>
					))}
				</dl>
			) : null}
			{s.plan ? (
				<details className="ev-plan">
					<summary>{s.plan.summary}</summary>
					<ol className="ev-plan-list">
						{s.plan.steps.map((st) => (
							<li className="ev-plan-step" key={st.key}>
								<span className={`ev-dot ev-dot--${st.status}`} title={st.status} />
								<span className="ev-plan-num">{st.num}</span>
								<span className="ev-plan-desc">
									{st.description}
									{st.note ? <span className="ev-plan-note">{st.note}</span> : null}
								</span>
							</li>
						))}
					</ol>
				</details>
			) : null}
			<details className="ev-raw">
				<summary>Raw payload</summary>
				<pre className="data">{JSON.stringify(data, null, 2)}</pre>
			</details>
		</div>
	);
}
