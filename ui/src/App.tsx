import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { kindLabel, kindTip } from "./api/kinds.ts";
import { logout, requestPasswordReset } from "./api/auth.ts";
import type {
	AuthUser,
	PermissionCatalog,
	EventsResponse,
	Filters,
	InstancesResponse,
	Stats,
	UsersResponse,
	WorkflowDetailResponse,
	WorkflowNamesResponse,
	WorkflowRow,
	WorkflowsResponse,
	SyncClientsResponse,
	SyncEventsResponse,
	SyncRemoteWorkflowDetailResponse,
	SyncRemoteWorkflowsResponse,
	LinkedDevicesResponse,
	RemoteResourceActions,
} from "./api/types.ts";
import { EMPTY_FILTERS } from "./api/types.ts";
import { Bars } from "./components/Bars.tsx";
import { EventFeed } from "./components/EventFeed.tsx";
import { FilterBar, RANGE_MS } from "./components/FilterBar.tsx";
import { InstancesTable } from "./components/InstancesTable.tsx";
import { Kpi } from "./components/Kpi.tsx";
import { Pagination } from "./components/Pagination.tsx";
import { TargetMark } from "./components/TargetMark.tsx";
import { RemoteWorkflowsPanel } from "./components/RemoteWorkflowsPanel.tsx";
import { RemoteResourcesPanel } from "./components/RemoteResourcesPanel.tsx";
import { SyncClientsPanel } from "./components/SyncClientsPanel.tsx";
import { DevicesPanel } from "./components/DevicesPanel.tsx";
import { UsersPanel } from "./components/UsersPanel.tsx";
import { WorkflowDetail } from "./components/WorkflowDetail.tsx";
import { WorkflowsTable } from "./components/WorkflowsTable.tsx";
import { useApi } from "./hooks/useApi.ts";
import { hasPermission } from "./api/permissions.ts";
import { compactNumber, localToIso } from "./lib/format.ts";

const POLL_MS = 4000;
const DEFAULT_PAGE_SIZE = 25;

type DashboardTab = "activity" | "users" | "remote";

function ChangePasswordButton() {
	const rootRef = useRef<HTMLSpanElement>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [feedback, setFeedback] = useState<null | "sent" | "copied">(null);
	const [error, setError] = useState<string | null>(null);

	const closeMenu = useCallback(() => {
		setOpen(false);
		setError(null);
	}, []);

	useEffect(() => {
		if (!open) return;
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") closeMenu();
		}
		function onPointerDown(e: MouseEvent) {
			const root = rootRef.current;
			if (root && !root.contains(e.target as Node)) closeMenu();
		}
		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("mousedown", onPointerDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("mousedown", onPointerDown);
		};
	}, [open, closeMenu]);

	async function onSendEmail() {
		setBusy(true);
		setError(null);
		try {
			const res = await requestPasswordReset("email");
			if (!res.ok) {
				setError(res.error === "no_password" ? "This account has no password (Google sign-in only)." : "Could not send reset email.");
				return;
			}
			closeMenu();
			setFeedback("sent");
		} catch {
			setError("Could not send reset email.");
		} finally {
			setBusy(false);
		}
	}

	async function onCopyLink() {
		setBusy(true);
		setError(null);
		try {
			const res = await requestPasswordReset("link");
			if (!res.ok) {
				setError(res.error === "no_password" ? "This account has no password (Google sign-in only)." : "Could not get reset link.");
				return;
			}
			if (res.deliver !== "link") return;
			await navigator.clipboard.writeText(res.reset.resetUrl);
			closeMenu();
			setFeedback("copied");
		} catch {
			setError("Could not copy reset link.");
		} finally {
			setBusy(false);
		}
	}

	if (feedback === "sent") {
		return (
			<span className="topbar-pw-sent" title="Open the link in your email (or the server mail outbox in dev) to set a new password">
				Reset link sent
			</span>
		);
	}

	if (feedback === "copied") {
		return (
			<span className="topbar-pw-sent" title="Reset link expires in 1 hour">
				Link copied
			</span>
		);
	}

	return (
		<span ref={rootRef} className="topbar-pw-dropdown">
			<button
				type="button"
				className="btn btn--ghost btn--sm"
				disabled={busy}
				aria-expanded={open}
				aria-haspopup="menu"
				onClick={() => {
					setOpen((was) => !was);
					if (open) setError(null);
				}}
			>
				Change password
			</button>
			{open ? (
				<div className="topbar-pw-menu" role="menu" aria-label="Change password options">
					<button type="button" role="menuitem" className="topbar-pw-menuitem" disabled={busy} onClick={() => void onSendEmail()}>
						Send reset email
					</button>
					<button type="button" role="menuitem" className="topbar-pw-menuitem" disabled={busy} onClick={() => void onCopyLink()}>
						Copy reset link
					</button>
					{error ? (
						<p className="topbar-pw-error" role="alert">
							{error}
						</p>
					) : null}
				</div>
			) : null}
		</span>
	);
}

/**
 * The dashboard shell.
 *
 * The filter bar (date range, user, instance, agent, sandbox, workflow, kind)
 * maps 1:1 onto the query params of /api/stats, /api/events and /api/workflows
 * — filtering happens in SQL, so the KPIs, breakdowns, tables and feed below
 * always answer the same question.
 */
export function App({ user, catalog = null, onSignOut }: { user: AuthUser; catalog?: PermissionCatalog | null; onSignOut: () => void }) {
	const can = (permission: string) => hasPermission(user, permission);
	const canActivity = can("activity.read");
	const canUsers = can("users.manage");
	const canRemote = can("remote.read");
	const canCreateRemote = can("remote.workflows.create");
	const canAddRemoteStep = can("remote.workflows.steps.add");
	const canEditRemoteStep = can("remote.workflows.steps.edit");
	const canManageRemote = can("remote.workflows.manage");
	const canExecuteRemote = can("remote.workflows.execute");
	const resourceActions = (prefix: "remote.templates" | "remote.tcp-tools" | "remote.rci"): RemoteResourceActions => ({
		create: can(`${prefix}.create`),
		edit: can(`${prefix}.edit`),
		delete: can(`${prefix}.delete`),
		import: can(`${prefix}.import`),
		export: can(`${prefix}.export`),
	});
	const templateActions = resourceActions("remote.templates");
	const tcpActions = resourceActions("remote.tcp-tools");
	const rciActions = resourceActions("remote.rci");
	const canManageDevices = can("devices.manage");
	const canSeeRemoteArea = canRemote || canManageDevices;
	const availableTabs = useMemo<DashboardTab[]>(
		() => [
			...(canActivity ? ["activity" as const] : []),
			...(canUsers ? ["users" as const] : []),
			...(canSeeRemoteArea ? ["remote" as const] : []),
		],
		[canActivity, canUsers, canSeeRemoteArea],
	);
	const [tab, setTab] = useState<DashboardTab>(() => availableTabs[0] ?? "activity");
	useEffect(() => {
		if (!availableTabs.includes(tab)) setTab(availableTabs[0] ?? "activity");
	}, [availableTabs, tab]);
	const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS });
	// Workflow list paging. The list is unbounded — a busy fleet reports
	// thousands — so the dashboard asks for one page and the server never returns
	// more than that.
	const [page, setPage] = useState(0);
	const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

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

	// The same query minus the two params /api/workflows ignores. Keeping them
	// out matters now that the list is paged: selecting a workflow must not look
	// like a filter change and bounce the reader back to page 1.
	const listQuery = useMemo(() => {
		const p = new URLSearchParams(query);
		p.delete("workflow");
		p.delete("kind");
		const s = p.toString();
		return s ? `?${s}` : "";
	}, [query]);

	// A narrower list makes the current page meaningless — start over at the top.
	useEffect(() => {
		setPage(0);
	}, [listQuery]);

	const activityActive = tab === "activity" && canActivity;
	const { data: stats, error: statsErr } = useApi<Stats>(activityActive ? `/api/stats${query}` : null, POLL_MS);
	const { data: inst } = useApi<InstancesResponse>(activityActive ? "/api/instances" : null, POLL_MS);
	const { data: users } = useApi<UsersResponse>(activityActive ? "/api/users" : null, POLL_MS);
	// The unfiltered kind list keeps the dropdown stable while a kind filter is applied.
	const { data: allStats } = useApi<Stats>(activityActive ? "/api/stats" : null, POLL_MS * 4);
	const { data: evs } = useApi<EventsResponse>(activityActive ? `/api/events?limit=80${query ? query.replace("?", "&") : ""}` : null, POLL_MS);
	// The workflow-centric views. /api/workflows ignores the workflow/kind
	// filters server-side, so the list stays stable while a workflow is
	// selected; the detail below is what narrows.
	const wfQuery = `${listQuery ? `${listQuery}&` : "?"}limit=${pageSize}&offset=${page * pageSize}`;
	const { data: wfs } = useApi<WorkflowsResponse>(activityActive ? `/api/workflows${wfQuery}` : null, POLL_MS);
	// The dropdown needs every match, not just the page on screen — that list is
	// id+name only, so it stays cheap.
	const { data: wfNames } = useApi<WorkflowNamesResponse>(activityActive ? `/api/workflows/names${listQuery}` : null, POLL_MS * 4);
	const { data: wfDetail, error: wfDetailErr } = useApi<WorkflowDetailResponse>(
		activityActive && filters.workflow ? `/api/workflows/${filters.workflow}` : null,
		POLL_MS,
	);

	const [syncRefreshKey, setSyncRefreshKey] = useState(0);
	const syncRefresh = useCallback(() => setSyncRefreshKey((k) => k + 1), []);
	const remoteActive = tab === "remote" && canSeeRemoteArea;
	const syncQuery = remoteActive && syncRefreshKey ? `?_=${syncRefreshKey}` : "";
	const { data: syncClients } = useApi<SyncClientsResponse>(
		remoteActive && canRemote ? `/api/sync/clients${syncQuery}` : null,
		POLL_MS,
	);
	const { data: linkedDevices } = useApi<LinkedDevicesResponse>(
		remoteActive && canManageDevices ? `/api/device-links/devices${syncQuery}` : null,
		POLL_MS,
	);
	const { data: syncWorkflows } = useApi<SyncRemoteWorkflowsResponse>(
		remoteActive && canRemote ? `/api/sync/remote-workflows${syncQuery}` : null,
		POLL_MS,
	);
	const [selectedRemoteId, setSelectedRemoteId] = useState("");
	const syncDetailPath =
		remoteActive && canRemote && selectedRemoteId
			? `/api/sync/remote-workflows/${encodeURIComponent(selectedRemoteId)}${syncQuery}`
			: null;
	const { data: syncWorkflowDetail } = useApi<SyncRemoteWorkflowDetailResponse>(syncDetailPath, POLL_MS);
	const syncEventsPath =
		remoteActive && canRemote && selectedRemoteId
			? `/api/sync/events?remote_id=${encodeURIComponent(selectedRemoteId)}&limit=30`
			: null;
	const { data: syncEvents } = useApi<SyncEventsResponse>(syncEventsPath, POLL_MS);

	// The list is live: workflows can drop out of range under a reader parked on
	// the last page. Fall back to the new last page instead of showing nothing.
	const total = wfs?.total ?? 0;
	useEffect(() => {
		const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
		setPage((p) => Math.min(p, lastPage));
	}, [total, pageSize]);

	const kinds = (allStats?.byKind ?? stats?.byKind ?? []).map((r) => r.kind);

	// The filter-bar workflow options come from the id+name list, NOT the page on
	// screen — a dropdown that only offered the visible 25 would be a trap. Keep
	// the selected one present even when the date/user filters exclude it.
	const workflowOptions = useMemo<Pick<WorkflowRow, "workflowId" | "name">[]>(() => {
		const list = wfNames?.workflows ?? [];
		if (filters.workflow && !list.some((w) => w.workflowId === filters.workflow)) {
			return [...list, { workflowId: filters.workflow, name: wfDetail?.workflow.name ?? filters.workflow.slice(0, 8) }];
		}
		return list;
	}, [wfNames, filters.workflow, wfDetail]);

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
						{user.email}
						{" · "}
						{`live · refresh ${POLL_MS / 1000}s`}
					</span>
					<ChangePasswordButton />
					<button type="button" className="btn btn--ghost btn--sm topbar-signout" onClick={() => void logout().then(onSignOut)}>
						Sign out
					</button>
				</div>
			</header>

			{user.usesDefaultPassword ? (
				<div className="default-pw-banner">
					The seeded admin account still uses the published default password —{" "}
					<ChangePasswordButton /> or invite a replacement admin below.
				</div>
			) : null}

			<main className="shell">
				<nav className="dash-tabs" aria-label="Dashboard sections">
					{canActivity ? <button
						type="button"
						className={`dash-tab${tab === "activity" ? " dash-tab--active" : ""}`}
						onClick={() => setTab("activity")}
					>
						Activity
					</button> : null}
					{canUsers ? <button
						type="button"
						className={`dash-tab${tab === "users" ? " dash-tab--active" : ""}`}
						onClick={() => setTab("users")}
					>
						Users
					</button> : null}
					{canSeeRemoteArea ? <button
						type="button"
						className={`dash-tab${tab === "remote" ? " dash-tab--active" : ""}`}
						onClick={() => setTab("remote")}
					>
						Remote control
					</button> : null}
				</nav>

				{tab === "activity" ? (
					<>
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
							<Pagination
								total={wfs ? wfs.total : null}
								page={page}
								pageSize={pageSize}
								shown={wfs?.workflows.length ?? 0}
								onPage={setPage}
								onPageSize={(n) => {
									setPageSize(n);
									setPage(0);
								}}
								label="workflows"
							/>
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

					</>
				) : tab === "users" ? (
					<>
						<h1 className="page-title">Users</h1>
						<p className="page-sub">Manage dashboard accounts, invitations, roles and permissions.</p>
						<UsersPanel currentUser={user} catalog={catalog} />
					</>
				) : (
					<>
						<h1 className="page-title">Remote control</h1>
						<p className="page-sub">
							Sync clients and create or manage workflows on connected Target machines. Commands are queued for the sync agent to poll.
						</p>

						{canRemote ? <div className="panel" id="sync-clients">
							<h2>Sync clients</h2>
							<div className="panel-note">Target machines registered for remote control. Availability comes from client heartbeats.</div>
							<SyncClientsPanel clients={syncClients?.clients ?? null} />
						</div> : null}

						{canManageDevices ? <div className="panel" id="linked-devices">
							<h2>Linked devices</h2>
							<DevicesPanel devices={linkedDevices?.devices ?? null} onChanged={syncRefresh} />
						</div> : null}

						{canRemote ? <div className="panel" id="sync-remote-workflows">
							<h2>Remote workflows</h2>
							<div className="panel-note">Create and control workflows on connected clients.</div>
							<RemoteWorkflowsPanel
								clients={syncClients?.clients ?? null}
								workflows={syncWorkflows?.remote_workflows ?? null}
								detail={syncWorkflowDetail ?? null}
								events={syncEvents?.events ?? null}
								selectedId={selectedRemoteId}
								onSelect={setSelectedRemoteId}
								onRefresh={syncRefresh}
								permissions={{
									create: canCreateRemote,
									addStep: canAddRemoteStep,
									editStep: canEditRemoteStep,
									manage: canManageRemote,
									execute: canExecuteRemote,
								}}
								onOpenInActivity={(localId) => {
									setTab("activity");
									setFilters((f) => ({ ...f, workflow: localId }));
								}}
							/>
						</div> : null}

						{canRemote ? <div className="panel" id="sync-remote-resources">
							<h2>Remote resources</h2>
							<div className="panel-note">Templates, TCP tools and RCI resource sets are mirrored per Target client and applied through the sync queue.</div>
							<RemoteResourcesPanel
								clients={syncClients?.clients ?? null}
								templateActions={templateActions}
								tcpActions={tcpActions}
								rciActions={rciActions}
								onRefresh={syncRefresh}
							/>
						</div> : null}
					</>
				)}
			</main>
		</>
	);
}
