import { useEffect, useState, type FormEvent } from "react";
import { loadOtelSettings, saveOtelSettings, testOtelConnection } from "../api/otel.ts";
import type { OtelSettings, OtelSettingsInput, OtelSignal, OtelTestResult } from "../api/types.ts";
import { timeAgo } from "../lib/format.ts";
import { CopyValue } from "./CopyValue.tsx";
import { Field } from "./Field.tsx";

/**
 * One header row. A stored header comes back masked: `stored` is true, the
 * server's mask is only a placeholder and `value` stays empty (= keep the saved
 * secret) until the user types a replacement.
 */
interface HeaderRow {
	key: number;
	name: string;
	value: string;
	stored: boolean;
	masked: string;
}

/** What the form edits; `headers` carries only what the user typed, never a stored value. */
interface Draft {
	enabled: boolean;
	endpoint: string;
	headers: HeaderRow[];
	signals: OtelSignal[];
	sendContent: boolean;
	langfuseAttrs: boolean;
}

const SIGNALS: { id: OtelSignal; label: string }[] = [
	{ id: "traces", label: "Traces" },
	{ id: "metrics", label: "Metrics" },
];

/** A preset only pre-fills the form; it is not a vendor integration and nothing is sent until Save. */
interface Preset {
	id: string;
	label: string;
	endpoint: string;
	headers: { name: string; value: string }[];
	signals: OtelSignal[];
	langfuseAttrs: boolean;
	/** Signals that docs/observability/phase0-findings.md lists as NOT TESTED or FAIL for this destination. */
	untested: OtelSignal[];
	help: string;
	basicAuth: string | null;
}

const BASIC_AUTH_HELP = "Authorization is the word Basic, a space, then the base64 of two values joined by a colon.";

const PRESETS: Preset[] = [
	{
		id: "langfuse",
		label: "Langfuse",
		endpoint: "https://cloud.langfuse.com/api/public/otel",
		headers: [
			{ name: "Authorization", value: "" },
			{ name: "x-langfuse-ingestion-version", value: "4" },
		],
		signals: ["traces"],
		langfuseAttrs: true,
		untested: ["metrics"],
		help: "Use your Langfuse project keys as publicKey:secretKey. For a self-hosted Langfuse replace the host (keep /api/public/otel). Langfuse accepts but does not store metrics, so only Traces is selected.",
		basicAuth: "echo -n 'pk-lf-...:sk-lf-...' | base64",
	},
	{
		id: "grafana-cloud",
		label: "Grafana Cloud",
		endpoint: "https://otlp-gateway-<REGION>.grafana.net/otlp",
		headers: [{ name: "Authorization", value: "" }],
		signals: ["traces", "metrics"],
		langfuseAttrs: false,
		untested: ["traces", "metrics"],
		help: "Replace <REGION> with your stack's region (for example prod-us-east-0). Use your instance ID and a token with the MetricsPublisher and traces write scopes as instanceId:token.",
		basicAuth: "echo -n 'INSTANCE_ID:TOKEN' | base64",
	},
	{
		id: "collector",
		label: "My own OpenTelemetry Collector",
		endpoint: "http://collector.example.com:4318",
		headers: [],
		signals: ["traces", "metrics"],
		langfuseAttrs: false,
		untested: [],
		help: "Point it at your Collector's OTLP/HTTP receiver (port 4318). Add headers only if the receiver requires authentication. Plain http and private addresses are accepted only when the server operator has set TARGET_OTEL_ALLOW_PRIVATE=1.",
		basicAuth: null,
	},
];

let nextKey = 1;
const newRow = (init: Partial<HeaderRow> = {}): HeaderRow => ({ key: nextKey++, name: "", value: "", stored: false, masked: "", ...init });

function toDraft(settings: OtelSettings): Draft {
	const { config } = settings;
	return {
		enabled: config.enabled,
		endpoint: config.endpoint,
		headers: config.headers.map((h) => newRow({ name: h.name, stored: true, masked: h.masked })),
		signals: config.signals,
		sendContent: config.sendContent,
		langfuseAttrs: config.langfuseAttrs,
	};
}

/** True when the test error is the metrics probe rejected with HTTP 400 (traces were accepted before it). */
function isMetricsRejected(result: { ok: boolean; error?: string | null }): boolean {
	return !result.ok && /^metrics: HTTP 400\b/.test(result.error ?? "");
}

/** True for *.grafana.net hosts. */
function isGrafanaCloud(endpoint: string): boolean {
	try {
		return new URL(endpoint).hostname.toLowerCase().endsWith(".grafana.net");
	} catch {
		return false;
	}
}

/** Error text for a draft the server would reject anyway, or null. */
function validate(d: Draft): string | null {
	if (d.enabled && !d.endpoint.trim()) return "Enter an endpoint URL before turning the export on.";
	if (/[<>]/.test(d.endpoint)) return "Replace the <PLACEHOLDER> in the endpoint with a real value.";
	if (d.signals.length === 0) return "Select at least one signal.";
	const seen = new Set<string>();
	for (const row of d.headers) {
		const name = row.name.trim();
		if (!name) return "Every header needs a name. Remove the empty row or fill it in.";
		if (seen.has(name.toLowerCase())) return `Header "${name}" appears more than once.`;
		seen.add(name.toLowerCase());
		if (!row.stored && !row.value) return `Enter a value for header "${name}", or remove it.`;
	}
	return null;
}

/**
 * Only values the user typed are sent. `""` tells the server to keep a stored
 * secret, and a header that is not listed is removed.
 */
function toInput(d: Draft): OtelSettingsInput {
	const headers: Record<string, string> = {};
	for (const row of d.headers) headers[row.name.trim()] = row.value;
	return {
		enabled: d.enabled,
		endpoint: d.endpoint.trim(),
		headers,
		signals: d.signals,
		sendContent: d.sendContent,
		langfuseAttrs: d.langfuseAttrs,
	};
}

/** True when the form differs from what is saved: the connection test only ever uses the saved settings. */
function isDirty(d: Draft, saved: OtelSettings): boolean {
	const c = saved.config;
	return (
		d.enabled !== c.enabled ||
		d.endpoint.trim() !== c.endpoint ||
		d.sendContent !== c.sendContent ||
		d.langfuseAttrs !== c.langfuseAttrs ||
		d.signals.join() !== c.signals.join() ||
		d.headers.length !== c.headers.length ||
		d.headers.some((r) => !r.stored || r.value !== "")
	);
}

/** `Oct 3, 2026, 10:00:10 AM` in the viewer's locale, or a dash. */
const absoluteTime = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "-");

/**
 * Where an organization sends its workflow traces and metrics (OTLP/HTTP JSON).
 * Everyone with telemetry.read sees the saved configuration; header values are
 * never shown, only the server's mask. Changing anything needs telemetry.write.
 */
export function OtelPanel({ canEdit }: { canEdit: boolean }) {
	const [settings, setSettings] = useState<OtelSettings | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [preset, setPreset] = useState<Preset | null>(null);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<OtelTestResult | { ok: false; status: null; error: string } | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);

	useEffect(() => {
		let live = true;
		void loadOtelSettings().then((result) => {
			if (!live) return;
			if (result.ok) {
				setSettings(result.data);
				setDraft(toDraft(result.data));
				setError(null);
			} else setError(result.error);
		});
		return () => {
			live = false;
		};
	}, [refreshKey]);

	const secretsOk = settings?.secretsAvailable ?? true;
	const locked = !canEdit || !secretsOk || busy || testing;
	// Nothing saved yet: the server answers with defaults and no timestamp.
	const configured = settings !== null && settings.config.updatedAt !== null;
	const dirty = settings !== null && draft !== null && isDirty(draft, settings);
	const canTest = canEdit && secretsOk && configured && settings.config.endpoint !== "" && !dirty && !busy && !testing;

	const patch = (changes: Partial<Draft>) => {
		setDraft((d) => (d ? { ...d, ...changes } : d));
		setNotice(null);
	};
	const patchRow = (key: number, changes: Partial<HeaderRow>) =>
		setDraft((d) => (d ? { ...d, headers: d.headers.map((r) => (r.key === key ? { ...r, ...changes } : r)) } : d));

	/** Fills the form only. A stored header with the same name keeps its saved secret. */
	function applyPreset(p: Preset) {
		if (!draft) return;
		let headers = draft.headers;
		for (const h of p.headers) {
			const existing = headers.find((r) => r.name.toLowerCase() === h.name.toLowerCase());
			if (!existing) headers = [...headers, newRow({ name: h.name, value: h.value })];
			else if (!existing.stored && !existing.value) headers = headers.map((r) => (r === existing ? { ...r, value: h.value } : r));
		}
		setDraft({ ...draft, endpoint: p.endpoint, headers, signals: p.signals, langfuseAttrs: p.langfuseAttrs });
		setPreset(p);
		setFormError(null);
		setNotice(`Form pre-filled from ${p.label}. Nothing is saved until you press Save.`);
	}

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (!draft || locked) return;
		const problem = validate(draft);
		if (problem) {
			setFormError(problem);
			return;
		}
		setBusy(true);
		const result = await saveOtelSettings(toInput(draft));
		setBusy(false);
		if (!result.ok) {
			setFormError(result.error);
			return;
		}
		setSettings(result.data);
		setDraft(toDraft(result.data));
		setFormError(null);
		setNotice("Saved.");
		setTestResult(null);
	}

	/** Tests the saved destination only; the reply carries a status and error name, never a header value. */
	async function onTest() {
		setTesting(true);
		setTestResult(null);
		const result = await testOtelConnection();
		setTesting(false);
		setTestResult(result.ok ? result.data : { ok: false, status: null, error: result.error });
		// The worker's lastOkAt / lastError are not touched by a test, but the outbox counts may have moved.
		setRefreshKey((k) => k + 1);
	}

	const toggleSignal = (id: OtelSignal, on: boolean) => {
		if (!draft) return;
		patch({ signals: SIGNALS.map((s) => s.id).filter((s) => (s === id ? on : draft.signals.includes(s))) });
	};

	return (
		<div className="panel" id="telemetry-export">
			<h2>Telemetry export</h2>
			<div className="panel-note">
				Send this organization's workflow traces and metrics to any OpenTelemetry (OTLP/HTTP JSON) backend. Only events received after the export is
				turned on are sent.
			</div>
			{settings?.organization?.id ? (
				<div className="otel-org" data-state="organization">
					<div className="otel-org__name">
						<span className="otel-org__label">Organization</span>
						<strong>{settings.organization.name}</strong>
					</div>
					<div className="otel-org__id">
						<span className="otel-org__label">ID</span>
						<CopyValue value={settings.organization.id} label="organization id" />
					</div>
					<p className="hint">This id is the value that appears as target.org in Grafana, Tempo and Prometheus.</p>
				</div>
			) : null}
			<div className="panel-note">Editing a price in Pricing does not change data that was already exported.</div>
			{error ? (
				<div className="err" role="alert">
					{`Telemetry export: ${error}`}{" "}
					<button type="button" className="btn btn--sm" onClick={() => setRefreshKey((k) => k + 1)}>
						Retry
					</button>
				</div>
			) : null}
			{!draft && !error ? (
				<div className="empty" role="status" data-state="loading">
					Loading telemetry settings…
				</div>
			) : null}
			{settings ? (
				<p className="msg" data-state={!configured ? "empty" : "configured"}>
					<span className={`badge ${!configured ? "badge--neutral" : settings.config.enabled ? "badge--success" : "badge--warn"}`}>
						{!configured ? "Not configured" : settings.config.enabled ? "Export on" : "Export off"}
					</span>{" "}
					{!configured
						? "No destination has been saved yet. Pick a preset or fill in the endpoint, then save."
						: settings.config.enabled
							? "New events are being exported to the saved endpoint."
							: "A destination is saved but the export is switched off."}
				</p>
			) : null}
			{settings && !secretsOk ? (
				<div className="err" role="alert" data-state="secrets-unavailable">
					Storing credentials is not available: the server administrator must set TARGET_SECRETS_KEY (64 hex characters, for example from{" "}
					<span className="mono">openssl rand -hex 32</span>) and restart the server. The form is disabled until then.
				</div>
			) : null}
			{settings && secretsOk && !canEdit ? (
				<div className="panel-note" data-state="read-only">
					<span className="badge badge--neutral">Read-only</span> You can view this configuration, but changing or testing it needs the telemetry.write permission.
				</div>
			) : null}
			{settings ? (
				<dl className="otel-status" aria-label="Export status" data-state="status">
					<div>
						<dt>Last successful export</dt>
						<dd>
							{settings.status.lastOkAt ? (
								<>
									{timeAgo(settings.status.lastOkAt)} <span className="mono">({absoluteTime(settings.status.lastOkAt)})</span>
								</>
							) : (
								"Never"
							)}
						</dd>
					</div>
					<div>
						<dt>Last error</dt>
						<dd className={settings.status.lastError ? "otel-status__error" : undefined}>{settings.status.lastError ?? "None"}</dd>
					</div>
					<div>
						<dt>Queue</dt>
						<dd className="mono">{`${settings.status.outbox.pending} pending · ${settings.status.outbox.sent} sent · ${settings.status.outbox.dead} failed`}</dd>
					</div>
				</dl>
			) : null}

			{draft ? (
				<form className="sync-step-form otel-form" onSubmit={(event) => void onSubmit(event)} aria-label="Telemetry export settings">
					<fieldset className="otel-fieldset" disabled={locked}>
						<legend className="label">Presets</legend>
						<div className="catalog-toolbar" role="group" aria-label="Presets">
							{PRESETS.map((p) => (
								<button key={p.id} type="button" className="btn" onClick={() => applyPreset(p)}>
									{p.label}
									{p.untested.length > 0 ? (
										<>
											{" "}
											<span className="badge badge--warn">{p.untested.length === 2 ? "untested" : `${p.untested.join(", ")} untested`}</span>
										</>
									) : null}
								</button>
							))}
						</div>
						<p className="hint">Presets only pre-fill the form below; nothing is sent or saved until you press Save.</p>
						{preset ? (
							<div className="otel-help" role="note">
								<strong>{preset.label}.</strong> {preset.help}
								{preset.untested.length > 0 ? (
									<p className="hint">
										Untested ({preset.untested.join(" and ")}): the first export phase could not confirm this destination end to end. Use
										Test connection and check your backend.
									</p>
								) : null}
								{preset.basicAuth ? (
									<p className="hint">
										{BASIC_AUTH_HELP} For example: <span className="mono">{preset.basicAuth}</span>, then enter{" "}
										<span className="mono">Basic &lt;that output&gt;</span> as the Authorization value.
									</p>
								) : null}
							</div>
						) : null}

						<label className="sync-toggle">
							<input
								type="checkbox"
								role="switch"
								checked={draft.enabled}
								onChange={(event) => patch({ enabled: event.target.checked })}
							/>
							<span>Enabled</span>
						</label>

						<Field label="Endpoint URL" hint="OTLP/HTTP base URL; /v1/traces and /v1/metrics are appended. Credentials go in a header, not in the URL.">
							{(p) => (
								<input
									{...p}
									className="input"
									type="url"
									inputMode="url"
									autoComplete="off"
									spellCheck={false}
									placeholder="https://otlp.example.com"
									value={draft.endpoint}
									onChange={(event) => patch({ endpoint: event.target.value })}
								/>
							)}
						</Field>

						<div className="field" role="group" aria-labelledby="otel-headers-label">
							<span className="label" id="otel-headers-label">
								Headers
							</span>
							<p className="hint">
								Usually an API key. Saved values are hidden: leave a saved row's value empty to keep it, or type a new value to replace it.
							</p>
							{draft.headers.length === 0 ? <p className="hint">No headers.</p> : null}
							{draft.headers.map((row, i) => (
								<div className="otel-header-row" key={row.key}>
									<input
										className="input"
										aria-label={`Header ${i + 1} name`}
										placeholder="Header name"
										autoComplete="off"
										spellCheck={false}
										readOnly={row.stored}
										value={row.name}
										onChange={(event) => patchRow(row.key, { name: event.target.value })}
									/>
									<input
										className="input"
										type="password"
										aria-label={`Header ${i + 1} value`}
										placeholder={row.stored ? `${row.masked} (saved, type to replace)` : "Header value"}
										autoComplete="new-password"
										spellCheck={false}
										value={row.value}
										onChange={(event) => patchRow(row.key, { value: event.target.value })}
									/>
									<button
										type="button"
										className="btn btn--sm btn--danger"
										aria-label={`Remove header ${row.name || i + 1}`}
										onClick={() => patch({ headers: draft.headers.filter((r) => r.key !== row.key) })}
									>
										Remove
									</button>
								</div>
							))}
							<div>
								<button type="button" className="btn btn--sm" onClick={() => patch({ headers: [...draft.headers, newRow()] })}>
									Add header
								</button>
							</div>
						</div>

						<div className="field" role="group" aria-labelledby="otel-signals-label">
							<span className="label" id="otel-signals-label">
								Signals
							</span>
							<div className="sync-step-form__toggles">
								{SIGNALS.map((s) => (
									<label key={s.id} className="sync-toggle">
										<input type="checkbox" checked={draft.signals.includes(s.id)} onChange={(event) => toggleSignal(s.id, event.target.checked)} />
										<span>{s.label}</span>
									</label>
								))}
							</div>
						</div>

						<div className="field">
							<label className="sync-toggle">
								<input type="checkbox" checked={draft.langfuseAttrs} onChange={(event) => patch({ langfuseAttrs: event.target.checked })} />
								<span>Add Langfuse attributes</span>
							</label>
							<p className="hint">Adds langfuse.* attributes to spans so Langfuse shows users, sessions and usage. Harmless for other backends.</p>
						</div>

						<div className="field">
							<label className="sync-toggle">
								<input type="checkbox" checked={draft.sendContent} onChange={(event) => patch({ sendContent: event.target.checked })} />
								<span>Send content (workflow and organization names)</span>
							</label>
							<p className="hint otel-warning">
								When checked, exports also include the workflow name and the organization name, so your dashboards show names instead of ids.
								Whoever operates the destination will be able to read them. Unchecking it removes the names from future exports; data already
								exported is not changed.
							</p>
							<p className="hint">
								Never sent, whatever you choose: step descriptions or prompts, acceptance criteria, error messages (only the error kind is sent)
								and conversation content.
							</p>
						</div>

						{formError ? (
							<p className="msg msg--error" role="alert">
								{formError}
							</p>
						) : null}
						{notice ? (
							<p className="msg" role="status">
								{notice}
							</p>
						) : null}
						{testing ? (
							<p className="msg" role="status" data-state="test-loading">
								Testing the connection…
							</p>
						) : null}
						{testResult ? (
							testResult.ok ? (
								<p className="msg otel-test otel-test--ok" role="status" data-state="test-success">
									<span className="badge badge--success">Success</span> The destination accepted the test data
									{testResult.status != null ? ` (HTTP ${testResult.status})` : ""}.
								</p>
							) : (
								<p className="msg msg--error otel-test" role="alert" data-state="test-failure">
									<span className="badge badge--danger">Failed</span>{" "}
									{testResult.status != null ? `HTTP ${testResult.status}. ` : ""}
									{testResult.error ?? "The destination did not accept the test data."}
								</p>
							)
						) : null}
						{testResult && isMetricsRejected(testResult) ? (
							<p className="msg otel-warning" role="note" data-state="test-metrics-rejected">
								{isGrafanaCloud(settings?.config.endpoint ?? "")
									? "Grafana Cloud rejects Target's DELTA metrics (it expects cumulative). Traces were accepted. Uncheck Metrics, Save, and test again; otherwise real exports will fail too."
									: "Traces were accepted but the metrics were rejected. Uncheck Metrics, Save, and test again."}
							</p>
						) : null}
						{canEdit ? (
							<div className="catalog-toolbar">
								<button className="btn btn--on" disabled={locked}>
									{busy ? "Saving…" : "Save"}
								</button>
								<button type="button" className="btn" disabled={!canTest} onClick={() => void onTest()}>
									{testing ? "Testing…" : "Test connection"}
								</button>
							</div>
						) : null}
						{canEdit && secretsOk && !canTest && !testing ? (
							<p className="hint">Test connection sends a sample span and data point to the saved settings: {configured ? "save your changes first." : "save a destination first."}</p>
						) : null}
					</fieldset>
				</form>
			) : null}
		</div>
	);
}
