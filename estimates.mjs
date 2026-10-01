/**
 * Pre-run cost estimates from historical spend. Pure functions over plain data:
 * the SQL that gathers the history lives in db.mjs (`estimateHistory`).
 *
 * WHAT TIES A PAST RUN TO A TEMPLATE
 *
 * Until this feature, nothing did. A template is applied at creation time
 * (`POST /api/sync/remote-workflows` with `template_id`, or `.../steps/from-
 * template`) by turning its steps into `step.add` commands for the hub; the id
 * itself was thrown away. The hub's events carry no template id either, so a
 * finished run looked like any other workflow. The only other trace was the
 * step TEXT, which is editable and therefore not a reliable key.
 *
 * So `remote_workflows.template_id` now records the template a workflow was
 * CREATED from (series clones inherit it from the previous run). That link is
 * reliable but only exists for runs created after the column did; older runs
 * have none. Hence three bases, narrowest first, each used only when it has
 * enough history:
 *
 *   template    runs created from the same template (reliable, newest data only)
 *   agent_model runs by the same runner on the same model (model is null in
 *               today's hub payloads, so this applies once the hub reports it)
 *   agent       runs by the same runner (always available)
 *
 * Grouping by agent/model rather than by step text avoids pretending that two
 * unrelated workflows with similar wording cost the same.
 */

/** Below this many past runs the answer is "insufficient_data", not a guess. */
export const MIN_SAMPLES = 3;

/**
 * Percentile by linear interpolation between closest ranks (the "R-7" method
 * most spreadsheets use): sort ascending, rank = (n - 1) * p, and interpolate
 * between the values at floor(rank) and ceil(rank).
 *   percentile([1, 2, 3, 4], 0.5) = 2.5      percentile([10, 20, 30], 0.9) = 28
 */
export function percentile(values, p) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (sorted.length - 1) * p;
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/**
 * Cost of each step from one session's cumulative costs, in time order: the
 * delta between consecutive snapshots (the first is measured from zero).
 * Clamped at 0, because a drop means the transcript was compacted and the
 * cumulative figure restarted lower — not that the step refunded money.
 */
export function stepCostDeltas(cumulativeCosts) {
	const deltas = [];
	let previous = 0;
	for (const cost of cumulativeCosts) {
		deltas.push(Math.max(0, cost - previous));
		previous = cost;
	}
	return deltas;
}

/**
 * @param history  `[{workflowId, agent, model, templateId, steps, totalCostUsd, stepCosts}]`
 *                 completed workflows with at least one priced session
 * @param query    `{templateId?, agent?, model?, steps?}`
 * @returns `{p50, p90, sampleSize, basis, perStep, scaledBy}` or `{status: "insufficient_data", sampleSize}`
 *          where `sampleSize` of the failure is that of the broadest basis tried.
 */
export function estimate(history, { templateId = null, agent = null, model = null, steps = null } = {}) {
	const candidates = [];
	if (templateId) candidates.push(["template", history.filter((h) => h.templateId === templateId)]);
	if (agent && model) candidates.push(["agent_model", history.filter((h) => h.agent === agent && h.model === model)]);
	if (agent) candidates.push(["agent", history.filter((h) => h.agent === agent)]);

	let broadest = 0;
	for (const [basis, group] of candidates) {
		broadest = group.length;
		if (group.length < MIN_SAMPLES) continue;
		const totals = group.map((h) => h.totalCostUsd);
		const stepCosts = group.flatMap((h) => h.stepCosts);
		// `steps` is an optional scaling factor: a run planned with more steps
		// than the typical past run costs proportionally more. Applied only when
		// both the request and the history know a step count, as steps / median
		// historical steps; otherwise the raw percentiles stand.
		const knownSteps = group.map((h) => h.steps).filter((n) => n > 0);
		const medianSteps = percentile(knownSteps, 0.5);
		const scaledBy = steps > 0 && medianSteps > 0 ? steps / medianSteps : null;
		const scale = scaledBy ?? 1;
		return {
			p50: percentile(totals, 0.5) * scale,
			p90: percentile(totals, 0.9) * scale,
			sampleSize: group.length,
			basis,
			perStep: stepCosts.length ? { p50: percentile(stepCosts, 0.5), p90: percentile(stepCosts, 0.9) } : null,
			scaledBy,
		};
	}
	return { status: "insufficient_data", sampleSize: broadest };
}
