import { useRef, useState, type FormEvent } from "react";
import { createTcp, deleteTcp, exportCatalog, importCatalog, splitTags, updateTcp } from "../api/catalog.ts";
import type { CatalogActions, Tcp, TcpTool, TcpToolInput, TcpsResponse } from "../api/types.ts";
import { useApi } from "../hooks/useApi.ts";

const emptyTool = (): TcpTool => ({ name: "", description: "", requestTemplate: "", inputs: [], tokens: {} });
const emptyInput = (): TcpToolInput => ({ name: "", placeholder: "", description: "", required: true });

export function TcpPacksPanel({ actions }: { actions: CatalogActions }) {
	const [refreshKey, setRefreshKey] = useState(0);
	const { data, error } = useApi<TcpsResponse>(actions.read ? `/api/tcps?_=${refreshKey}` : null);
	const [overlay, setOverlay] = useState<Tcp | null>(null);
	const tcps = data?.tcps ?? [];
	const visibleTcps = overlay && !tcps.some((item) => item.id === overlay.id) ? [overlay, ...tcps] : tcps;
	const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [importOpen, setImportOpen] = useState(false);
	const [importText, setImportText] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);
	const selected = selectedId && selectedId !== "new"
		? (visibleTcps.find((item) => item.id === selectedId) ?? (overlay?.id === selectedId ? overlay : null))
		: null;

	async function onExportAll() {
		const result = await exportCatalog("/api/tcps/export", "tcps-export.json");
		setNotice(result.ok ? `Downloaded ${result.filename}.` : result.error);
	}

	async function onImportBundle(raw: string) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			setNotice("Import data must be valid JSON.");
			return;
		}
		const result = await importCatalog<TcpsResponse>("/api/tcps/import", parsed);
		if (!result.ok) {
			setNotice(result.error);
			return;
		}
		setNotice(`Imported ${result.data.tcps.length} TCP pack${result.data.tcps.length === 1 ? "" : "s"}.`);
		setImportOpen(false);
		setImportText("");
		setRefreshKey((key) => key + 1);
	}

	if (!actions.read) {
		return <p className="panel-note">Your role cannot view TCP packs on this server.</p>;
	}

	return (
		<div className="catalog">
			<div className="catalog-toolbar">
				<button type="button" className="btn btn--on" disabled={!actions.create} onClick={() => setSelectedId("new")}>
					New
				</button>
				<button type="button" className="btn" disabled={!actions.import} onClick={() => setImportOpen(true)}>
					Import JSON
				</button>
				<button type="button" className="btn" disabled={!actions.export || visibleTcps.length === 0} onClick={() => void onExportAll()}>
					Export all
				</button>
			</div>
			{notice ? <div className={notice.includes("Imported") || notice.startsWith("Downloaded") ? "panel-note" : "err"}>{notice}</div> : null}
			{error ? <div className="err">{`Could not load TCP packs: ${error}`}</div> : null}
			<div className="catalog-layout">
				<div className="catalog-list" aria-label="TCP packs">
					{visibleTcps.length === 0 ? <div className="empty">No TCP packs yet.</div> : null}
					{visibleTcps.map((item) => (
						<button
							key={item.id}
							type="button"
							className={`catalog-card${item.id === selectedId ? " catalog-card--active" : ""}`}
							onClick={() => setSelectedId(item.id)}
						>
							<span className="catalog-card-name">{item.name}</span>
							<span className="catalog-card-meta">
								{item.tools.length} tool{item.tools.length === 1 ? "" : "s"}
								{item.tags.length ? ` · ${item.tags.join(", ")}` : ""}
							</span>
						</button>
					))}
				</div>
				{selectedId ? (
					<TcpEditor
						key={`${selectedId}:${selected?.updatedAt ?? "new"}`}
						tcp={selected}
						actions={actions}
						onCancel={() => setSelectedId(null)}
						onSaved={(item) => {
							setOverlay(item);
							setSelectedId(item.id);
							setRefreshKey((key) => key + 1);
							setNotice("Saved.");
						}}
						onDeleted={() => {
							setOverlay(null);
							setSelectedId(null);
							setRefreshKey((key) => key + 1);
							setNotice("Deleted.");
						}}
					/>
				) : (
					<p className="panel-note">Pick a TCP pack to edit, or create a new one.</p>
				)}
			</div>
			{importOpen ? (
				<form
					className="sync-step-form"
					onSubmit={(event) => {
						event.preventDefault();
						void onImportBundle(importText);
					}}
				>
					<h3>Import TCP packs</h3>
					<input
						ref={fileRef}
						type="file"
						accept="application/json,.json"
						className="sr-only"
						onChange={(event) => {
							const file = event.target.files?.[0];
							if (file) void file.text().then(setImportText);
							event.target.value = "";
						}}
					/>
					<div className="sync-create-row">
						<button type="button" className="btn" onClick={() => fileRef.current?.click()}>
							Choose JSON file
						</button>
					</div>
					<textarea className="sync-context-input" rows={8} value={importText} aria-label="Import JSON" onChange={(event) => setImportText(event.target.value)} />
					<div className="sync-step-form__actions">
						<button type="button" className="btn" onClick={() => { setImportOpen(false); setImportText(""); }}>
							Cancel
						</button>
						<button className="btn btn--on" disabled={!importText.trim()}>
							Import
						</button>
					</div>
				</form>
			) : null}
		</div>
	);
}

function TcpEditor({
	tcp,
	actions,
	onCancel,
	onSaved,
	onDeleted,
}: {
	tcp: Tcp | null;
	actions: CatalogActions;
	onCancel: () => void;
	onSaved: (item: Tcp) => void;
	onDeleted: () => void;
}) {
	const [name, setName] = useState(tcp?.name ?? "");
	const [tags, setTags] = useState(tcp?.tags.join(", ") ?? "");
	const [tools, setTools] = useState<TcpTool[]>(tcp?.tools.length ? tcp.tools : [emptyTool()]);
	const [busy, setBusy] = useState(false);
	const canWrite = tcp ? actions.edit : actions.create;

	const updateTool = (index: number, patch: Partial<TcpTool>) => {
		setTools((current) => current.map((tool, i) => (i === index ? { ...tool, ...patch } : tool)));
	};

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (!name.trim() || busy) return;
		setBusy(true);
		const input = {
			name: name.trim(),
			tags: splitTags(tags),
			tools: tools
				.map((tool) => ({
					...tool,
					name: tool.name.trim(),
					description: tool.description.trim(),
					requestTemplate: tool.requestTemplate.trim(),
					inputs: tool.inputs.filter((entry) => entry.name.trim() && entry.placeholder.trim()),
				}))
				.filter((tool) => tool.name !== "" && tool.requestTemplate !== ""),
		};
		const result = tcp ? await updateTcp(tcp.id, input) : await createTcp(input);
		setBusy(false);
		if (!result.ok) return;
		onSaved(result.data.tcp);
	}

	async function onDelete() {
		if (!tcp || !window.confirm(`Delete TCP pack “${tcp.name}”?`)) return;
		const result = await deleteTcp(tcp.id);
		if (result.ok) onDeleted();
	}

	async function onExport() {
		if (!tcp) return;
		await exportCatalog(`/api/tcps/${encodeURIComponent(tcp.id)}/export`, `tcp-${tcp.id}.json`);
	}

	return (
		<form className="catalog-editor sync-step-form" onSubmit={(event) => void onSubmit(event)}>
			<h3>{tcp ? "Edit TCP pack" : "New TCP pack"}</h3>
			<label className="catalog-field">
				<span>Name</span>
				<input className="input" required value={name} onChange={(event) => setName(event.target.value)} />
			</label>
			<label className="catalog-field">
				<span>Tags</span>
				<input className="input" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="github, api" />
			</label>
			<div className="catalog-block-head">
				<span className="catalog-field-label">Tools</span>
				<button type="button" className="btn btn--sm" onClick={() => setTools((current) => [...current, emptyTool()])}>
					Add tool
				</button>
			</div>
			{tools.map((tool, index) => (
				<div key={index} className="catalog-block">
					<div className="catalog-block-head">
						<strong>Tool {index + 1}</strong>
						<button type="button" className="btn btn--sm btn--ghost" onClick={() => setTools((current) => current.filter((_, i) => i !== index))}>
							Remove
						</button>
					</div>
					<label className="catalog-field">
						<span>Name</span>
						<input className="input" value={tool.name} onChange={(event) => updateTool(index, { name: event.target.value })} placeholder="status" />
					</label>
					<label className="catalog-field">
						<span>Description</span>
						<input className="input" value={tool.description} onChange={(event) => updateTool(index, { description: event.target.value })} />
					</label>
					<label className="catalog-field">
						<span>Request template</span>
						<textarea className="input sync-context-input" rows={3} value={tool.requestTemplate} onChange={(event) => updateTool(index, { requestTemplate: event.target.value })} />
					</label>
					<div className="catalog-block-head">
						<span className="catalog-field-label">Inputs</span>
						<button
							type="button"
							className="btn btn--sm"
							onClick={() => updateTool(index, { inputs: [...tool.inputs, emptyInput()] })}
						>
							Add input
						</button>
					</div>
					{tool.inputs.map((entry, inputIndex) => (
						<div key={inputIndex} className="sync-step-form__grid">
							<input className="input" placeholder="Name" value={entry.name} onChange={(event) => {
								const inputs = tool.inputs.map((item, i) => (i === inputIndex ? { ...item, name: event.target.value } : item));
								updateTool(index, { inputs });
							}} />
							<input className="input" placeholder="Placeholder" value={entry.placeholder} onChange={(event) => {
								const inputs = tool.inputs.map((item, i) => (i === inputIndex ? { ...item, placeholder: event.target.value } : item));
								updateTool(index, { inputs });
							}} />
							<input className="input" placeholder="Description" value={entry.description} onChange={(event) => {
								const inputs = tool.inputs.map((item, i) => (i === inputIndex ? { ...item, description: event.target.value } : item));
								updateTool(index, { inputs });
							}} />
							<label className="sync-toggle">
								<input
									type="checkbox"
									checked={entry.required !== false}
									onChange={(event) => {
										const inputs = tool.inputs.map((item, i) => (i === inputIndex ? { ...item, required: event.target.checked } : item));
										updateTool(index, { inputs });
									}}
								/>
								Required
							</label>
							<button
								type="button"
								className="btn btn--sm btn--ghost"
								onClick={() => updateTool(index, { inputs: tool.inputs.filter((_, i) => i !== inputIndex) })}
							>
								Remove input
							</button>
						</div>
					))}
					<div className="catalog-block-head">
						<span className="catalog-field-label">Tokens</span>
						<button
							type="button"
							className="btn btn--sm"
							onClick={() => updateTool(index, { tokens: { ...tool.tokens, [`TOKEN_${Object.keys(tool.tokens).length + 1}`]: "" } })}
						>
							Add token
						</button>
					</div>
					{Object.entries(tool.tokens).map(([key, value]) => (
						<div key={key} className="sync-step-form__grid">
							<input
								className="input"
								value={key}
								aria-label="Token name"
								onChange={(event) => {
									const next: Record<string, string> = {};
									for (const [currentKey, currentValue] of Object.entries(tool.tokens)) {
										next[currentKey === key ? event.target.value : currentKey] = currentValue;
									}
									updateTool(index, { tokens: next });
								}}
							/>
							<input
								className="input"
								value={value}
								aria-label="Token value"
								onChange={(event) => updateTool(index, { tokens: { ...tool.tokens, [key]: event.target.value } })}
							/>
							<button
								type="button"
								className="btn btn--sm btn--ghost"
								onClick={() => {
									const next = { ...tool.tokens };
									delete next[key];
									updateTool(index, { tokens: next });
								}}
							>
								Remove token
							</button>
						</div>
					))}
				</div>
			))}
			<div className="sync-step-form__actions">
				<button type="button" className="btn" onClick={onCancel}>
					Cancel
				</button>
				{tcp ? (
					<button type="button" className="btn" disabled={!actions.export} onClick={() => void onExport()}>
						Export
					</button>
				) : null}
				{tcp ? (
					<button type="button" className="btn btn--ghost" disabled={!actions.delete || busy} onClick={() => void onDelete()}>
						Delete
					</button>
				) : null}
				<button className="btn btn--on" disabled={!canWrite || busy || !name.trim()}>
					{busy ? "Saving…" : "Save"}
				</button>
			</div>
		</form>
	);
}
