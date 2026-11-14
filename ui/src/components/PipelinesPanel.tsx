import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
	createPipeline,
	deletePipeline,
	exportCatalog,
	importCatalog,
	splitTags,
	updatePipeline,
	validatePipeline,
} from "../api/catalog.ts";
import type {
	CatalogActions,
	FieldError,
	Pipeline,
	PipelineError,
	PipelineImportResponse,
	PipelineValidation,
	PipelinesResponse,
} from "../api/types.ts";
import { useApi } from "../hooks/useApi.ts";
import { timeAgo } from "../lib/format.ts";
import { SyncRolesPicker, syncRolesCardMeta } from "./SyncRolesPicker.tsx";

/** A pipeline is a small YAML file; the hub refuses anything bigger, so the upload refuses it too. */
export const PIPELINE_MAX_BYTES = 64 * 1024;
/** Quiet time after the last keystroke before the YAML is checked on the server. */
const VALIDATE_DELAY_MS = 400;

const STARTER_YAML = `name: example
description: Run the test suite.
steps:
  - name: Test
    run: npm test
`;

/** A checked source, kept with the text it was checked against so a stale answer is never shown. */
interface Checked {
	source: string;
	value: PipelineValidation;
}

/**
 * Reads an uploaded YAML file in the browser and returns its text. Nothing is
 * sent anywhere here: the text lands in the editor, and only Save writes it.
 */
export async function readPipelineFile(file: File): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	if (!/\.ya?ml$/i.test(file.name)) return { ok: false, error: "Choose a .yaml or .yml file." };
	if (file.size > PIPELINE_MAX_BYTES) {
		return { ok: false, error: `That file is ${Math.ceil(file.size / 1024)} KiB. A pipeline can be at most 64 KiB.` };
	}
	const bytes = await file.arrayBuffer();
	if (bytes.byteLength > PIPELINE_MAX_BYTES) {
		return { ok: false, error: "That file is larger than 64 KiB." };
	}
	try {
		return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
	} catch {
		return { ok: false, error: "That file is not UTF-8 text." };
	}
}

/** The server's field errors, with the line they point at when it sends one. */
function asPipelineErrors(errors: FieldError[]): PipelineError[] {
	return errors.map((item) => {
		const raw = item as { line?: unknown; path?: unknown; field?: unknown };
		return {
			line: typeof raw.line === "number" ? raw.line : null,
			path: typeof raw.path === "string" ? raw.path : typeof raw.field === "string" ? raw.field : "",
			message: item.message,
		};
	});
}

/** The character span of a 1-based line in the source, for the error list's "go to line". */
function offsetOfLine(source: string, line: number): { start: number; end: number } | null {
	const lines = source.split("\n");
	if (line < 1 || line > lines.length) return null;
	let start = 0;
	for (let i = 0; i < line - 1; i++) start += (lines[i]?.length ?? 0) + 1;
	return { start, end: start + (lines[line - 1]?.length ?? 0) };
}

export function PipelinesPanel({ actions }: { actions: CatalogActions }) {
	const [refreshKey, setRefreshKey] = useState(0);
	const { data, error } = useApi<PipelinesResponse>(actions.read ? `/api/pipelines?_=${refreshKey}` : null);
	const [overlay, setOverlay] = useState<Pipeline | null>(null);
	const pipelines = data?.pipelines ?? [];
	const visiblePipelines = overlay && !pipelines.some((item) => item.id === overlay.id) ? [overlay, ...pipelines] : pipelines;
	const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
	/** Text for a new pipeline that came from an upload or a drop. Set only together with `selectedId === "new"`. */
	const [draft, setDraft] = useState<{ key: number; source: string } | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [importOpen, setImportOpen] = useState(false);
	const [importText, setImportText] = useState("");
	const [dragging, setDragging] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);
	const importFileRef = useRef<HTMLInputElement>(null);
	const selected =
		selectedId && selectedId !== "new" ? (visiblePipelines.find((item) => item.id === selectedId) ?? null) : null;

	async function onExportAll() {
		const result = await exportCatalog("/api/pipelines/export", "pipelines-export.json");
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
		const result = await importCatalog<PipelineImportResponse>("/api/pipelines/import", parsed);
		if (!result.ok) {
			setNotice(result.error);
			return;
		}
		// A pipeline whose text is already here is reused, not copied: say which were new.
		const total = result.data.results.length;
		const reused = result.data.results.filter((entry) => entry.action === "reused").length;
		setNotice(`Imported ${total} pipeline${total === 1 ? "" : "s"}: ${total - reused} created, ${reused} already here.`);
		setImportOpen(false);
		setImportText("");
		setRefreshKey((key) => key + 1);
	}

	/** Opens a new-pipeline editor on an uploaded file's text. A name already in use is refused, never overwritten. */
	async function openUpload(file: File) {
		if (!actions.create) return;
		const read = await readPipelineFile(file);
		if (!read.ok) {
			setNotice(read.error);
			return;
		}
		const check = await validatePipeline(read.text);
		const name = check.ok && check.data.ok ? check.data.name : undefined;
		if (name && pipelines.some((item) => item.name === name)) {
			setNotice(`A pipeline named “${name}” already exists. An upload never replaces it: rename the YAML or edit the existing pipeline.`);
			return;
		}
		setNotice(null);
		setDraft({ key: Date.now(), source: read.text });
		setSelectedId("new");
	}

	function onDrop(event: DragEvent<HTMLDivElement>) {
		event.preventDefault();
		setDragging(false);
		const file = event.dataTransfer.files[0];
		if (file) void openUpload(file);
	}

	if (!actions.read) {
		return <p className="panel-note">Your role cannot view pipelines on this server.</p>;
	}

	return (
		<div
			className={`catalog pipelines${dragging && actions.create ? " pipelines--dragging" : ""}`}
			onDragOver={(event) => {
				if (!actions.create) return;
				event.preventDefault();
				setDragging(true);
			}}
			onDragLeave={(event) => {
				if (event.currentTarget === event.target) setDragging(false);
			}}
			onDrop={onDrop}
		>
			<div className="catalog-toolbar">
				<button type="button" className="btn btn--on" disabled={!actions.create} onClick={() => { setDraft(null); setSelectedId("new"); }}>
					New
				</button>
				<button type="button" className="btn" disabled={!actions.create} onClick={() => fileRef.current?.click()}>
					Upload YAML
				</button>
				<input
					ref={fileRef}
					type="file"
					accept=".yaml,.yml,text/yaml,application/x-yaml"
					className="sr-only"
					aria-label="Upload pipeline YAML"
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) void openUpload(file);
						event.target.value = "";
					}}
				/>
				<button type="button" className="btn" disabled={!actions.import} onClick={() => setImportOpen(true)}>
					Import JSON
				</button>
				<button type="button" className="btn" disabled={!actions.export || visiblePipelines.length === 0} onClick={() => void onExportAll()}>
					Export all
				</button>
			</div>
			<p className="hint">Drop a .yaml file anywhere on this panel to open it as a new pipeline (64 KiB at most).</p>
			{notice ? <div className={notice.startsWith("Imported") || notice.startsWith("Downloaded") ? "panel-note" : "err"} role="status">{notice}</div> : null}
			{error ? <div className="err">{`Could not load pipelines: ${error}`}</div> : null}
			<div className="catalog-layout">
				<div className="catalog-list" aria-label="Pipelines">
					{visiblePipelines.length === 0 ? <div className="empty">No pipelines yet.</div> : null}
					{visiblePipelines.map((item) => (
						<button
							key={item.id}
							type="button"
							className={`catalog-card${item.id === selectedId ? " catalog-card--active" : ""}`}
							onClick={() => {
								setDraft(null);
								setSelectedId(item.id);
							}}
						>
							<span className="catalog-card-name">{item.name}</span>
							<span className="catalog-card-meta">
								{item.tags.length ? `${item.tags.join(", ")} · ` : ""}
								updated {timeAgo(item.updatedAt)}
								{` · ${syncRolesCardMeta(item.syncRoleIds)}`}
							</span>
						</button>
					))}
				</div>
				{selectedId ? (
					<PipelineEditor
						key={selectedId === "new" ? `new:${draft?.key ?? 0}` : `${selectedId}:${selected?.updatedAt ?? ""}`}
						pipeline={selected}
						initialSource={selectedId === "new" ? (draft?.source ?? STARTER_YAML) : undefined}
						actions={actions}
						onCancel={() => {
							setDraft(null);
							setSelectedId(null);
						}}
						onSaved={(item) => {
							setDraft(null);
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
					<p className="panel-note">Pick a pipeline to edit, or create a new one.</p>
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
					<h3>Import pipelines</h3>
					<p className="hint">Paste a pipelines bundle (JSON) exported from this server or a hub.</p>
					<input
						ref={importFileRef}
						type="file"
						accept="application/json,.json"
						className="sr-only"
						aria-label="Import file"
						onChange={(event) => {
							const file = event.target.files?.[0];
							if (file) void file.text().then(setImportText);
							event.target.value = "";
						}}
					/>
					<div className="sync-create-row">
						<button type="button" className="btn" onClick={() => importFileRef.current?.click()}>
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

function PipelineEditor({
	pipeline,
	initialSource,
	actions,
	onCancel,
	onSaved,
	onDeleted,
}: {
	pipeline: Pipeline | null;
	initialSource?: string | undefined;
	actions: CatalogActions;
	onCancel: () => void;
	onSaved: (item: Pipeline) => void;
	onDeleted: () => void;
}) {
	const [source, setSource] = useState(pipeline?.source ?? initialSource ?? STARTER_YAML);
	const [tags, setTags] = useState(pipeline?.tags.join(", ") ?? "");
	const [syncRoleIds, setSyncRoleIds] = useState<string[]>(pipeline?.syncRoleIds ?? []);
	const [checked, setChecked] = useState<Checked | null>(null);
	const [serverErrors, setServerErrors] = useState<PipelineError[]>([]);
	const [serverMessage, setServerMessage] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const canWrite = pipeline ? actions.edit : actions.create;

	// Debounced server check. Each keystroke restarts the timer; a late answer for an
	// older text is dropped by the cleanup, so the list never shows errors for other YAML.
	useEffect(() => {
		if (source.trim() === "") return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void validatePipeline(source).then((result) => {
				if (cancelled) return;
				const value: PipelineValidation = result.ok
					? result.data
					: { ok: false, errors: [{ line: null, path: "", message: result.error }] };
				setChecked({ source, value });
			});
		}, VALIDATE_DELAY_MS);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [source]);

	const current = checked && checked.source === source ? checked.value : null;
	const empty = source.trim() === "";
	const valid = current?.ok === true && !empty;
	const errors: PipelineError[] = current && !current.ok ? current.errors : [];

	function goToLine(line: number | null) {
		const textarea = textareaRef.current;
		if (!textarea || line == null) return;
		const span = offsetOfLine(source, line);
		if (!span) return;
		textarea.focus();
		textarea.setSelectionRange(span.start, span.end);
	}

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (!valid || !canWrite || busy) return;
		setBusy(true);
		setServerErrors([]);
		setServerMessage(null);
		const input = { source, tags: splitTags(tags), syncRoleIds };
		const result = pipeline ? await updatePipeline(pipeline.id, input) : await createPipeline(input);
		setBusy(false);
		if (!result.ok) {
			setServerErrors(asPipelineErrors(result.errors ?? []));
			setServerMessage(result.errors?.length ? "The server refused this YAML. Fix the lines below and save again." : result.error);
			return;
		}
		onSaved(result.data.pipeline);
	}

	async function onDelete() {
		if (!pipeline || !window.confirm(`Delete pipeline “${pipeline.name}”?`)) return;
		const result = await deletePipeline(pipeline.id);
		if (result.ok) {
			onDeleted();
			return;
		}
		setServerMessage(
			result.error === "in_use"
				? "A template still runs this pipeline. Remove its command step first."
				: result.error,
		);
	}

	async function onExport() {
		if (!pipeline) return;
		await exportCatalog(`/api/pipelines/${encodeURIComponent(pipeline.id)}/export`, `pipeline-${pipeline.id}.json`);
	}

	const status = empty
		? "Write the pipeline YAML to save it."
		: current === null
			? "Checking…"
			: valid
				? `Valid${current.name ? `: ${current.name}` : ""}.`
				: `${errors.length} problem${errors.length === 1 ? "" : "s"} to fix before saving.`;

	// After a refused save the server's list is the one to show; otherwise the live check's.
	const allErrors = serverErrors.length > 0 ? serverErrors : errors;

	return (
		<form className="catalog-editor sync-step-form" onSubmit={(event) => void onSubmit(event)}>
			<h3>{pipeline ? "Edit pipeline" : "New pipeline"}</h3>
			<label className="catalog-field">
				<span>Pipeline YAML</span>
				<textarea
					ref={textareaRef}
					className="input pipeline-source"
					rows={16}
					spellCheck={false}
					autoCapitalize="off"
					autoCorrect="off"
					value={source}
					aria-invalid={!valid && !empty}
					aria-describedby="pipeline-status"
					onChange={(event) => {
						setServerErrors([]);
						setServerMessage(null);
						setSource(event.target.value);
					}}
					readOnly={!canWrite}
				/>
			</label>
			<p id="pipeline-status" className={valid ? "hint pipeline-status pipeline-status--ok" : "hint pipeline-status"} aria-live="polite">
				{status}
			</p>
			{allErrors.length > 0 ? (
				<ol className="pipeline-errors" aria-label="YAML errors">
					{allErrors.map((item, index) => (
						<li key={`${item.line ?? "x"}:${index}`}>
							{item.line != null ? (
								<button type="button" className="pipeline-errors__line btn btn--sm btn--ghost" onClick={() => goToLine(item.line)}>
									Line {item.line}
								</button>
							) : null}
							<span>
								{item.path ? <code>{item.path}</code> : null}
								{item.path ? " — " : null}
								{item.message}
							</span>
						</li>
					))}
				</ol>
			) : null}
			{serverMessage ? <div className="err" role="alert">{serverMessage}</div> : null}
			<label className="catalog-field">
				<span>Tags</span>
				<input className="input" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="ci, release" disabled={!canWrite} />
			</label>
			<SyncRolesPicker
				selectedIds={syncRoleIds}
				onChange={setSyncRoleIds}
				disabled={!canWrite}
				permissionHint="A listed role can sync this pipeline only if it also has the client.pipelines.sync permission."
			/>
			<div className="sync-step-form__actions">
				<button type="button" className="btn" onClick={onCancel}>
					Cancel
				</button>
				{pipeline ? (
					<button type="button" className="btn" disabled={!actions.export} onClick={() => void onExport()}>
						Export JSON
					</button>
				) : null}
				{pipeline ? (
					<button type="button" className="btn btn--ghost" disabled={!actions.delete || busy} onClick={() => void onDelete()}>
						Delete
					</button>
				) : null}
				<button className="btn btn--on" disabled={!canWrite || busy || !valid}>
					{busy ? "Saving…" : "Save"}
				</button>
			</div>
		</form>
	);
}
