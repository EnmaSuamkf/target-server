import type { UsageSession } from "../api/types.ts";
import { compactNumber, shortId } from "../lib/format.ts";

/**
 * How full the context window is, as a percentage. The window is the one the
 * session's model actually ran on (the hub derives it per model), not a fixed
 * 200k — against an assumed window a 1M-context session reads as permanently
 * over 100%.
 */
export function contextPercent(u: Pick<UsageSession, "contextTokens" | "contextWindow">): number {
	return u.contextWindow > 0 ? (100 * u.contextTokens) / u.contextWindow : 0;
}

/**
 * One session's token usage, stated exactly as the operator's own client states
 * it — a `Context <used> / <window>` bar with the percentage, then
 * `<n> turns · in <x> · out <y> · incl. subagents`.
 *
 * This is a deliberate mirror of the hub's `UsageMeter` (hub/ui/src/views/
 * UsageMeter.tsx), rewritten in this dashboard's own idiom (global.css classes,
 * no CSS modules) rather than imported: the two repos ship separately, but the
 * strings they print have to be comparable digit for digit.
 *
 * `in` is the FULL input — new + cache creation + cache read. The bare
 * `input_tokens` field is near-zero once prompt caching is on (one real session
 * here: 416 uncached against 16,015,192 total), which is exactly the bug this
 * readout was added to make visible.
 */
export function UsageMeter({ usage }: { usage: UsageSession }) {
	const pct = contextPercent(usage);
	// A hub too old to report the window sends no context at all. Saying so
	// beats drawing an empty meter that looks like "0% used".
	const hasContext = usage.contextWindow > 0;
	// Warn as the window fills: past ~90% the session is close to compaction.
	const tone = pct >= 90 ? " usage__meter--danger" : pct >= 70 ? " usage__meter--warn" : "";
	return (
		<div className="usage" data-usage-meter>
			<div className="usage__head">
				<span
					title={
						usage.model
							? `window for ${usage.model}`
							: "no model reported — this session's hub predates the context readout"
					}
				>
					{hasContext ? `Context ${compactNumber(usage.contextTokens)} / ${compactNumber(usage.contextWindow)}` : "Context not reported"}
				</span>
				{hasContext ? <span className="usage__pct mono">{`${pct.toFixed(1)}%`}</span> : null}
			</div>
			{hasContext ? (
				<span className={`usage__meter${tone}`}>
					<span className="usage__meter-fill" style={{ width: `${Math.min(100, pct)}%` }} />
				</span>
			) : null}
			<p className="usage__totals">
				{`${usage.turns} turns · in ${compactNumber(usage.inputTokens)} · out ${compactNumber(usage.outputTokens)}`}
				{usage.includesSubagents ? " · incl. subagents" : ""}
			</p>
			<p className="usage__parts">
				{usage.sessionId ? <span className="mono usage__session">{shortId(usage.sessionId)}</span> : null}
				{usage.model ? <span className="mono">{usage.model}</span> : null}
				<span>{`in = ${usage.inputTokensUncached.toLocaleString()} new + ${usage.cacheCreation.toLocaleString()} cache write + ${usage.cacheRead.toLocaleString()} cache read`}</span>
				{usage.compacted ? <span>compacted</span> : null}
			</p>
		</div>
	);
}
