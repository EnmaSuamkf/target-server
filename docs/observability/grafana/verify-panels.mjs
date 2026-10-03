#!/usr/bin/env node
// Runs every panel query of the provisioned dashboard through Grafana's
// /api/ds/query and prints a Markdown table (rows, series, non-empty points).
// Usage: node docs/observability/grafana/verify-panels.mjs [grafanaUrl] [org-regex]
// Credentials are the local dev defaults of grafana/otel-lgtm (admin/admin).
// Backends ingest asynchronously, so the queries are retried until all return data
// or VERIFY_TIMEOUT_SECONDS (default 90) passes; only the last attempt is printed.
const base = process.argv[2] ?? "http://localhost:3000";
const org = process.argv[3] ?? ".*";
const auth = "Basic " + Buffer.from("admin:admin").toString("base64");
const get = (path) => fetch(base + path, { headers: { authorization: auth } }).then((r) => r.json());

const found = await get("/api/search?type=dash-db&query=Target%20Server");
const hit = found.find((d) => d.uid === "target-server-otel");
console.log(`GET /api/search lists: ${hit ? `${hit.title} (uid ${hit.uid}, folder ${hit.folderTitle})` : "NOT FOUND"}\n`);
if (!hit) process.exit(1);
const { dashboard } = await get("/api/dashboards/uid/target-server-otel");

// Same substitutions Grafana makes for "All" (allValue ".*") and the default window.
const sub = (s) =>
	s.replaceAll("${org:regex}", org).replaceAll("${runner:regex}", ".*").replaceAll("$org", org).replaceAll("$runner", ".*").replaceAll("$window", "15m");
const timeoutMs = Number(process.env.VERIFY_TIMEOUT_SECONDS ?? 90) * 1000;

async function attempt() {
	const to = Date.now();
	const from = to - 3600_000;
	const lines = [];
	let empty = 0;
	for (const panel of dashboard.panels) {
		for (const t of panel.targets) {
			const q = { ...t, datasource: t.datasource, intervalMs: 15000, maxDataPoints: 500 };
			if (t.expr) q.expr = sub(t.expr);
			if (t.query) q.query = sub(t.query);
			const res = await fetch(base + "/api/ds/query", {
				method: "POST",
				headers: { authorization: auth, "content-type": "application/json" },
				body: JSON.stringify({ queries: [q], from: String(from), to: String(to) }),
			}).then((r) => r.json());
			const frames = res.results?.[t.refId]?.frames ?? [];
			const error = res.results?.[t.refId]?.error;
			let rows = 0;
			let points = 0;
			for (const f of frames) {
				const cols = f.data?.values ?? [];
				rows = Math.max(rows, cols[0]?.length ?? 0);
				// numeric value columns: count non-null, non-zero values
				for (const c of cols.slice(1)) points += c.filter((v) => v !== null && v !== 0 && v !== "").length;
				if (cols.length === 1) points += cols[0].length;
			}
			const ok = !error && frames.length > 0 && points > 0;
			if (!ok) empty++;
			const what = error ? `error: ${error}` : `${frames.length} frame(s), up to ${rows} rows`;
			lines.push(`| ${panel.title} | ${t.refId} (${t.legendFormat ?? t.queryType}) | ${what} | ${ok ? `yes (${points} non-zero values)` : "NO"} |`);
		}
	}
	return { lines, empty };
}

/**
 * The Organization variable: runs its query_result query the way Grafana does (instant, $__range = the
 * last hour) and applies its text/value regex, so the options list shows names with the id as fallback.
 */
async function variableOptions() {
	const variable = dashboard.templating.list.find((v) => v.name === "org");
	const expr = variable.query.query.replace(/^query_result\(/, "").replace(/\)$/, "").replaceAll("$__range", "1h");
	const res = await fetch(base + "/api/ds/query", {
		method: "POST",
		headers: { authorization: auth, "content-type": "application/json" },
		body: JSON.stringify({ queries: [{ refId: "vorg", datasource: variable.datasource, expr, instant: true, range: false }], from: String(Date.now() - 3600_000), to: String(Date.now()) }),
	}).then((r) => r.json());
	const regex = new RegExp(variable.regex.replace(/^\/|\/$/g, ""));
	const options = [];
	for (const frame of res.results?.vorg?.frames ?? []) {
		const labels = frame.schema.fields.find((f) => f.labels)?.labels ?? {};
		const line = `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",")}}`;
		const groups = line.match(regex)?.groups;
		if (groups) options.push(groups.text === groups.value ? groups.value : `${groups.text} (${groups.value})`);
	}
	return options.sort();
}

const started = Date.now();
let result = await attempt();
let attempts = 1;
while (result.empty > 0 && Date.now() - started < timeoutMs) {
	await new Promise((r) => setTimeout(r, 10_000));
	result = await attempt();
	attempts++;
}

console.log(`Variables: org=\`${org}\`, runner=\`.*\`, window=\`15m\`; time range: last 1h; attempts: ${attempts}.\n`);
console.log("| Panel | Query ref | Result | Non-empty |\n|---|---|---|---|");
for (const line of result.lines) console.log(line);
const options = await variableOptions();
console.log(`\nOrganization variable options (name, with the id in parentheses; the id alone when no name was exported): ${options.length ? options.join(", ") : "NONE"}`);
if (options.length === 0) result.empty++;
console.log(result.empty === 0 ? "\nAll panel queries returned data." : `\n${result.empty} panel query(ies) returned no data.`);
process.exit(result.empty === 0 ? 0 : 1);
