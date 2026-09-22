import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { downloadJson, exportRemoteResources, importRemoteResources, mutateRemoteResource } from "../api/sync.ts";
import type {
	RemoteResource,
	RemoteResourceActions,
	RemoteResourceBundle,
	RemoteResourceDomain,
	RemoteResourcesResponse,
	SyncClientRow,
} from "../api/types.ts";
import { useApi } from "../hooks/useApi.ts";
import { timeAgo } from "../lib/format.ts";

type DomainConfig = {
	id: RemoteResourceDomain;
	label: string;
	capability: "templates" | "tcp_tools" | "resource_sets";
	actions: RemoteResourceActions;
};

export function RemoteResourcesPanel({
	clients,
	templateActions,
	tcpActions,
	rciActions,
	onRefresh,
}: {
	clients: SyncClientRow[] | null;
	templateActions: RemoteResourceActions;
	tcpActions: RemoteResourceActions;
	rciActions: RemoteResourceActions;
	onRefresh: () => void;
}) {
	const domains: DomainConfig[] = useMemo(
		() => [
			{ id: "templates", label: "Templates", capability: "templates", actions: templateActions },
			{ id: "tcp-tools", label: "TCP tools", capability: "tcp_tools", actions: tcpActions },
			{ id: "resource-sets", label: "RCI resource sets", capability: "resource_sets", actions: rciActions },
		],
		[templateActions, tcpActions, rciActions],
	);
	const [clientId, setClientId] = useState("");
	const [domain, setDomain] = useState<RemoteResourceDomain>("templates");
	const [draft, setDraft] = useState<{ id: string; name: string; data: string } | null>(null);
	const [importOpen, setImportOpen] = useState(false);
	const [importText, setImportText] = useState("");
	const [notice, setNotice] = useState<string | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);
	const fileRef = useRef<HTMLInputElement>(null);
	const selectedClient = clients?.find((client) => client.id === clientId) ?? null;
	const config = domains.find((item) => item.id === domain) ?? domains[0]!;
	const commandPrefix = domain === "templates" ? "template" : domain === "tcp-tools" ? "tcp-tool" : "resource-set";
	const domainSupported =
		selectedClient?.capabilities?.resources?.version === 2 &&
		selectedClient.capabilities.resources[config.capability] === true;
	const upsertSupported =
		domainSupported && (selectedClient?.capabilities?.commands ?? []).includes(`${commandPrefix}.upsert`);
	const deleteSupported =
		domainSupported && (selectedClient?.capabilities?.commands ?? []).includes(`${commandPrefix}.delete`);
	const resourcePath = selectedClient ? `/api/sync/clients/${encodeURIComponent(selectedClient.id)}/${domain}?_=${refreshKey}` : null;
	const { data, error } = useApi<RemoteResourcesResponse>(resourcePath, 4000);

	useEffect(() => {
		if (!clientId && clients?.[0]) setClientId(clients[0].id);
		if (clientId && clients && !clients.some((client) => client.id === clientId)) setClientId(clients[0]?.id ?? "");
	}, [clientId, clients]);

	function parseBundle(raw: string): RemoteResourceBundle | null {
		try {
			const parsed = JSON.parse(raw) as RemoteResourceBundle | RemoteResourceBundle["resources"];
			if (Array.isArray(parsed)) return { resources: parsed };
			if (parsed && Array.isArray(parsed.resources)) return parsed;
		} catch {
			return null;
		}
		return null;
	}

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!selectedClient || !draft) return;
		let parsed: Record<string, unknown>;
		try {
			parsed = draft.data.trim() ? (JSON.parse(draft.data) as Record<string, unknown>) : {};
		} catch {
			setNotice("Resource data must be valid JSON.");
			return;
		}
		const existing = data?.resources.some((resource) => resource.id === draft.id);
		const method = existing ? "PATCH" : "POST";
		if (existing ? !config.actions.edit : !config.actions.create) {
			setNotice("Your role does not include this resource action.");
			return;
		}
		const result = await mutateRemoteResource(selectedClient.id, domain, method, {
			id: draft.id,
			name: draft.name,
			data: parsed,
		});
		if (!result.ok) {
			setNotice(`Not queued: ${result.error}`);
			return;
		}
		setNotice(result.idempotent ? "The existing operation is already queued." : `Queued ${result.command.type}.`);
		setDraft(null);
		setRefreshKey((key) => key + 1);
		onRefresh();
	}

	async function remove(resource: RemoteResource) {
		if (!selectedClient || !window.confirm(`Delete “${resource.name}” on ${selectedClient.name ?? selectedClient.id}?`)) return;
		const result = await mutateRemoteResource(selectedClient.id, domain, "DELETE", resource);
		setNotice(result.ok ? `Queued ${result.command.type}.` : `Not queued: ${result.error}`);
		if (result.ok) {
			setRefreshKey((key) => key + 1);
			onRefresh();
		}
	}

	async function onExport() {
		if (!selectedClient) return;
		const result = await exportRemoteResources(selectedClient.id, domain);
		if (!result.ok) {
			setNotice(`Export failed: ${result.error}`);
			return;
		}
		downloadJson(result.filename, result.bundle);
		setNotice(`Downloaded ${result.filename}.`);
	}

	async function onImportBundle(raw: string) {
		if (!selectedClient) return;
		const bundle = parseBundle(raw);
		if (!bundle) {
			setNotice("Import data must be a JSON object with a resources array.");
			return;
		}
		const result = await importRemoteResources(selectedClient.id, domain, bundle);
		if (!result.ok) {
			setNotice(`Import failed: ${result.error}`);
			return;
		}
		setNotice(`Queued ${result.commands.length} import command${result.commands.length === 1 ? "" : "s"}.`);
		setImportOpen(false);
		setImportText("");
		setRefreshKey((key) => key + 1);
		onRefresh();
	}

	const singular = config.label.endsWith("s") ? config.label.slice(0, -1) : config.label;
	const createEnabled = Boolean(selectedClient && config.actions.create && upsertSupported);
	const editEnabled = Boolean(selectedClient && config.actions.edit && upsertSupported);
	const deleteEnabled = Boolean(selectedClient && config.actions.delete && deleteSupported);
	const importEnabled = Boolean(selectedClient && config.actions.import && upsertSupported);
	const exportEnabled = Boolean(selectedClient && config.actions.export && domainSupported);
	const reason = !selectedClient
		? "Select a Target client to inspect its resources."
		: !domainSupported
			? "This client has not declared sync/v2 support for this resource domain."
			: null;

	return (
		<div className="remote-resources">
			<div className="sync-create-row">
				<label>
					<span className="sr-only">Target client</span>
					<select className="input" value={clientId} onChange={(event) => setClientId(event.target.value)}>
						<option value="">Select a client…</option>
						{clients?.map((client) => <option key={client.id} value={client.id}>{client.name ?? client.id}</option>)}
					</select>
				</label>
				{selectedClient ? <span className={`badge ${domainSupported ? "badge--success" : "badge--warn"}`}>{domainSupported ? "sync/v2 supported" : "domain unsupported"}</span> : null}
			</div>
			<div className="dash-tabs remote-resources-tabs" aria-label="Remote resource types">
				{domains.map((item) => <button key={item.id} type="button" className={`dash-tab${domain === item.id ? " dash-tab--active" : ""}`} onClick={() => setDomain(item.id)}>{item.label}</button>)}
			</div>
			<p className="panel-note">Resources shown here belong only to the selected client. Changes are queued for that client to apply.</p>
			{selectedClient ? (
				<p className="panel-note">
					Selected: <strong>{selectedClient.name ?? selectedClient.id}</strong> · {selectedClient.availability ?? "unknown"} ·
					sync resources v{selectedClient.capabilities?.resources?.version ?? "not reported"}
				</p>
			) : null}
			{reason ? <div className="panel-note remote-resources-reason">{reason}</div> : null}
			{notice ? <div className={notice.startsWith("Not queued") || notice.includes("failed") ? "err" : "panel-note"}>{notice}</div> : null}
			{error ? <div className="err">{`Could not load resources: ${error}`}</div> : null}
			<div className="users-actions remote-resources-actions">
				<button type="button" className="btn btn--on" disabled={!createEnabled} title={createEnabled ? `Create a ${singular.toLowerCase()}` : "Create is not available for this role or client"} onClick={() => setDraft({ id: "", name: "", data: "{}" })}>Create {singular}</button>
				<button type="button" className="btn" disabled={!importEnabled} title={importEnabled ? "Import a JSON bundle" : "Import is not available for this role or client"} onClick={() => setImportOpen(true)}>Import</button>
				<button type="button" className="btn" disabled={!exportEnabled} title={exportEnabled ? "Download this client's mirrored resources" : "Export is not available for this role or client"} onClick={() => void onExport()}>Export</button>
			</div>
			{data ? (
				<table>
					<thead><tr><th>Name</th><th>Resource ID</th><th>Revision</th><th>Last mirrored</th><th /></tr></thead>
					<tbody>
						{data.resources.map((resource) => (
							<tr key={resource.id}>
								<td>{resource.name}</td><td className="mono">{resource.id}</td><td>{resource.revision}</td><td className="mono">{timeAgo(resource.updatedAt)}</td>
								<td className="users-actions">
									<button type="button" className="btn btn--sm" disabled={!editEnabled} onClick={() => setDraft({ id: resource.id, name: resource.name, data: JSON.stringify(resource.data, null, 2) })}>Edit</button>
									<button type="button" className="btn btn--sm btn--ghost" disabled={!deleteEnabled} onClick={() => void remove(resource)}>Delete</button>
								</td>
							</tr>
						))}
						{data.resources.length === 0 ? <tr><td colSpan={5} className="empty">No mirrored {config.label.toLowerCase()} for this client.</td></tr> : null}
					</tbody>
				</table>
			) : selectedClient ? <div className="empty">Loading {config.label.toLowerCase()}…</div> : null}
			{draft ? (
				<form className="sync-step-form" onSubmit={(event) => void save(event)}>
					<h3>{data?.resources.some((resource) => resource.id === draft.id) ? "Edit" : "Create"} {singular}</h3>
					<input className="input" required placeholder="Resource ID" value={draft.id} disabled={data?.resources.some((resource) => resource.id === draft.id)} onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
					<input className="input" required placeholder="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
					<textarea className="sync-context-input" rows={7} value={draft.data} aria-label="Resource JSON data" onChange={(event) => setDraft({ ...draft, data: event.target.value })} />
					<div className="sync-step-form__actions">
						<button type="button" className="btn" onClick={() => setDraft(null)}>Cancel</button>
						<button className="btn btn--on" disabled={data?.resources.some((resource) => resource.id === draft.id) ? !editEnabled : !createEnabled}>Queue change</button>
					</div>
				</form>
			) : null}
			{importOpen ? (
				<form
					className="sync-step-form"
					onSubmit={(event) => {
						event.preventDefault();
						void onImportBundle(importText);
					}}
				>
					<h3>Import {config.label.toLowerCase()}</h3>
					<p className="hint">Upload a JSON file or paste a bundle with a <code>resources</code> array.</p>
					<input
						ref={fileRef}
						type="file"
						accept="application/json,.json"
						className="sr-only"
						onChange={(event) => {
							const file = event.target.files?.[0];
							if (!file) return;
							void file.text().then((text) => setImportText(text));
							event.target.value = "";
						}}
					/>
					<div className="sync-create-row">
						<button type="button" className="btn" onClick={() => fileRef.current?.click()}>Choose JSON file</button>
					</div>
					<textarea
						className="sync-context-input"
						rows={8}
						value={importText}
						aria-label="Import JSON bundle"
						placeholder='{ "contract_version": "sync/v2", "resources": [{ "id": "", "name": "", "data": {} }] }'
						onChange={(event) => setImportText(event.target.value)}
					/>
					<div className="sync-step-form__actions">
						<button type="button" className="btn" onClick={() => { setImportOpen(false); setImportText(""); }}>Cancel</button>
						<button className="btn btn--on" disabled={!importEnabled || !importText.trim()}>Queue import</button>
					</div>
				</form>
			) : null}
		</div>
	);
}
