import { useMemo, useState } from "react";
import { kindLabel, kindTip } from "./api/kinds.ts";
import type {
	EventsResponse,
	Filters,
	InstancesResponse,
	Stats,
	UsersResponse,
	WorkflowDetailResponse,
	WorkflowRow,
	WorkflowsResponse,
} from "./api/types.ts";
import { EMPTY_FILTERS } from "./api/types.ts";
import { Bars } from "./components/Bars.tsx";
import { EventFeed } from "./components/EventFeed.tsx";
import { FilterBar, RANGE_MS } from "./components/FilterBar.tsx";
import { InstancesTable } from "./components/InstancesTable.tsx";
import { Kpi } from "./components/Kpi.tsx";
import { TargetMark } from "./components/TargetMark.tsx";
import { WorkflowDetail } from "./components/WorkflowDetail.tsx";
import { WorkflowsTable } from "./components/WorkflowsTable.tsx";
import { useApi } from "./hooks/useApi.ts";
import { compactNumber, localToIso } from "./lib/format.ts";

const POLL_MS = 4000;

/**
 * The dashboard shell.
 *
 * The filter bar (date range, user, instance, agent, sandbox, workflow, kind)
 * maps 1:1 onto the query params of /api/stats, /api/events and /api/workflows
 * — filtering happens in SQL, so the KPIs, breakdowns, tables and feed below
 * always answer the same question.
 */
export function App() {
	const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS });

	// The resolved query string every panel shares. Preset ranges re-anchor at
	// query-build time via Date.now(); the poll keeps them sliding forward.
	const query = useMemo(() => {
		const p = new URLSearchParams();
		const presetMs = RANGE_MS[filters.range];
		if (filters.range !== "all" && filters.range !== "custom" && presetMs) {
			p.set("from", new Date(Date.now() - presetMs).toISOString());
		}
		if (filters.range === "custom") {
			const from = localToIso(filters.from);
			const to = localToIso(filters.to);
			if (from) p.set("from", from);
			if (to) p.set("to", to);
		}
		if (filters.user) p.set("user", filters.user);
		if (filters.instance) p.set("instance", filters.instance);
		if (filters.workflow) p.set("workflow", filters.workflow);
		if (filters.kind) p.set("kind", filters.kind);
		if (filters.agent) p.set("agent", filters.agent);
		if (filters.sandbox) p.set("sandbox", filters.sandbox);
		const s = p.toString();
		return s ? `?${s}` : "";
	}, [filters]);

	const { data: stats, error: statsErr } = useApi<Stats>(`/api/stats${query}`, POLL_MS);
	const { data: inst } = useApi<InstancesResponse>("/api/instances", POLL_MS);
	const { data: users } = useApi<UsersResponse>("/api/users", POLL_MS);
	// The unfiltered kind list keeps the dropdown stable while a kind filter is applied.
	const { data: allStats } = useApi<Stats>("/api/stats", POLL_MS * 4);
	const { data: evs } = useApi<EventsResponse>(`/api/events?limit=80${query ? query.replace("?", "&") : ""}`, POLL_MS);
	// The workflow-centric views. /api/workflows ignores the workflow/kind
	// filters server-side, so the list stays stable while a workflow is
	// selected; the detail below is what narrows.
	const { data: wfs } = useApi<WorkflowsResponse>(`/api/workflows${query}`, POLL_MS);
	const { data: wfDetail, error: wfDetailErr } = useApi<WorkflowDetailResponse>(
		filters.workflow ? `/api/workflows/${filters.workflow}` : null,
		POLL_MS,
	);

	const kinds = (allStats?.byKind ?? stats?.byKind ?? []).map((r) => r.kind);

	// The filter-bar workflow options come from the list; keep the selected one
	// present even when the date/user filters currently exclude it.
	const workflowOptions = useMemo<Pick<WorkflowRow, "workflowId" | "name">[]>(() => {
		const list = wfs?.workflows ?? [];
		if (filters.workflow && !list.some((w) => w.workflowId === filters.workflow)) {
			return [...list, { workflowId: filters.workflow, name: wfDetail?.workflow.name ?? filters.workflow.slice(0, 8) }];
		}
		return list;
	}, [wfs, filters.workflow, wfDetail]);

	const selectWorkflow = (id: string) => setFilters((f) => ({ ...f, workflow: id }));

	return (
		<>
			<header className="topbar">
				<div className="topbar-inner">
					<div className="brand">
						<span className="mark">
							<TargetMark />
						</span>
						<span className="name">The Target Project</span>
						<span className="sub">· Report Dashboard</span>
					</div>
					<span className="live">
						<span className="dot" />
						{`live · refresh ${POLL_MS / 1000}s`}
					</span>
				</div>
			</header>

			<main className="shell">
				<h1 className="page-title">Activity across the fleet</h1>
				<p className="page-sub">
					Workflow runs, steps, token usage and errors reported by every Target instance pointed at this server.
				</p>

				{statsErr ? <div className="err">{`API error: ${statsErr}`}</div> : null}

				<FilterBar
					filters={filters}
					onChange={setFilters}
					users={users?.users ?? []}
					instances={inst?.instances ?? []}
					workflows={workflowOptions}
					kinds={kinds}
					agents={allStats?.agents ?? stats?.agents ?? []}
					sandboxes={allStats?.sandboxes ?? stats?.sandboxes ?? []}
					matched={stats ? stats.totalEvents : null}
				/>

				<div className="kpis">
					<Kpi label="Events" value={stats ? stats.totalEvents.toLocaleString() : "..."} tone="accent" />
					<Kpi label="Instances" value={stats ? stats.totalInstances : "..."} />
					<Kpi label="Workflows" value={stats ? stats.workflows : "..."} />
					<Kpi label="Step failures" value={stats ? stats.failures : "..."} tone={stats && stats.failures ? "danger" : ""} />
					{/* Input is the FULL input — new + cache creation + cache read — which
					    is what the operator's client reports as "in". The compact hint
					    below each is the client's own abbreviation, so the two can be
					    read against each other without arithmetic. */}
					<Kpi
						label="Input tokens"
						value={stats ? stats.usage.inputTokens.toLocaleString() : "..."}
						hint={stats ? compactNumber(stats.usage.inputTokens) : null}
					/>
					<Kpi
						label="Output tokens"
						value={stats ? stats.usage.outputTokens.toLocaleString() : "..."}
						hint={stats ? compactNumber(stats.usage.outputTokens) : null}
					/>
				</div>

				<div className="panel">
					<h2>Workflows</h2>
					<WorkflowsTable workflows={wfs?.workflows ?? null} selectedId={filters.workflow} onSelect={selectWorkflow} />
					<div className="panel-note">Click a workflow to see its steps and events. Honours the filters above.</div>
				</div>

				{filters.workflow ? (
					<div className="panel wf-detail">
						<h2>Workflow detail</h2>
						<WorkflowDetail detail={wfDetail} error={wfDetailErr} onClose={() => selectWorkflow("")} />
					</div>
				) : null}

				<div className="panel">
					<h2>Reporting instances (the fleet)</h2>
					<InstancesTable instances={inst?.instances ?? null} />
				</div>

				<div className="grid">
					<div className="panel">
						<h2>Events by kind</h2>
						<Bars rows={stats?.byKind ?? []} keyName="kind" valName="count" keyLabel={kindLabel} keyTip={kindTip} />
						<div className="panel-note">Honours the filters above.</div>
					</div>
					<div className="panel">
						<h2>Client versions</h2>
						<Bars rows={stats?.byVersion ?? []} keyName="version" valName="count" />
					</div>
				</div>

				<div style={{ height: "var(--space-6)" }} />

				<div className="panel">
					<h2>Live event feed</h2>
					<EventFeed events={evs?.events ?? null} />
				</div>
			</main>
		</>
	);
}
