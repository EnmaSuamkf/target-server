import { useRef, useState, type FormEvent } from "react";
import { createResourceSet, deleteResourceSet, exportCatalog, importCatalog, splitTags, updateResourceSet } from "../api/catalog.ts";
import type { CatalogActions, Resource, ResourceFile, ResourceKind, ResourceSet, ResourceSetsResponse } from "../api/types.ts";
import { useApi } from "../hooks/useApi.ts";

const RESOURCE_KINDS: ResourceKind[] = ["skill", "agent", "doc"];
const KIND_LABELS: Record<ResourceKind, string> = { skill: "Skill", agent: "Agent", doc: "Document" };

function defaultEntryFile(kind: ResourceKind, name: string): string {
	if (kind === "skill") return "SKILL.md";
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${slug || "resource"}.md`;
}

const emptyResource = (): Resource => ({
	name: "",
	description: "",
	kind: "skill",
	entryFile: "SKILL.md",
	content: "",
	files: [],
});

const emptyFile = (): ResourceFile => ({ path: "", content: "" });

export function ResourceSetsPanel({ actions }: { actions: CatalogActions }) {
	const [refreshKey, setRefreshKey] = useState(0);
	const { data, error } = useApi<ResourceSetsResponse>(actions.read ? `/api/resource-sets?_=${refreshKey}` : null);
	const [overlay, setOverlay] = useState<ResourceSet | null>(null);
	const sets = data?.resourceSets ?? [];
	const visibleSets = overlay && !sets.some((item) => item.id === overlay.id) ? [overlay, ...sets] : sets;
	const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [importOpen, setImportOpen] = useState(false);
	const [importText, setImportText] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);
	const selected = selectedId && selectedId !== "new"
		? (visibleSets.find((item) => item.id === selectedId) ?? (overlay?.id === selectedId ? overlay : null))
		: null;

	async function onExportAll() {
		const result = await exportCatalog("/api/resource-sets/export", "resource-sets-export.json");
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
		const result = await importCatalog<ResourceSetsResponse>("/api/resource-sets/import", parsed);
		if (!result.ok) {
			setNotice(result.error);
			return;
		}
		setNotice(`Imported ${result.data.resourceSets.length} resource set${result.data.resourceSets.length === 1 ? "" : "s"}.`);
		setImportOpen(false);
		setImportText("");
		setRefreshKey((key) => key + 1);
	}

	if (!actions.read) {
		return <p className="panel-note">Your role cannot view RCI resource sets on this server.</p>;
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
				<button type="button" className="btn" disabled={!actions.export || visibleSets.length === 0} onClick={() => void onExportAll()}>
					Export all
				</button>
			</div>
			{notice ? <div className={notice.includes("Imported") || notice.startsWith("Downloaded") ? "panel-note" : "err"}>{notice}</div> : null}
			{error ? <div className="err">{`Could not load resource sets: ${error}`}</div> : null}
			<div className="catalog-layout">
				<div className="catalog-list" aria-label="Resource sets">
					{visibleSets.length === 0 ? <div className="empty">No resource sets yet.</div> : null}
					{visibleSets.map((item) => (
						<button
							key={item.id}
							type="button"
							className={`catalog-card${item.id === selectedId ? " catalog-card--active" : ""}`}
							onClick={() => setSelectedId(item.id)}
						>
							<span className="catalog-card-name">{item.name}</span>
							<span className="catalog-card-meta">
								{item.resources.length} resource{item.resources.length === 1 ? "" : "s"}
								{item.tags.length ? ` · ${item.tags.join(", ")}` : ""}
							</span>
						</button>
					))}
				</div>
				{selectedId ? (
					<ResourceSetEditor
						key={`${selectedId}:${selected?.updatedAt ?? "new"}`}
						resourceSet={selected}
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
					<p className="panel-note">Pick a resource set to edit, or create a new one.</p>
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
					<h3>Import resource sets</h3>
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

function ResourceSetEditor({
	resourceSet,
	actions,
	onCancel,
	onSaved,
	onDeleted,
}: {
	resourceSet: ResourceSet | null;
	actions: CatalogActions;
	onCancel: () => void;
	onSaved: (item: ResourceSet) => void;
	onDeleted: () => void;
}) {
	const [name, setName] = useState(resourceSet?.name ?? "");
	const [tags, setTags] = useState(resourceSet?.tags.join(", ") ?? "");
	const [resources, setResources] = useState<Resource[]>(resourceSet?.resources.length ? resourceSet.resources : [emptyResource()]);
	const [busy, setBusy] = useState(false);
	const canWrite = resourceSet ? actions.edit : actions.create;

	const updateResource = (index: number, patch: Partial<Resource>) => {
		setResources((current) => current.map((resource, i) => (i === index ? { ...resource, ...patch } : resource)));
	};

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (!name.trim() || busy) return;
		setBusy(true);
		const input = {
			name: name.trim(),
			tags: splitTags(tags),
			resources: resources
				.map((resource) => ({
					...resource,
					name: resource.name.trim(),
					description: resource.description.trim(),
					files: resource.files.filter((file) => file.path.trim() !== ""),
				}))
				.filter((resource) => resource.name !== ""),
		};
		const result = resourceSet ? await updateResourceSet(resourceSet.id, input) : await createResourceSet(input);
		setBusy(false);
		if (!result.ok) return;
		onSaved(result.data.resourceSet);
	}

	async function onDelete() {
		if (!resourceSet || !window.confirm(`Delete resource set “${resourceSet.name}”?`)) return;
		const result = await deleteResourceSet(resourceSet.id);
		if (result.ok) onDeleted();
	}

	async function onExport() {
		if (!resourceSet) return;
		await exportCatalog(`/api/resource-sets/${encodeURIComponent(resourceSet.id)}/export`, `resource-set-${resourceSet.id}.json`);
	}

	return (
		<form className="catalog-editor sync-step-form" onSubmit={(event) => void onSubmit(event)}>
			<h3>{resourceSet ? "Edit resource set" : "New resource set"}</h3>
			<label className="catalog-field">
				<span>Name</span>
				<input className="input" required value={name} onChange={(event) => setName(event.target.value)} />
			</label>
			<label className="catalog-field">
				<span>Tags</span>
				<input className="input" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="docs, skills" />
			</label>
			<div className="catalog-block-head">
				<span className="catalog-field-label">Resources</span>
				<button type="button" className="btn btn--sm" onClick={() => setResources((current) => [...current, emptyResource()])}>
					Add resource
				</button>
			</div>
			{resources.map((resource, index) => (
				<div key={index} className="catalog-block">
					<div className="catalog-block-head">
						<strong>Resource {index + 1}</strong>
						<button type="button" className="btn btn--sm btn--ghost" onClick={() => setResources((current) => current.filter((_, i) => i !== index))}>
							Remove
						</button>
					</div>
					<label className="catalog-field">
						<span>Name</span>
						<input className="input" value={resource.name} onChange={(event) => updateResource(index, { name: event.target.value })} />
					</label>
					<label className="catalog-field">
						<span>Description</span>
						<input className="input" value={resource.description} onChange={(event) => updateResource(index, { description: event.target.value })} />
					</label>
					<label className="catalog-field">
						<span>Kind</span>
						<select
							className="input"
							value={resource.kind}
							onChange={(event) => {
								const kind = event.target.value as ResourceKind;
								const untouched =
									resource.entryFile.trim() === "" || resource.entryFile === defaultEntryFile(resource.kind, resource.name);
								updateResource(index, { kind, ...(untouched ? { entryFile: defaultEntryFile(kind, resource.name) } : {}) });
							}}
						>
							{RESOURCE_KINDS.map((kind) => (
								<option key={kind} value={kind}>
									{KIND_LABELS[kind]}
								</option>
							))}
						</select>
					</label>
					<label className="catalog-field">
						<span>Entry file</span>
						<input className="input" value={resource.entryFile} onChange={(event) => updateResource(index, { entryFile: event.target.value })} placeholder="SKILL.md" />
					</label>
					<label className="catalog-field">
						<span>Content</span>
						<textarea className="input sync-context-input" rows={8} value={resource.content} onChange={(event) => updateResource(index, { content: event.target.value })} />
					</label>
					<div className="catalog-block-head">
						<span className="catalog-field-label">Extra files</span>
						<button
							type="button"
							className="btn btn--sm"
							onClick={() => updateResource(index, { files: [...resource.files, emptyFile()] })}
						>
							Add file
						</button>
					</div>
					{resource.files.map((file, fileIndex) => (
						<div key={fileIndex} className="catalog-block">
							<label className="catalog-field">
								<span>Path</span>
								<input
									className="input"
									value={file.path}
									onChange={(event) => {
										const files = resource.files.map((item, i) => (i === fileIndex ? { ...item, path: event.target.value } : item));
										updateResource(index, { files });
									}}
									placeholder="references/notes.md"
								/>
							</label>
							<label className="catalog-field">
								<span>File content</span>
								<textarea
									className="input sync-context-input"
									rows={4}
									value={file.content}
									onChange={(event) => {
										const files = resource.files.map((item, i) => (i === fileIndex ? { ...item, content: event.target.value } : item));
										updateResource(index, { files });
									}}
								/>
							</label>
							<button
								type="button"
								className="btn btn--sm btn--ghost"
								onClick={() => updateResource(index, { files: resource.files.filter((_, i) => i !== fileIndex) })}
							>
								Remove file
							</button>
						</div>
					))}
				</div>
			))}
			<div className="sync-step-form__actions">
				<button type="button" className="btn" onClick={onCancel}>
					Cancel
				</button>
				{resourceSet ? (
					<button type="button" className="btn" disabled={!actions.export} onClick={() => void onExport()}>
						Export
					</button>
				) : null}
				{resourceSet ? (
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
