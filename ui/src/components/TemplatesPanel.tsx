import { useRef, useState, type FormEvent } from "react";
import { createTemplate, deleteTemplate, exportCatalog, importCatalog, splitTags, updateTemplate } from "../api/catalog.ts";
import type {
	CatalogActions,
	ResourceSelection,
	ResourceSet,
	ResourceSetsResponse,
	Tcp,
	TcpSelection,
	TcpsResponse,
	Template,
	TemplateStep,
	TemplatesResponse,
} from "../api/types.ts";
import { useApi } from "../hooks/useApi.ts";

const emptyStep = (): TemplateStep => ({
	description: "",
	acceptanceCriteria: null,
	manualReview: false,
	useSubagent: true,
	maxRetries: 0,
	retryIntervalSeconds: 0,
});

export function TemplatesPanel({
	actions,
	canReadTcps,
	canReadRci,
}: {
	actions: CatalogActions;
	canReadTcps: boolean;
	canReadRci: boolean;
}) {
	const [refreshKey, setRefreshKey] = useState(0);
	const { data, error } = useApi<TemplatesResponse>(actions.read ? `/api/templates?_=${refreshKey}` : null);
	const { data: tcpsData } = useApi<TcpsResponse>(canReadTcps ? `/api/tcps?_=${refreshKey}` : null);
	const { data: setsData } = useApi<ResourceSetsResponse>(canReadRci ? `/api/resource-sets?_=${refreshKey}` : null);
	const [overlay, setOverlay] = useState<Template | null>(null);
	const templates = data?.templates ?? [];
	const visibleTemplates = overlay && !templates.some((item) => item.id === overlay.id) ? [overlay, ...templates] : templates;
	const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [importOpen, setImportOpen] = useState(false);
	const [importText, setImportText] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);
	const selected = selectedId && selectedId !== "new"
		? (visibleTemplates.find((item) => item.id === selectedId) ?? (overlay?.id === selectedId ? overlay : null))
		: null;

	async function onExportAll() {
		const result = await exportCatalog("/api/templates/export", "templates-export.json");
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
		const result = await importCatalog<TemplatesResponse>("/api/templates/import", parsed);
		if (!result.ok) {
			setNotice(result.error);
			return;
		}
		setNotice(`Imported ${result.data.templates.length} template${result.data.templates.length === 1 ? "" : "s"}.`);
		setImportOpen(false);
		setImportText("");
		setRefreshKey((key) => key + 1);
	}

	if (!actions.read) {
		return <p className="panel-note">Your role cannot view templates on this server.</p>;
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
				<button type="button" className="btn" disabled={!actions.export || visibleTemplates.length === 0} onClick={() => void onExportAll()}>
					Export all
				</button>
			</div>
			{notice ? <div className={notice.includes("Imported") || notice.startsWith("Downloaded") ? "panel-note" : "err"}>{notice}</div> : null}
			{error ? <div className="err">{`Could not load templates: ${error}`}</div> : null}
			<div className="catalog-layout">
				<div className="catalog-list" aria-label="Templates">
					{visibleTemplates.length === 0 ? <div className="empty">No templates yet.</div> : null}
					{visibleTemplates.map((item) => (
						<button
							key={item.id}
							type="button"
							className={`catalog-card${item.id === selectedId ? " catalog-card--active" : ""}`}
							onClick={() => setSelectedId(item.id)}
						>
							<span className="catalog-card-name">{item.name}</span>
							<span className="catalog-card-meta">
								{item.steps.length} step{item.steps.length === 1 ? "" : "s"}
								{item.tags.length ? ` · ${item.tags.join(", ")}` : ""}
							</span>
						</button>
					))}
				</div>
				{selectedId ? (
					<TemplateEditor
						key={`${selectedId}:${selected?.updatedAt ?? "new"}`}
						template={selected}
						tcps={tcpsData?.tcps ?? []}
						resourceSets={setsData?.resourceSets ?? []}
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
					<p className="panel-note">Pick a template to edit, or create a new one.</p>
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
					<h3>Import templates</h3>
					<p className="hint">Paste a hub-compatible bundle or a single template object.</p>
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

function TemplateEditor({
	template,
	tcps,
	resourceSets,
	actions,
	onCancel,
	onSaved,
	onDeleted,
}: {
	template: Template | null;
	tcps: Tcp[];
	resourceSets: ResourceSet[];
	actions: CatalogActions;
	onCancel: () => void;
	onSaved: (item: Template) => void;
	onDeleted: () => void;
}) {
	const [name, setName] = useState(template?.name ?? "");
	const [tags, setTags] = useState(template?.tags.join(", ") ?? "");
	const [steps, setSteps] = useState<TemplateStep[]>(template?.steps.length ? template.steps : [emptyStep()]);
	const [tcpSelections, setTcpSelections] = useState<TcpSelection[]>(template?.tcpSelections ?? []);
	const [resourceSelections, setResourceSelections] = useState<ResourceSelection[]>(template?.resourceSelections ?? []);
	const [busy, setBusy] = useState(false);
	const canWrite = template ? actions.edit : actions.create;

	const updateStep = (index: number, patch: Partial<TemplateStep>) => {
		setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));
	};

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (!name.trim() || busy) return;
		setBusy(true);
		const input = {
			name: name.trim(),
			tags: splitTags(tags),
			steps: steps
				.map((step) => ({ ...step, description: step.description.trim(), acceptanceCriteria: step.acceptanceCriteria?.trim() || null }))
				.filter((step) => step.description !== ""),
			tcpSelections,
			resourceSelections,
		};
		const result = template ? await updateTemplate(template.id, input) : await createTemplate(input);
		setBusy(false);
		if (!result.ok) return;
		onSaved(result.data.template);
	}

	async function onDelete() {
		if (!template || !window.confirm(`Delete template “${template.name}”?`)) return;
		const result = await deleteTemplate(template.id);
		if (result.ok) onDeleted();
	}

	async function onExport() {
		if (!template) return;
		await exportCatalog(`/api/templates/${encodeURIComponent(template.id)}/export`, `template-${template.id}.json`);
	}

	return (
		<form className="catalog-editor sync-step-form" onSubmit={(event) => void onSubmit(event)}>
			<h3>{template ? "Edit template" : "New template"}</h3>
			<label className="catalog-field">
				<span>Name</span>
				<input className="input" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Release checklist" />
			</label>
			<label className="catalog-field">
				<span>Tags</span>
				<input className="input" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="release, qa" />
			</label>
			<div className="catalog-block">
				<span className="catalog-field-label">TCP packs on this server</span>
				<div className="catalog-picker">
					{tcps.length === 0 ? <p className="hint">No TCP packs yet — create one in the TCP tools tab.</p> : null}
					{tcps.map((tcp) => {
						const selected = tcpSelections.find((item) => item.tcpId === tcp.id);
						return (
							<div key={tcp.id}>
								<label className="users-check">
									<input
										type="checkbox"
										checked={Boolean(selected)}
										onChange={(event) => {
											setTcpSelections((current) =>
												event.target.checked
													? [...current, { tcpId: tcp.id, toolNames: null }]
													: current.filter((item) => item.tcpId !== tcp.id),
											);
										}}
									/>
									{tcp.name}
								</label>
								{selected && tcp.tools.length > 0 ? (
									<div className="catalog-picker-tools">
										{tcp.tools.map((tool) => {
											const selectedTools = selected.toolNames ?? [];
											const all = selectedTools.length === 0;
											const checked = all || selectedTools.includes(tool.name);
											return (
												<label key={tool.name} className="users-check">
													<input
														type="checkbox"
														checked={checked}
														onChange={(event) => {
															setTcpSelections((current) =>
																current.map((item) => {
																	if (item.tcpId !== tcp.id) return item;
																	const names = all ? tcp.tools.map((entry) => entry.name) : [...(item.toolNames ?? [])];
																	const next = event.target.checked
																		? [...new Set([...names, tool.name])]
																		: names.filter((name) => name !== tool.name);
																	return { tcpId: tcp.id, toolNames: next.length === tcp.tools.length ? null : next };
																}),
															);
														}}
													/>
													{tool.name}
												</label>
											);
										})}
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			</div>
			<div className="catalog-block">
				<span className="catalog-field-label">Resource sets on this server</span>
				<div className="catalog-picker">
					{resourceSets.length === 0 ? <p className="hint">No resource sets yet — create one in the RCI tab.</p> : null}
					{resourceSets.map((set) => {
						const selected = resourceSelections.find((item) => item.resourceSetId === set.id);
						return (
							<label key={set.id} className="users-check">
								<input
									type="checkbox"
									checked={Boolean(selected)}
									onChange={(event) => {
										setResourceSelections((current) =>
											event.target.checked
												? [...current, { resourceSetId: set.id, resourceNames: null }]
												: current.filter((item) => item.resourceSetId !== set.id),
										);
									}}
								/>
								{set.name}
							</label>
						);
					})}
				</div>
			</div>
			<div className="catalog-block-head">
				<span className="catalog-field-label">Steps</span>
				<button type="button" className="btn btn--sm" onClick={() => setSteps((current) => [...current, emptyStep()])}>
					Add step
				</button>
			</div>
			{steps.map((step, index) => (
				<div key={index} className="catalog-block">
					<div className="catalog-block-head">
						<strong>Step {index + 1}</strong>
						<button type="button" className="btn btn--sm btn--ghost" onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}>
							Remove
						</button>
					</div>
					<label className="catalog-field">
						<span>Description</span>
						<textarea className="input sync-context-input" rows={3} value={step.description} onChange={(event) => updateStep(index, { description: event.target.value })} />
					</label>
					<label className="catalog-field">
						<span>Acceptance criteria</span>
						<textarea
							className="input sync-context-input"
							rows={2}
							value={step.acceptanceCriteria ?? ""}
							onChange={(event) => updateStep(index, { acceptanceCriteria: event.target.value || null })}
						/>
					</label>
					<div className="sync-step-form__toggles">
						<label className="sync-toggle">
							<input type="checkbox" checked={step.useSubagent !== false} onChange={(event) => updateStep(index, { useSubagent: event.target.checked })} />
							Subagent
						</label>
						<label className="sync-toggle">
							<input type="checkbox" checked={step.manualReview} onChange={(event) => updateStep(index, { manualReview: event.target.checked })} />
							Manual review
						</label>
					</div>
					<div className="sync-step-form__grid">
						<label className="catalog-field">
							<span>Max retries</span>
							<input
								className="input"
								type="number"
								min={0}
								value={step.maxRetries}
								onChange={(event) => updateStep(index, { maxRetries: Math.max(0, Number.parseInt(event.target.value, 10) || 0) })}
							/>
						</label>
						<label className="catalog-field">
							<span>Retry interval (s)</span>
							<input
								className="input"
								type="number"
								min={0}
								value={step.retryIntervalSeconds}
								onChange={(event) => updateStep(index, { retryIntervalSeconds: Math.max(0, Number.parseInt(event.target.value, 10) || 0) })}
							/>
						</label>
					</div>
				</div>
			))}
			<div className="sync-step-form__actions">
				<button type="button" className="btn" onClick={onCancel}>
					Cancel
				</button>
				{template ? (
					<button type="button" className="btn" disabled={!actions.export} onClick={() => void onExport()}>
						Export
					</button>
				) : null}
				{template ? (
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
