import { useRef, useState, type FormEvent } from "react";
import { createTemplate, deleteTemplate, exportCatalog, importTemplateBundle, splitTags, updateTemplate } from "../api/catalog.ts";
import { CommandStepFields } from "./CommandStepFields.tsx";
import { SyncRolesPicker, syncRolesCardMeta } from "./SyncRolesPicker.tsx";
import type {
	CatalogActions,
	FieldError,
	PipelineError,
	ResourceSelection,
	ResourceSet,
	ResourceSetsResponse,
	Tcp,
	TcpSelection,
	TcpsResponse,
	Template,
	TemplateImportWarning,
	TemplateStep,
	TemplatesResponse,
	Pipeline,
	PipelinesResponse,
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

/** What a template import made, for the report box. `warnings` are already written out in English. */
interface ImportReport {
	templates: number;
	created: number;
	reused: number;
	warnings: string[];
}

/** One warning, in plain English, naming the template or the pipeline it is about. */
function warningText(warning: TemplateImportWarning): string {
	if (warning.code === "pipeline_name_conflict") {
		return `Pipeline "${warning.name}" has the name of an existing pipeline but different text. It was imported as a separate pipeline.`;
	}
	const step = `Template "${warning.template}", step ${warning.stepIndex + 1}`;
	return warning.reason === "missing_ref"
		? `${step}: the bundle names no pipeline for this step, so the step has none.`
		: `${step}: the pipeline it names is not in this organization, so the step has none.`;
}

/** Why a template import was refused. An invalid embedded pipeline names its first problem, so the author can find it. */
function importFailureText(failure: { error: string; errors?: FieldError[] }): string {
	if (failure.error === "invalid_pipeline") {
		// The pipeline parser's problems carry a line and a path, not a field and code.
		const problem = failure.errors?.[0] as Partial<PipelineError> | undefined;
		const where = problem?.path ? `${problem.path}: ` : "";
		return `A pipeline in the bundle is not valid, so nothing was imported. ${where}${problem?.message ?? ""}`.trim();
	}
	if (failure.error === "unsupported_schema_version") {
		return "This bundle was made by a newer version of Target Server, so it cannot be imported here.";
	}
	return failure.error;
}

function ImportReportBox({ report, onDismiss }: { report: ImportReport; onDismiss: () => void }) {
	return (
		<section className="panel-note" aria-label="Import result">
			<p>
				Imported {report.templates} template{report.templates === 1 ? "" : "s"}. Pipelines: {report.created} created,{" "}
				{report.reused} reused.
			</p>
			{report.created > 0 ? (
				<p>
					Created pipelines have no sync roles yet, so no hub receives them. Assign them roles to let hubs receive them.
				</p>
			) : null}
			{report.warnings.length > 0 ? (
				<>
					<p>Check these after the import:</p>
					<ul>
						{report.warnings.map((text, index) => (
							<li key={`${index}:${text}`}>{text}</li>
						))}
					</ul>
				</>
			) : null}
			<button type="button" className="btn" onClick={onDismiss}>
				Dismiss
			</button>
		</section>
	);
}

export function TemplatesPanel({
	actions,
	canReadTcps,
	canReadRci,
	canReadPipelines,
}: {
	actions: CatalogActions;
	canReadTcps: boolean;
	canReadRci: boolean;
	canReadPipelines: boolean;
}) {
	const [refreshKey, setRefreshKey] = useState(0);
	const { data, error } = useApi<TemplatesResponse>(actions.read ? `/api/templates?_=${refreshKey}` : null);
	const { data: tcpsData } = useApi<TcpsResponse>(canReadTcps ? `/api/tcps?_=${refreshKey}` : null);
	const { data: setsData } = useApi<ResourceSetsResponse>(canReadRci ? `/api/resource-sets?_=${refreshKey}` : null);
		const { data: pipelinesData } = useApi<PipelinesResponse>(canReadPipelines ? `/api/pipelines?_=${refreshKey}` : null);
	const [overlay, setOverlay] = useState<Template | null>(null);
	const templates = data?.templates ?? [];
	const visibleTemplates = overlay && !templates.some((item) => item.id === overlay.id) ? [overlay, ...templates] : templates;
	const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [importOpen, setImportOpen] = useState(false);
	const [importText, setImportText] = useState("");
	const [importReport, setImportReport] = useState<ImportReport | null>(null);
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
		setImportReport(null);
		const result = await importTemplateBundle(parsed);
		if (!result.ok) {
			setNotice(importFailureText(result));
			return;
		}
		const pipelines = result.data.pipelines;
		const created = pipelines.filter((entry) => entry.action === "created").length;
		setNotice(null);
		setImportReport({
			templates: result.data.templates.length,
			created,
			reused: pipelines.length - created,
			warnings: result.data.warnings.map(warningText),
		});
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
			{importReport ? <ImportReportBox report={importReport} onDismiss={() => setImportReport(null)} /> : null}
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
								{` · ${syncRolesCardMeta(item.syncRoleIds)}`}
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
						pipelines={pipelinesData?.pipelines ?? []}
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

/**
 * A step as the server takes it. An agent step carries no kind; a command step
 * carries its pipeline and its inputs, and never a subagent or acceptance criteria.
 */
function toPayloadStep(step: TemplateStep, pipelines: Pipeline[]): TemplateStep {
	const description = step.description.trim();
	const notes = step.notes ? { notes: step.notes } : {};
	if (step.kind === "command") {
		const pipelineName = pipelines.find((item) => item.id === step.pipelineId)?.name ?? step.pipeline?.name ?? "";
		return {
			kind: "command",
			pipelineId: step.pipelineId ?? null,
			pipelineInputs: step.pipelineInputs ?? {},
			description: description || pipelineName,
			acceptanceCriteria: null,
			manualReview: step.manualReview,
			useSubagent: false,
			maxRetries: step.maxRetries,
			retryIntervalSeconds: step.retryIntervalSeconds,
			onSuccessTask: step.onSuccessTask?.trim() || null,
			onFailureTask: step.onFailureTask?.trim() || null,
			...notes,
		};
	}
	return {
		description,
		acceptanceCriteria: step.acceptanceCriteria?.trim() || null,
		manualReview: step.manualReview,
		useSubagent: step.useSubagent,
		maxRetries: step.maxRetries,
		retryIntervalSeconds: step.retryIntervalSeconds,
		...notes,
	};
}

function TemplateEditor({
	template,
	tcps,
	resourceSets,
	pipelines,
	actions,
	onCancel,
	onSaved,
	onDeleted,
}: {
	template: Template | null;
	tcps: Tcp[];
	resourceSets: ResourceSet[];
	pipelines: Pipeline[];
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
	const [syncRoleIds, setSyncRoleIds] = useState<string[]>(template?.syncRoleIds ?? []);
	const [busy, setBusy] = useState(false);
	const canWrite = template ? actions.edit : actions.create;
		const commandWithoutPipeline = steps.some((step) => step.kind === "command" && !step.pipelineId);

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
					.map((step) => toPayloadStep(step, pipelines))
					.filter((step) => step.description !== ""),
			tcpSelections,
			resourceSelections,
			syncRoleIds,
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
			<SyncRolesPicker
				selectedIds={syncRoleIds}
				onChange={setSyncRoleIds}
				disabled={!canWrite}
				permissionHint="A listed role can sync this resource only if it also has the client.templates.sync permission."
			/>
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
							<span>Step type</span>
							<select
								className="input"
								disabled={!canWrite}
								value={step.kind === "command" ? "command" : "task"}
								onChange={(event) =>
									updateStep(
										index,
										event.target.value === "command"
											? { kind: "command", useSubagent: false, acceptanceCriteria: null }
											: { kind: "task", useSubagent: true, onSuccessTask: null, onFailureTask: null },
									)
								}
							>
								<option value="task">Agent step</option>
								<option value="command">Command (runs a pipeline)</option>
							</select>
						</label>
						{step.kind === "command" ? (
							<CommandStepFields step={step} pipelines={pipelines} disabled={!canWrite} onChange={(patch) => updateStep(index, patch)} />
						) : null}
					{step.kind === "command" ? null : (
							<label className="catalog-field">
						<span>Acceptance criteria</span>
						<textarea
							className="input sync-context-input"
							rows={2}
							value={step.acceptanceCriteria ?? ""}
							onChange={(event) => updateStep(index, { acceptanceCriteria: event.target.value || null })}
						/>
					</label>
						)}
					<div className="sync-step-form__toggles">
						{step.kind === "command" ? null : (
							<label className="sync-toggle">
							<input type="checkbox" checked={step.useSubagent !== false} onChange={(event) => updateStep(index, { useSubagent: event.target.checked })} />
							Subagent
						</label>
						)}
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
				<button className="btn btn--on" disabled={!canWrite || busy || !name.trim() || commandWithoutPipeline}>
					{busy ? "Saving…" : "Save"}
				</button>
			</div>
		</form>
	);
}
