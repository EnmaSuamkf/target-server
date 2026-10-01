import { useEffect, useRef, useState } from "react";
import { loadEstimate, loadPricing } from "../api/pricing.ts";
import type { EstimateQuery, EstimateResponse } from "../api/types.ts";
import { formatUsd } from "../lib/format.ts";

/** Typing a name or flipping the step count must not fire a request per keystroke. */
export const ESTIMATE_DEBOUNCE_MS = 400;

type State = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; estimate: EstimateResponse };

/**
 * "Estimated cost: $p50 - $p90 (based on N past runs)" for a run about to be
 * created or scheduled.
 *
 * Renders nothing unless the viewer has `pricing.read` (`enabled`), there is
 * something to estimate for (a template or an agent), and the organization has
 * at least one pricing rule — without a price table every estimate would be a
 * dash and the line would only be noise. With too little history it says so
 * instead of guessing.
 *
 * Requests are debounced, and a response only lands if it still belongs to the
 * latest query: a slow answer for an earlier template must not overwrite the
 * answer for the one now selected.
 */
export function EstimateBadge({
	enabled,
	query,
	perRun = false,
}: {
	enabled: boolean;
	query: EstimateQuery;
	/** Label it "per run" — for a recurring schedule. */
	perRun?: boolean;
}) {
	const [state, setState] = useState<State>({ kind: "idle" });
	const [hasRules, setHasRules] = useState<boolean | null>(null);
	const latest = useRef(0);
	const { templateId, agent, model, steps } = query;
	const estimable = enabled && Boolean(templateId || agent);

	useEffect(() => {
		if (!estimable || hasRules !== null) return;
		let live = true;
		void loadPricing().then((result) => {
			if (live) setHasRules(result.ok && result.data.rules.length > 0);
		});
		return () => {
			live = false;
		};
	}, [estimable, hasRules]);

	useEffect(() => {
		if (!estimable || !hasRules) {
			setState({ kind: "idle" });
			return;
		}
		const ticket = ++latest.current;
		setState({ kind: "loading" });
		const timer = setTimeout(() => {
			const q: EstimateQuery = {};
			if (templateId) q.templateId = templateId;
			if (agent) q.agent = agent;
			if (model) q.model = model;
			if (steps) q.steps = steps;
			void loadEstimate(q).then((result) => {
				// A newer query (or an unmount, which bumps nothing but clears the timer
				// and is covered by the cleanup below) supersedes this answer.
				if (ticket !== latest.current) return;
				setState(result.ok ? { kind: "ready", estimate: result.data } : { kind: "idle" });
			});
		}, ESTIMATE_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			// Invalidate an in-flight request too, so it cannot land after the
			// inputs changed or the component went away.
			latest.current++;
		};
	}, [estimable, hasRules, templateId, agent, model, steps]);

	if (!estimable || !hasRules || state.kind === "idle") return null;
	if (state.kind === "loading") {
		return (
			<p className="hint" data-estimate-badge aria-live="polite">
				Estimating cost…
			</p>
		);
	}
	const e = state.estimate;
	if ("status" in e) {
		return (
			<p className="hint" data-estimate-badge aria-live="polite">
				Not enough history to estimate{e.sampleSize > 0 ? ` (${e.sampleSize} past run${e.sampleSize === 1 ? "" : "s"})` : ""}.
			</p>
		);
	}
	return (
		<p className="hint" data-estimate-badge aria-live="polite" title="Based on the cost of completed runs with the same template, or the same agent and model.">
			{`Estimated cost${perRun ? " per run" : ""}: ${formatUsd(e.p50)} - ${formatUsd(e.p90)} (based on ${e.sampleSize} past run${e.sampleSize === 1 ? "" : "s"})`}
		</p>
	);
}
