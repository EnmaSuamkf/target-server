import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPricingRule, deletePricingRule, exportPricing, importPricing, loadPricing, updatePricingRule } from "../api/pricing.ts";
import type { PricingResponse, PricingRule, PricingRuleInput, UnpricedUsage } from "../api/types.ts";
import { compactNumber } from "../lib/format.ts";
import { Field } from "./Field.tsx";
import { Modal } from "./Modal.tsx";

/** What the form edits: strings, so a half-typed number is not coerced under the cursor. */
interface Draft {
	agent: string;
	model: string;
	inputPerMtok: string;
	outputPerMtok: string;
	cacheReadPerMtok: string;
	cacheWritePerMtok: string;
	effectiveFrom: string;
}

const EMPTY_DRAFT: Draft = {
	agent: "*",
	model: "*",
	inputPerMtok: "",
	outputPerMtok: "",
	cacheReadPerMtok: "",
	cacheWritePerMtok: "",
	effectiveFrom: "",
};

const rate = (n: number | null): string => (n == null ? "" : String(n));

function toDraft(rule: PricingRule): Draft {
	return {
		agent: rule.agent,
		model: rule.model,
		inputPerMtok: rate(rule.inputPerMtok),
		outputPerMtok: rate(rule.outputPerMtok),
		cacheReadPerMtok: rate(rule.cacheReadPerMtok),
		cacheWritePerMtok: rate(rule.cacheWritePerMtok),
		effectiveFrom: rule.effectiveFrom ? rule.effectiveFrom.slice(0, 10) : "",
	};
}

/** Blank → null (fall back to the input rate); anything else must be a number. */
function parseRate(value: string): number | null {
	const v = value.trim();
	return v === "" ? null : Number(v);
}

function toInput(d: Draft): PricingRuleInput {
	return {
		agent: d.agent.trim() || "*",
		model: d.model.trim() || "*",
		inputPerMtok: Number(d.inputPerMtok),
		outputPerMtok: Number(d.outputPerMtok),
		cacheReadPerMtok: parseRate(d.cacheReadPerMtok),
		cacheWritePerMtok: parseRate(d.cacheWritePerMtok),
		effectiveFrom: d.effectiveFrom ? new Date(`${d.effectiveFrom}T00:00:00Z`).toISOString() : "",
	};
}

const money = (n: number | null): string => (n == null ? "-" : `$${n}`);

/**
 * The per-organization price table behind every "Est. cost" on the dashboard.
 * Cost is computed when read, so saving a rule here reprices history; an
 * "effective from" date keeps older runs on the tariff that applied then.
 * Each control is gated by its own permission: a viewer sees the table only.
 */
export function PricingPanel({ canEdit, canImport, canExport }: { canEdit: boolean; canImport: boolean; canExport: boolean }) {
	const [data, setData] = useState<PricingResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);
	// `null` = closed, `"new"` = add, otherwise the rule being edited.
	const [editing, setEditing] = useState<PricingRule | "new" | null>(null);
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
	const [formError, setFormError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	const [importText, setImportText] = useState("");
	const [importMode, setImportMode] = useState<"replace" | "merge">("merge");
	const [importError, setImportError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
	useEffect(() => {
		let live = true;
		void loadPricing().then((result) => {
			if (!live) return;
			if (result.ok) {
				setData(result.data);
				setError(null);
			} else setError(result.error);
		});
		return () => {
			live = false;
		};
	}, [refreshKey]);

	function openForm(rule: PricingRule | "new", prefill?: Partial<Draft>) {
		setDraft({ ...(rule === "new" ? EMPTY_DRAFT : toDraft(rule)), ...prefill });
		setFormError(null);
		setEditing(rule);
	}

	function addFromUnpriced(u: UnpricedUsage) {
		openForm("new", { agent: u.agent ?? "*", model: u.model ?? "*" });
	}

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (!editing) return;
		const input = toInput(draft);
		if (draft.inputPerMtok.trim() === "" || draft.outputPerMtok.trim() === "") {
			setFormError("Input and output prices are required.");
			return;
		}
		setBusy(true);
		const result = editing === "new" ? await createPricingRule(input) : await updatePricingRule(editing.id, input);
		setBusy(false);
		if (!result.ok) {
			setFormError(result.error);
			return;
		}
		setEditing(null);
		setNotice("Saved.");
		refresh();
	}

	async function onDelete(rule: PricingRule) {
		if (!window.confirm(`Delete the rule for ${rule.agent} / ${rule.model}? Past runs it priced become unpriced.`)) return;
		const result = await deletePricingRule(rule.id);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		setNotice("Deleted.");
		refresh();
	}

	async function onExport() {
		const result = await exportPricing();
		setNotice(result.ok ? `Downloaded ${result.data.filename}.` : null);
		if (!result.ok) setError(result.error);
	}

	async function onImport(event: FormEvent) {
		event.preventDefault();
		let parsed: unknown;
		try {
			parsed = JSON.parse(importText);
		} catch {
			setImportError("Import data must be valid JSON.");
			return;
		}
		setBusy(true);
		const result = await importPricing(parsed, importMode);
		setBusy(false);
		if (!result.ok) {
			setImportError(result.error);
			return;
		}
		setImportOpen(false);
		setImportText("");
		setNotice(`Imported. The table now has ${result.data.rules.length} rule${result.data.rules.length === 1 ? "" : "s"}.`);
		refresh();
	}

	const set = (key: keyof Draft) => (event: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: event.target.value }));
	const rules = data?.rules ?? [];
	const unpriced = data?.unpriced ?? [];

	return (
		<div className="panel">
			<h2>Token pricing</h2>
			<div className="panel-note">
				USD per million tokens. The most specific rule wins: model first (exact, then prefix such as <span className="mono">claude-opus-*</span>, then{" "}
				<span className="mono">*</span>), then agent. Costs are computed when read, so editing a rule reprices past runs; use an effective date to keep
				them on the old price. Blank cache prices use the input price.
			</div>
			<div className="catalog-toolbar">
				{canEdit ? (
					<button type="button" className="btn btn--on" onClick={() => openForm("new")}>
						Add rule
					</button>
				) : null}
				{canImport ? (
					<button
						type="button"
						className="btn"
						onClick={() => {
							setImportError(null);
							setImportOpen(true);
						}}
					>
						Import JSON
					</button>
				) : null}
				{canExport ? (
					<button type="button" className="btn" disabled={rules.length === 0} onClick={() => void onExport()}>
						Export
					</button>
				) : null}
			</div>
			{notice ? <div className="panel-note">{notice}</div> : null}
			{error ? <div className="err">{`Pricing: ${error}`}</div> : null}

			{data && rules.length === 0 ? (
				<div className="empty">No pricing rules yet. Costs show as “-” until a rule matches.</div>
			) : null}
			{rules.length > 0 ? (
				<table>
					<thead>
						<tr>
							<th>Agent</th>
							<th>Model</th>
							<th>Input</th>
							<th>Output</th>
							<th>Cache read</th>
							<th>Cache write</th>
							<th>Effective from</th>
							{canEdit ? <th aria-label="Actions" /> : null}
						</tr>
					</thead>
					<tbody>
						{rules.map((rule) => (
							<tr key={rule.id}>
								<td className="mono">{rule.agent}</td>
								<td className="mono">{rule.model}</td>
								<td className="mono">{money(rule.inputPerMtok)}</td>
								<td className="mono">{money(rule.outputPerMtok)}</td>
								<td className="mono">{rule.cacheReadPerMtok == null ? "= input" : money(rule.cacheReadPerMtok)}</td>
								<td className="mono">{rule.cacheWritePerMtok == null ? "= input" : money(rule.cacheWritePerMtok)}</td>
								<td className="mono">{rule.effectiveFrom ? rule.effectiveFrom.slice(0, 10) : "always"}</td>
								{canEdit ? (
									<td>
										<button type="button" className="btn btn--sm" onClick={() => openForm(rule)}>
											Edit
										</button>{" "}
										<button type="button" className="btn btn--sm btn--danger" onClick={() => void onDelete(rule)}>
											Delete
										</button>
									</td>
								) : null}
							</tr>
						))}
					</tbody>
				</table>
			) : null}

			<h3>Unpriced usage</h3>
			<div className="panel-note">Agent and model pairs that reported usage but match no rule, so their cost is unknown.</div>
			{data && unpriced.length === 0 ? <div className="empty">Every session that reported usage has a price.</div> : null}
			{unpriced.length > 0 ? (
				<table>
					<thead>
						<tr>
							<th>Agent</th>
							<th>Model</th>
							<th>Sessions</th>
							<th>Input / output</th>
							{canEdit ? <th aria-label="Actions" /> : null}
						</tr>
					</thead>
					<tbody>
						{unpriced.map((u) => (
							<tr key={`${u.agent ?? ""}|${u.model ?? ""}`}>
								<td className="mono">{u.agent ?? "unknown"}</td>
								<td className="mono">{u.model ?? "not reported"}</td>
								<td className="mono">{u.sessions}</td>
								<td className="mono">{`${compactNumber(u.inputTokens)} / ${compactNumber(u.outputTokens)}`}</td>
								{canEdit ? (
									<td>
										<button type="button" className="btn btn--sm" onClick={() => addFromUnpriced(u)}>
											Add rule
										</button>
									</td>
								) : null}
							</tr>
						))}
					</tbody>
				</table>
			) : null}

			<Modal
				open={editing !== null}
				title={editing === "new" ? "Add pricing rule" : "Edit pricing rule"}
				description="USD per million tokens."
				onClose={() => setEditing(null)}
			>
				<form className="sync-step-form" onSubmit={(event) => void onSubmit(event)}>
					<Field label="Agent" hint="claude, free-code, cursor, or * for any.">
						{(p) => <input {...p} className="input" value={draft.agent} onChange={set("agent")} />}
					</Field>
					<Field label="Model" hint="Exact name, a prefix ending in * (claude-opus-*), or * for any.">
						{(p) => <input {...p} className="input" value={draft.model} onChange={set("model")} />}
					</Field>
					<Field label="Input ($ / Mtok)" required>
						{(p) => <input {...p} className="input" type="number" min="0" step="any" value={draft.inputPerMtok} onChange={set("inputPerMtok")} />}
					</Field>
					<Field label="Output ($ / Mtok)" required>
						{(p) => <input {...p} className="input" type="number" min="0" step="any" value={draft.outputPerMtok} onChange={set("outputPerMtok")} />}
					</Field>
					<Field label="Cache read ($ / Mtok)" hint="Blank = same as input.">
						{(p) => <input {...p} className="input" type="number" min="0" step="any" value={draft.cacheReadPerMtok} onChange={set("cacheReadPerMtok")} />}
					</Field>
					<Field label="Cache write ($ / Mtok)" hint="Blank = same as input.">
						{(p) => <input {...p} className="input" type="number" min="0" step="any" value={draft.cacheWritePerMtok} onChange={set("cacheWritePerMtok")} />}
					</Field>
					<Field label="Effective from" hint="Blank = always. Runs before this date keep using an older rule.">
						{(p) => <input {...p} className="input" type="date" value={draft.effectiveFrom} onChange={set("effectiveFrom")} />}
					</Field>
					{formError ? (
						<p className="msg msg--error" role="alert">
							{formError}
						</p>
					) : null}
					<div className="catalog-toolbar">
						<button type="button" className="btn" onClick={() => setEditing(null)}>
							Cancel
						</button>
						<button className="btn btn--on" disabled={busy}>
							Save
						</button>
					</div>
				</form>
			</Modal>

			<Modal open={importOpen} title="Import pricing" description="Load a pricing-export.json file." onClose={() => setImportOpen(false)}>
				<form className="sync-step-form" onSubmit={(event) => void onImport(event)}>
					<input
						ref={fileRef}
						type="file"
						accept="application/json,.json"
						aria-label="Pricing file"
						onChange={(event) => {
							const file = event.target.files?.[0];
							if (file) void file.text().then(setImportText);
						}}
					/>
					<textarea className="sync-context-input" rows={8} value={importText} aria-label="Import JSON" onChange={(event) => setImportText(event.target.value)} />
					<Field label="Mode" hint="Replace swaps the whole table; merge updates matching rules and keeps the rest.">
						{(p) => (
							<select {...p} className="select" value={importMode} onChange={(event) => setImportMode(event.target.value as "replace" | "merge")}>
								<option value="merge">Merge</option>
								<option value="replace">Replace all rules</option>
							</select>
						)}
					</Field>
					{importError ? (
						<p className="msg msg--error" role="alert">
							{importError}
						</p>
					) : null}
					<div className="catalog-toolbar">
						<button type="button" className="btn" onClick={() => setImportOpen(false)}>
							Cancel
						</button>
						<button className="btn btn--on" disabled={busy || !importText.trim()}>
							Import
						</button>
					</div>
				</form>
			</Modal>
		</div>
	);
}

