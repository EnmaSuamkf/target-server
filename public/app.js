/**
 * Target report dashboard - a React SPA with NO build step and NO CDN.
 * React/ReactDOM are vendored locally (public/vendor), and this file uses
 * React.createElement directly (aliased `h`) instead of JSX, so nothing has to
 * be transpiled in the browser. Polls the server's JSON API and renders KPIs,
 * the reporting fleet, breakdowns and a live event feed.
 *
 * The filter bar (date range, user, instance, kind) maps 1:1 onto the query
 * params of /api/stats and /api/events - filtering is done in SQL, so the
 * KPIs, breakdowns and feed below always answer the same question.
 */
const { useState, useEffect, useCallback, useMemo } = React;
const h = React.createElement;

const POLL_MS = 4000;

const RANGES = [
	{ id: "all", label: "All time" },
	{ id: "1h", label: "Last hour" },
	{ id: "24h", label: "Last 24 hours" },
	{ id: "7d", label: "Last 7 days" },
	{ id: "30d", label: "Last 30 days" },
	{ id: "custom", label: "Custom range..." },
];
const RANGE_MS = { "1h": 3600e3, "24h": 86400e3, "7d": 7 * 86400e3, "30d": 30 * 86400e3 };

function useApi(path, intervalMs) {
	const [data, setData] = useState(null);
	const [error, setError] = useState(null);
	const load = useCallback(async () => {
		if (!path) {
			setData(null);
			setError(null);
			return;
		}
		try {
			const res = await fetch(path);
			if (!res.ok) throw new Error(`${path} → ${res.status}`);
			setData(await res.json());
			setError(null);
		} catch (e) {
			setError(String(e.message || e));
		}
	}, [path]);
	useEffect(() => {
		load();
		if (!intervalMs) return;
		const t = setInterval(load, intervalMs);
		return () => clearInterval(t);
	}, [load, intervalMs]);
	return { data, error };
}

function timeAgo(iso) {
	if (!iso) return "-";
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (s < 60) return `${Math.floor(s)}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Event kinds, translated for humans: a short Title Case label everywhere the
 * kind is displayed, plus a one-line explanation shown as a tooltip. The raw
 * kind stays visible as secondary mono text (and in `title`) so filters and
 * the API docs keep matching what you see. Unknown future kinds degrade to the
 * raw string with a generic tooltip.
 */
const KIND_INFO = {
	"workflow.created": {
		label: "Workflow created",
		tip: "A user created a new workflow (its steps are reported as 'Step added'). Carries the agent and sandbox it runs with.",
	},
	"workflow.updated": {
		label: "Workflow updated",
		tip: "The workflow's name, agent or sandbox changed — also sent when the hub starts, to re-announce the workflows it knows.",
	},
	"workflow.status_changed": {
		label: "Workflow status changed",
		tip: "The workflow moved to a new state (running, completed, failed, cancelled...).",
	},
	"workflow.failed": {
		label: "Workflow failed",
		tip: "The workflow run aborted with an error.",
	},
	"step.added": {
		label: "Step added",
		tip: "A step was added to the workflow plan. These events let the dashboard draw the workflow's structure.",
	},
	"step.started": {
		label: "Step started",
		tip: "A workflow step began executing on the user's machine.",
	},
	"step.done": {
		label: "Step finished",
		tip: "A step finished successfully. Carries how long it took and how many tokens it used.",
	},
	"step.failed": {
		label: "Step failed",
		tip: "A step ended with an error (the message travels in the event payload).",
	},
	"step.judged": {
		label: "Step reviewed",
		tip: "An automated review checked the step's result against its acceptance criteria and passed or failed it.",
	},
	"usage.snapshot": {
		label: "Token usage",
		tip: "Periodic counters of the tokens the model consumed in the current step (input, output, cache).",
	},
	"conversation.snapshot": {
		label: "Conversation snapshot",
		tip: "A privacy-safe summary of the ongoing conversation: turn count and mode only - message content is never sent.",
	},
	heartbeat: {
		label: "Heartbeat",
		tip: "An 'I'm alive' ping each instance sends every 30 seconds while the hub runs. Powers the 'Last seen' column.",
	},
};

function kindLabel(kind) {
	return KIND_INFO[kind]?.label ?? kind;
}

function kindTip(kind) {
	return KIND_INFO[kind]?.tip ?? `Raw event kind "${kind}" - newer than this dashboard, no description yet.`;
}

/** Kind badge: friendly label + explanation tooltip, raw kind kept in title. */
function KindBadge({ kind }) {
	return h("span", { className: badgeClass(kind), title: `${kind} - ${kindTip(kind)}` }, kindLabel(kind));
}

/** Event kind → the badge tone the hub would give that state. */
function badgeClass(kind) {
	if (kind === "step.failed" || kind === "workflow.failed") return "badge badge--danger";
	if (kind === "step.done" || kind === "step.judged" || kind === "workflow.completed") return "badge badge--success";
	if (kind.startsWith("step") || kind.startsWith("workflow")) return "badge badge--info";
	if (kind.startsWith("usage") || kind.startsWith("conversation")) return "badge badge--warn";
	return "badge badge--neutral"; // heartbeat and anything new
}

/** Token counts, compact: 15234 → "15k", 464 → "464". */
function compactTokens(n) {
	if (n == null) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return String(n);
}

/** Step durations: under a minute in seconds, over it as "2m 5s". */
function formatDuration(ms) {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Agent badge: the CLI that runs the workflow's steps (free-code, claude…). */
function AgentBadge({ agent }) {
	if (!agent) return h("span", { className: "badge badge--neutral", title: "This workflow never reported its agent (created before the hub reported it)" }, "unknown");
	return h("span", { className: "badge badge--agent", title: `Runs on the ${agent} agent` }, agent);
}

/** Sandbox badge: where the agent runs — "local" (host) or docker + image. */
function SandboxBadge({ sandbox, image }) {
	if (!sandbox) return h("span", { className: "badge badge--neutral", title: "This workflow never reported its sandbox (created before the hub reported it)" }, "unknown");
	if (sandbox === "docker")
		return h("span", { className: "badge badge--info", title: image ? `Runs inside the docker image ${image}` : "Runs inside docker" }, "docker");
	return h("span", { className: "badge badge--neutral", title: "Runs directly on the user's machine (no container)" }, "local");
}

/** Workflow/step run state → the badge tone the hub gives that state. */
function statusBadge(status) {
	const tones = {
		running: "badge badge--info",
		completed: "badge badge--success",
		done: "badge badge--success",
		failed: "badge badge--danger",
		draft: "badge badge--neutral",
		pending: "badge badge--neutral",
	};
	return h(
		"span",
		{ className: tones[status] ?? "badge badge--neutral" },
		status === "running" ? h("span", { className: "badge__dot" }) : null,
		status ?? "unknown",
	);
}

function Kpi({ label, value, tone }) {
	return h("div", { className: `kpi ${tone || ""}` }, h("div", { className: "label" }, label), h("div", { className: "value" }, value));
}

function Bars({ rows, keyName, valName, keyLabel = null, keyTip = null }) {
	if (!rows || rows.length === 0) return h("div", { className: "empty" }, "No data for this filter.");
	const max = Math.max(1, ...rows.map((r) => r[valName]));
	return h(
		"div",
		{ className: "bars" },
		rows.map((r, i) =>
			h(
				"div",
				{ className: "bar-row", key: i },
				h("span", { className: "k", title: keyTip ? keyTip(r[keyName]) : (r[keyName] ?? "unknown") }, keyLabel ? keyLabel(r[keyName]) : (r[keyName] ?? "unknown")),
				h("span", { className: "bar-track" }, h("span", { className: "bar-fill", style: { width: `${(r[valName] / max) * 100}%` } })),
				h("span", { className: "n" }, r[valName]),
			),
		),
	);
}

function InstancesTable({ instances }) {
	if (!instances || instances.length === 0) return h("div", { className: "empty" }, "No instances have reported yet.");
	return h(
		"table",
		null,
		h("thead", null, h("tr", null, ["Instance", "User", "Version", "Events", "Last seen"].map((c) => h("th", { key: c }, c)))),
		h(
			"tbody",
			null,
			instances.map((i) =>
				h(
					"tr",
					{ key: i.instanceId },
					h("td", { className: "mono" }, i.instanceId.slice(0, 8)),
					h("td", null, i.displayName || h("span", { className: "badge badge--neutral" }, "anonymous")),
					h("td", { className: "mono" }, i.version || "-"),
					h("td", { className: "mono" }, i.eventsCount),
					h("td", { className: "mono" }, timeAgo(i.lastSeenAt)),
				),
			),
		),
	);
}

function EventFeed({ events }) {
	if (!events || events.length === 0) return h("div", { className: "empty" }, "No events match these filters.");
	return h(
		"div",
		{ className: "feed" },
		events.map((e) =>
			h(
				"div",
				{ className: "event", key: e.id },
				h("span", { className: "when", title: e.receivedAt }, timeAgo(e.receivedAt)),
				h(
					"div",
					{ className: "body" },
					h(KindBadge, { kind: e.kind }),
					h("span", { className: "kind-raw" }, e.kind),
					h(
						"div",
						{ className: "meta" },
						`${e.instanceId.slice(0, 8)}${e.workflowId ? ` · wf ${e.workflowId.slice(0, 8)}` : ""}`,
					),
					e.data && Object.keys(e.data).length > 0 ? h("div", { className: "data" }, JSON.stringify(e.data)) : null,
				),
			),
		),
	);
}

/** Steps cell: `done/total` plus the hub's thin progress bar. */
function StepsProgress({ workflow: w }) {
	// The server derives `stepsTotal` from the plan events AND the largest
	// order_index seen, so pending steps and pre-step.added workflows count
	// too. The local max() is just a fallback for older servers.
	const total = w.stepsTotal ?? Math.max(w.stepsAdded, w.stepsStarted, w.stepsDone + w.stepsFailed);
	const pct = total > 0 ? Math.min(100, Math.round((w.stepsDone / total) * 100)) : 0;
	const tone = w.stepsFailed > 0 ? "progress__fill--failed" : w.status === "running" ? "progress__fill--running" : "";
	return h(
		"div",
		{ className: "steps-cell" },
		h("span", { className: "mono steps-n" }, `${w.stepsDone}/${total}`),
		h("span", { className: "progress" }, h("span", { className: `progress__fill ${tone}`.trimEnd(), style: { width: `${pct}%` } })),
	);
}

/** The workflow-centric fleet view: one row per reported workflow. */
function WorkflowsTable({ workflows, selectedId, onSelect }) {
	if (!workflows || workflows.length === 0) return h("div", { className: "empty" }, "No workflows reported in this range.");
	return h(
		"table",
		{ className: "wf-table" },
		h("thead", null, h("tr", null, ["Workflow", "User", "Agent", "Sandbox", "Status", "Steps", "Tokens (in / out)", "Last activity"].map((c) => h("th", { key: c }, c)))),
		h(
			"tbody",
			null,
			workflows.map((w) =>
				h(
					"tr",
					{
						key: w.workflowId,
						className: `wf-row${w.workflowId === selectedId ? " wf-row--selected" : ""}`,
						title: w.workflowId === selectedId ? "Click to close the detail" : "Click to inspect this workflow",
						onClick: () => onSelect(w.workflowId === selectedId ? "" : w.workflowId),
					},
					h(
						"td",
						null,
						h("div", { className: "wf-name" }, w.name),
						h("div", { className: "mono wf-id" }, w.workflowId.slice(0, 8)),
					),
					h("td", null, w.user || h("span", { className: "badge badge--neutral" }, "anonymous")),
					h("td", null, h(AgentBadge, { agent: w.agent })),
					h("td", null, h(SandboxBadge, { sandbox: w.sandbox, image: w.image })),
					h("td", null, statusBadge(w.status)),
					h("td", null, h(StepsProgress, { workflow: w })),
					h("td", { className: "mono" }, `${compactTokens(w.tokens.input)} / ${compactTokens(w.tokens.output)}`),
					h("td", { className: "mono" }, timeAgo(w.lastActivityAt)),
				),
			),
		),
	);
}

/**
 * The step canvas: Target's canvas read vertically - status dots down a 2px
 * rail on the left, one node per step with its number, status, description
 * and (once settled) duration.
 */
function StepCanvas({ steps }) {
	if (!steps || steps.length === 0) return h("div", { className: "empty" }, "No steps reported for this workflow yet.");
	return h(
		"ol",
		{ className: "steps-canvas" },
		steps.map((s) =>
			h(
				"li",
				{ className: "step-node", key: s.stepId },
				h("span", { className: `step-dot step-dot--${s.status}` }),
				h(
					"div",
					{ className: "step-body" },
					h(
						"div",
						{ className: "step-head" },
						h("span", { className: "mono step-num" }, `#${(s.orderIndex ?? 0) + 1}`),
						statusBadge(s.status),
						s.retryCount ? h("span", { className: "step-extra mono" }, `retry ${s.retryCount}`) : null,
						s.durationMs != null && (s.status === "done" || s.status === "failed")
							? h("span", { className: "step-dur mono" }, formatDuration(s.durationMs))
							: null,
					),
					h("div", { className: "step-desc" }, s.description ?? "(no description reported)"),
				),
			),
		),
	);
}

/** The expanded workflow: header, step canvas, and its recent events. */
function WorkflowDetail({ detail, error, onClose }) {
	if (error) return h("div", { className: "err" }, `Workflow detail: ${error}`);
	if (!detail) return h("div", { className: "empty" }, "Loading workflow...");
	const w = detail.workflow;
	return h(
		React.Fragment,
		null,
		h(
			"div",
			{ className: "wf-detail-head" },
			h("span", { className: "wf-title" }, w.name),
			h("span", { className: "mono wf-id" }, w.workflowId.slice(0, 8)),
			statusBadge(w.status),
			h(AgentBadge, { agent: w.agent }),
			h(SandboxBadge, { sandbox: w.sandbox, image: w.image }),
			w.user ? h("span", { className: "wf-user" }, w.user) : null,
			h("button", { type: "button", className: "btn btn--ghost wf-close", onClick: onClose }, "Close"),
		),
		h(StepCanvas, { steps: detail.steps }),
		h("h3", null, "Recent events"),
		h(EventFeed, { events: detail.events }),
	);
}

/** `datetime-local` values are local; the API compares ISO (UTC) strings. */
function localToIso(value) {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** One-line explanations for every filter, shown as a tooltip on its label. */
const FILTER_TIPS = {
	range: "Only count events received inside this time window. Pick 'Custom range...' to type exact start/end dates.",
	from: "Window start (your local time). Events received before this moment are hidden.",
	to: "Window end (your local time). Events received after this moment are hidden.",
	user: "Only show activity from this Target user (the name configured on the reporting instance).",
	instance: "Only show activity reported by this machine/instance. One user can run several instances.",
	agent: "Only show workflows whose steps run on this agent CLI (free-code, claude…). Heartbeats belong to no workflow, so they drop out while this filter is on.",
	sandbox: "Only show workflows running in this containment: 'local' = directly on the user's machine, 'docker' = inside a container. Heartbeats belong to no workflow, so they drop out while this filter is on.",
	workflow: "Focus on a single workflow: its steps, events and token usage.",
	kind: "Only show one type of event (e.g. 'Step finished'). Hover any event badge in the feed to learn what each kind means.",
	clear: "Remove every active filter and show all events again.",
};

/** Filter label with a dotted-hint '?' that explains the filter on hover. */
function TipLabel({ htmlFor, text, tip }) {
	return h(
		"label",
		{ className: "lbl lbl--tip", htmlFor, title: tip },
		text,
		h("span", { className: "tip-hint", "aria-hidden": "true" }, "?"),
	);
}

function FilterBar({ filters, onChange, users, instances, workflows, kinds, agents, sandboxes, matched }) {
	const set = (patch) => onChange({ ...filters, ...patch });
	const active =
		filters.range !== "all" ||
		filters.user ||
		filters.instance ||
		filters.workflow ||
		filters.kind ||
		filters.agent ||
		filters.sandbox ||
		filters.from ||
		filters.to;
	return h(
		"div",
		{ className: "panel" },
		h("h2", null, "Filters"),
		h(
			"div",
			{ className: "filters" },
			h(
				"div",
				{ className: "field" },
				h(TipLabel, { htmlFor: "f-range", text: "Date range", tip: FILTER_TIPS.range }),
				h(
					"select",
					{
						id: "f-range",
						className: "select",
						value: filters.range,
						onChange: (e) => set({ range: e.target.value, from: "", to: "" }),
					},
					RANGES.map((r) => h("option", { key: r.id, value: r.id }, r.label)),
				),
			),
			filters.range === "custom"
				? h(
						"div",
						{ className: "field" },
						h(TipLabel, { htmlFor: "f-from", text: "From", tip: FILTER_TIPS.from }),
						h("input", {
							id: "f-from",
							className: "input",
							type: "datetime-local",
							value: filters.from,
							onChange: (e) => set({ from: e.target.value }),
						}),
					)
				: null,
			filters.range === "custom"
				? h(
						"div",
						{ className: "field" },
						h(TipLabel, { htmlFor: "f-to", text: "To", tip: FILTER_TIPS.to }),
						h("input", {
							id: "f-to",
							className: "input",
							type: "datetime-local",
							value: filters.to,
							onChange: (e) => set({ to: e.target.value }),
						}),
					)
				: null,
			h(
				"div",
				{ className: "field" },
				h(TipLabel, { htmlFor: "f-user", text: "User", tip: FILTER_TIPS.user }),
				h(
					"select",
					{ id: "f-user", className: "select", value: filters.user, onChange: (e) => set({ user: e.target.value }) },
					h("option", { value: "" }, "All users"),
					users
						.filter((u) => u.name !== "anonymous")
						.map((u) => h("option", { key: u.name, value: u.name }, `${u.name} (${u.events} events)`)),
				),
			),
			h(
				"div",
				{ className: "field" },
				h(TipLabel, { htmlFor: "f-inst", text: "Instance", tip: FILTER_TIPS.instance }),
				h(
					"select",
					{ id: "f-inst", className: "select", value: filters.instance, onChange: (e) => set({ instance: e.target.value }) },
					h("option", { value: "" }, "All instances"),
					instances.map((i) =>
						h("option", { key: i.instanceId, value: i.instanceId }, `${i.instanceId.slice(0, 8)}${i.displayName ? ` · ${i.displayName}` : ""}`),
					),
				),
			),
			h(
				"div",
				{ className: "field" },
				h(TipLabel, { htmlFor: "f-agent", text: "Agent", tip: FILTER_TIPS.agent }),
				h(
					"select",
					{ id: "f-agent", className: "select", value: filters.agent, onChange: (e) => set({ agent: e.target.value }) },
					h("option", { value: "" }, "All agents"),
					agents.map((a) => h("option", { key: a, value: a }, a)),
				),
			),
			h(
				"div",
				{ className: "field" },
				h(TipLabel, { htmlFor: "f-sandbox", text: "Sandbox", tip: FILTER_TIPS.sandbox }),
				h(
					"select",
					{ id: "f-sandbox", className: "select", value: filters.sandbox, onChange: (e) => set({ sandbox: e.target.value }) },
					h("option", { value: "" }, "All sandboxes"),
					sandboxes.map((s) =>
					h("option", { key: s, value: s }, s === "host" ? "local (host)" : s === "docker" ? "docker" : s),
					),
				),
			),
			h(
				"div",
				{ className: "field" },
				h(TipLabel, { htmlFor: "f-workflow", text: "Workflow", tip: FILTER_TIPS.workflow }),
				h(
					"select",
					{ id: "f-workflow", className: "select", value: filters.workflow, onChange: (e) => set({ workflow: e.target.value }) },
					h("option", { value: "" }, "All workflows"),
					workflows.map((w) => h("option", { key: w.workflowId, value: w.workflowId }, `${w.name} · ${w.workflowId.slice(0, 8)}`)),
				),
			),
			h(
				"div",
				{ className: "field" },
				h(TipLabel, { htmlFor: "f-kind", text: "Event kind", tip: FILTER_TIPS.kind }),
				h(
					"select",
					{ id: "f-kind", className: "select", value: filters.kind, onChange: (e) => set({ kind: e.target.value }) },
					h("option", { value: "" }, "All kinds"),
					kinds.map((k) => h("option", { key: k, value: k, title: kindTip(k) }, KIND_INFO[k] ? `${kindLabel(k)} (${k})` : k)),
				),
			),
			h(
				"div",
				{ className: "field" },
				h("span", { className: "lbl" }, " "),
				h(
					"button",
					{
						type: "button",
						className: "btn",
						title: FILTER_TIPS.clear,
						disabled: !active,
						onClick: () =>
							onChange({ range: "all", from: "", to: "", user: "", instance: "", workflow: "", kind: "", agent: "", sandbox: "" }),
					},
					"Clear filters",
				),
			),
		),
		h(
			"div",
			{ className: "filter-summary" },
			matched == null
				? "Loading..."
				: h(React.Fragment, null, h("strong", null, String(matched)), ` event${matched === 1 ? "" : "s"} match the current filters`),
		),
	);
}

const TARGET_MARK = h(
	"svg",
	{ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", "aria-hidden": "true" },
	h("circle", { cx: "12", cy: "12", r: "9" }),
	h("circle", { cx: "12", cy: "12", r: "4.5" }),
	h("circle", { cx: "12", cy: "12", r: "1", fill: "currentColor" }),
);

function App() {
	const [filters, setFilters] = useState({ range: "all", from: "", to: "", user: "", instance: "", workflow: "", kind: "", agent: "", sandbox: "" });

	// The resolved query string every panel shares. Preset ranges re-anchor on
	// each render minute boundary via Date.now() at query-build time; the poll
	// keeps them sliding forward.
	const query = useMemo(() => {
		const p = new URLSearchParams();
		if (filters.range !== "all" && filters.range !== "custom" && RANGE_MS[filters.range]) {
			p.set("from", new Date(Date.now() - RANGE_MS[filters.range]).toISOString());
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

	const { data: stats, error: statsErr } = useApi(`/api/stats${query}`, POLL_MS);
	const { data: inst } = useApi("/api/instances", POLL_MS);
	const { data: users } = useApi("/api/users", POLL_MS);
	// The unfiltered kind list keeps the dropdown stable while a kind filter is applied.
	const { data: allStats } = useApi("/api/stats", POLL_MS * 4);
	const { data: evs } = useApi(`/api/events?limit=80${query ? `${query.replace("?", "&")}` : ""}`, POLL_MS);
	// The workflow-centric views. /api/workflows ignores the workflow/kind
	// filters server-side, so the list stays stable while a workflow is
	// selected; the detail below is what narrows.
	const { data: wfs } = useApi(`/api/workflows${query}`, POLL_MS);
	const { data: wfDetail, error: wfDetailErr } = useApi(filters.workflow ? `/api/workflows/${filters.workflow}` : null, POLL_MS);

	const kinds = (allStats?.byKind ?? stats?.byKind ?? []).map((r) => r.kind);
	// The filter-bar workflow options come from the list; keep the selected one
	// present even when the date/user filters currently exclude it.
	const workflowOptions = useMemo(() => {
		const list = wfs?.workflows ?? [];
		if (filters.workflow && !list.some((w) => w.workflowId === filters.workflow)) {
			return [...list, { workflowId: filters.workflow, name: wfDetail?.workflow?.name ?? filters.workflow.slice(0, 8) }];
		}
		return list;
	}, [wfs, filters.workflow, wfDetail]);
	const selectWorkflow = (id) => setFilters((f) => ({ ...f, workflow: id }));

	return h(
		React.Fragment,
		null,
		h(
			"header",
			{ className: "topbar" },
			h(
				"div",
				{ className: "topbar-inner" },
				h(
					"div",
					{ className: "brand" },
					h("span", { className: "mark" }, TARGET_MARK),
					h("span", { className: "name" }, "The Target Project"),
					h("span", { className: "sub" }, "· Report Dashboard"),
				),
				h("span", { className: "live" }, h("span", { className: "dot" }), `live · refresh ${POLL_MS / 1000}s`),
			),
		),
		h(
			"main",
			{ className: "shell" },
			h("h1", { className: "page-title" }, "Activity across the fleet"),
			h(
				"p",
				{ className: "page-sub" },
				"Workflow runs, steps, token usage and errors reported by every Target instance pointed at this server.",
			),
			statsErr ? h("div", { className: "err" }, `API error: ${statsErr}`) : null,
			h(FilterBar, {
				filters,
				onChange: setFilters,
				users: users?.users ?? [],
				instances: inst?.instances ?? [],
				workflows: workflowOptions,
				kinds,
				agents: allStats?.agents ?? stats?.agents ?? [],
				sandboxes: allStats?.sandboxes ?? stats?.sandboxes ?? [],
				matched: stats ? stats.totalEvents : null,
			}),
			h(
				"div",
				{ className: "kpis" },
				h(Kpi, { label: "Events", value: stats ? stats.totalEvents.toLocaleString() : "...", tone: "accent" }),
				h(Kpi, { label: "Instances", value: stats ? stats.totalInstances : "..." }),
				h(Kpi, { label: "Workflows", value: stats ? stats.workflows : "..." }),
				h(Kpi, { label: "Step failures", value: stats ? stats.failures : "...", tone: stats && stats.failures ? "danger" : "" }),
				h(Kpi, { label: "Input tokens", value: stats ? stats.usage.inputTokens.toLocaleString() : "..." }),
				h(Kpi, { label: "Output tokens", value: stats ? stats.usage.outputTokens.toLocaleString() : "..." }),
			),
			h(
				"div",
				{ className: "panel" },
				h("h2", null, "Workflows"),
				h(WorkflowsTable, { workflows: wfs && wfs.workflows, selectedId: filters.workflow, onSelect: selectWorkflow }),
				h("div", { className: "panel-note" }, "Click a workflow to see its steps and events. Honours the filters above."),
			),
			filters.workflow
				? h(
						"div",
						{ className: "panel wf-detail" },
						h("h2", null, "Workflow detail"),
						h(WorkflowDetail, { detail: wfDetail, error: wfDetailErr, onClose: () => selectWorkflow("") }),
					)
				: null,
			h("div", { className: "panel" }, h("h2", null, "Reporting instances (the fleet)"), h(InstancesTable, { instances: inst && inst.instances })),
			h(
				"div",
				{ className: "grid" },
				h(
					"div",
					{ className: "panel" },
					h("h2", null, "Events by kind"),
					h(Bars, { rows: (stats && stats.byKind) || [], keyName: "kind", valName: "count", keyLabel: kindLabel, keyTip: kindTip }),
					h("div", { className: "panel-note" }, "Honours the filters above."),
				),
				h("div", { className: "panel" }, h("h2", null, "Client versions"), h(Bars, { rows: (stats && stats.byVersion) || [], keyName: "version", valName: "count" })),
			),
			h("div", { style: { height: "var(--space-6)" } }),
			h("div", { className: "panel" }, h("h2", null, "Live event feed"), h(EventFeed, { events: evs && evs.events })),
		),
	);
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
