import { KIND_INFO, kindLabel, kindTip } from "../api/kinds.ts";
import type { Filters, InstanceRow, RangeId, UserRow, WorkflowRow } from "../api/types.ts";
import { EMPTY_FILTERS } from "../api/types.ts";
import { shortId } from "../lib/format.ts";

export const RANGES: { id: RangeId; label: string }[] = [
	{ id: "all", label: "All time" },
	{ id: "1h", label: "Last hour" },
	{ id: "24h", label: "Last 24 hours" },
	{ id: "7d", label: "Last 7 days" },
	{ id: "30d", label: "Last 30 days" },
	{ id: "custom", label: "Custom range..." },
];

export const RANGE_MS: Record<string, number> = {
	"1h": 3600e3,
	"24h": 86400e3,
	"7d": 7 * 86400e3,
	"30d": 30 * 86400e3,
};

/** One-line explanations for every filter, shown as a tooltip on its label. */
const FILTER_TIPS = {
	range: "Only count events received inside this time window. Pick 'Custom range...' to type exact start/end dates.",
	from: "Window start (your local time). Events received before this moment are hidden.",
	to: "Window end (your local time). Events received after this moment are hidden.",
	user: "Only show activity from this Target user (the name configured on the reporting instance).",
	instance: "Only show activity reported by this machine/instance. One user can run several instances.",
	agent:
		"Only show workflows whose steps run on this agent CLI (free-code, claude…). Heartbeats belong to no workflow, so they drop out while this filter is on.",
	sandbox:
		"Only show workflows running in this containment: 'local' = directly on the user's machine, 'docker' = inside a container. Heartbeats belong to no workflow, so they drop out while this filter is on.",
	workflow: "Focus on a single workflow: its steps, events and token usage.",
	kind: "Only show one type of event (e.g. 'Step finished'). Hover any event badge in the feed to learn what each kind means.",
	clear: "Remove every active filter and show all events again.",
};

/** Filter label with a dotted-hint '?' that explains the filter on hover. */
function TipLabel({ htmlFor, text, tip }: { htmlFor: string; text: string; tip: string }) {
	return (
		<label className="lbl lbl--tip" htmlFor={htmlFor} title={tip}>
			{text}
			<span className="tip-hint" aria-hidden="true">
				?
			</span>
		</label>
	);
}

interface FilterBarProps {
	filters: Filters;
	onChange: (next: Filters) => void;
	users: UserRow[];
	instances: InstanceRow[];
	workflows: Pick<WorkflowRow, "workflowId" | "name">[];
	kinds: string[];
	agents: string[];
	sandboxes: string[];
	/** Events matching the current filters, or null while loading. */
	matched: number | null;
}

export function FilterBar({ filters, onChange, users, instances, workflows, kinds, agents, sandboxes, matched }: FilterBarProps) {
	const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
	const active =
		filters.range !== "all" ||
		Boolean(filters.user || filters.instance || filters.workflow || filters.kind || filters.agent || filters.sandbox || filters.from || filters.to);

	return (
		<div className="panel">
			<h2>Filters</h2>
			<div className="filters">
				<div className="field">
					<TipLabel htmlFor="f-range" text="Date range" tip={FILTER_TIPS.range} />
					<select
						id="f-range"
						className="select"
						value={filters.range}
						onChange={(e) => set({ range: e.target.value as RangeId, from: "", to: "" })}
					>
						{RANGES.map((r) => (
							<option key={r.id} value={r.id}>
								{r.label}
							</option>
						))}
					</select>
				</div>

				{filters.range === "custom" ? (
					<div className="field">
						<TipLabel htmlFor="f-from" text="From" tip={FILTER_TIPS.from} />
						<input
							id="f-from"
							className="input"
							type="datetime-local"
							value={filters.from}
							onChange={(e) => set({ from: e.target.value })}
						/>
					</div>
				) : null}

				{filters.range === "custom" ? (
					<div className="field">
						<TipLabel htmlFor="f-to" text="To" tip={FILTER_TIPS.to} />
						<input id="f-to" className="input" type="datetime-local" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
					</div>
				) : null}

				<div className="field">
					<TipLabel htmlFor="f-user" text="User" tip={FILTER_TIPS.user} />
					<select id="f-user" className="select" value={filters.user} onChange={(e) => set({ user: e.target.value })}>
						<option value="">All users</option>
						{users
							.filter((u) => u.name !== "anonymous")
							.map((u) => (
								<option key={u.name} value={u.name}>
									{`${u.name} (${u.events} events)`}
								</option>
							))}
					</select>
				</div>

				<div className="field">
					<TipLabel htmlFor="f-inst" text="Instance" tip={FILTER_TIPS.instance} />
					<select id="f-inst" className="select" value={filters.instance} onChange={(e) => set({ instance: e.target.value })}>
						<option value="">All instances</option>
						{instances.map((i) => (
							<option key={i.instanceId} value={i.instanceId}>
								{`${shortId(i.instanceId)}${i.displayName ? ` · ${i.displayName}` : ""}`}
							</option>
						))}
					</select>
				</div>

				<div className="field">
					<TipLabel htmlFor="f-agent" text="Agent" tip={FILTER_TIPS.agent} />
					<select id="f-agent" className="select" value={filters.agent} onChange={(e) => set({ agent: e.target.value })}>
						<option value="">All agents</option>
						{agents.map((a) => (
							<option key={a} value={a}>
								{a}
							</option>
						))}
					</select>
				</div>

				<div className="field">
					<TipLabel htmlFor="f-sandbox" text="Sandbox" tip={FILTER_TIPS.sandbox} />
					<select id="f-sandbox" className="select" value={filters.sandbox} onChange={(e) => set({ sandbox: e.target.value })}>
						<option value="">All sandboxes</option>
						{sandboxes.map((s) => (
							<option key={s} value={s}>
								{s === "host" ? "local (host)" : s}
							</option>
						))}
					</select>
				</div>

				<div className="field">
					<TipLabel htmlFor="f-workflow" text="Workflow" tip={FILTER_TIPS.workflow} />
					<select id="f-workflow" className="select" value={filters.workflow} onChange={(e) => set({ workflow: e.target.value })}>
						<option value="">All workflows</option>
						{workflows.map((w) => (
							<option key={w.workflowId} value={w.workflowId}>
								{`${w.name} · ${shortId(w.workflowId)}`}
							</option>
						))}
					</select>
				</div>

				<div className="field">
					<TipLabel htmlFor="f-kind" text="Event kind" tip={FILTER_TIPS.kind} />
					<select id="f-kind" className="select" value={filters.kind} onChange={(e) => set({ kind: e.target.value })}>
						<option value="">All kinds</option>
						{kinds.map((k) => (
							<option key={k} value={k} title={kindTip(k)}>
								{KIND_INFO[k] ? `${kindLabel(k)} (${k})` : k}
							</option>
						))}
					</select>
				</div>

				<div className="field">
					<span className="lbl"> </span>
					<button type="button" className="btn" title={FILTER_TIPS.clear} disabled={!active} onClick={() => onChange({ ...EMPTY_FILTERS })}>
						Clear filters
					</button>
				</div>
			</div>

			<div className="filter-summary">
				{matched == null ? (
					"Loading..."
				) : (
					<>
						<strong>{String(matched)}</strong>
						{` event${matched === 1 ? "" : "s"} match the current filters`}
					</>
				)}
			</div>
		</div>
	);
}
