import { useEffect, useMemo, useState, type FormEvent } from "react";
import { mutateRemoteResource } from "../api/sync.ts";
import type { RemoteResource, RemoteResourceDomain, RemoteResourcesResponse, SyncClientRow } from "../api/types.ts";
import { useApi } from "../hooks/useApi.ts";
import { timeAgo } from "../lib/format.ts";

type DomainConfig = {
	id: RemoteResourceDomain;
	label: string;
	capability: "templates" | "tcp_tools" | "resource_sets";
	permission: boolean;
};

export function RemoteResourcesPanel({
	clients,
	canManageTemplates,
	canManageTcpTools,
	canManageRci,
	onRefresh,
}: {
	clients: SyncClientRow[] | null;
	canManageTemplates: boolean;
	canManageTcpTools: boolean;
	canManageRci: boolean;
	onRefresh: () => void;
}) {
	const domains: DomainConfig[] = useMemo(
		() => [
			{ id: "templates", label: "Templates", capability: "templates", permission: canManageTemplates },
			{ id: "tcp-tools", label: "TCP tools", capability: "tcp_tools", permission: canManageTcpTools },
			{ id: "resource-sets", label: "RCI resource sets", capability: "resource_sets", permission: canManageRci },
		],
		[canManageTemplates, canManageTcpTools, canManageRci],
	);
	const [clientId, setClientId] = useState("");
	const [domain, setDomain] = useState<RemoteResourceDomain>("templates");
	const [draft, setDraft] = useState<{ id: string; name: string; data: string } | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);
	const selectedClient = clients?.find((client) => client.id === clientId) ?? null;
	const config = domains.find((item) => item.id === domain) ?? domains[0]!;
	const commandPrefix = domain === "templates" ? "template" : domain === "tcp-tools" ? "tcp-tool" : "resource-set";
	const supported =
		selectedClient?.capabilities?.resources?.version === 2 &&
		selectedClient.capabilities.resources[config.capability] === true &&
		(selectedClient.capabilities.commands ?? []).includes(`${commandPrefix}.upsert`) &&
		(selectedClient.capabilities.commands ?? []).includes(`${commandPrefix}.delete`);
	const resourcePath = selectedClient ? `/api/sync/clients/${encodeURIComponent(selectedClient.id)}/${domain}?_=${refreshKey}` : null;
	const { data, error } = useApi<RemoteResourcesResponse>(resourcePath, 4000);

	useEffect(() => {
		if (!clientId && clients?.[0]) setClientId(clients[0].id);
		if (clientId && clients && !clients.some((client) => client.id === clientId)) setClientId(clients[0]?.id ?? "");
	}, [clientId, clients]);

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
		const result = await mutateRemoteResource(selectedClient.id, domain, existing ? "PATCH" : "POST", {
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

	const cannotMutate = !selectedClient || !config.permission || !supported;
	const reason = !selectedClient
		? "Select a Target client to inspect its resources."
		: !config.permission
			? "Your role does not include this resource-management permission."
			: !supported
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
				{selectedClient ? <span className={`badge ${supported ? "badge--success" : "badge--warn"}`}>{supported ? "sync/v2 supported" : "domain unsupported"}</span> : null}
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
			{notice ? <div className={notice.startsWith("Not queued") ? "err" : "panel-note"}>{notice}</div> : null}
			{error ? <div className="err">{`Could not load resources: ${error}`}</div> : null}
			{data ? (
				<table>
					<thead><tr><th>Name</th><th>Resource ID</th><th>Revision</th><th>Last mirrored</th><th /></tr></thead>
					<tbody>
						{data.resources.map((resource) => (
							<tr key={resource.id}>
								<td>{resource.name}</td><td className="mono">{resource.id}</td><td>{resource.revision}</td><td className="mono">{timeAgo(resource.updatedAt)}</td>
								<td className="users-actions">
									<button type="button" className="btn btn--sm" disabled={cannotMutate} onClick={() => setDraft({ id: resource.id, name: resource.name, data: JSON.stringify(resource.data, null, 2) })}>Edit</button>
									<button type="button" className="btn btn--sm btn--ghost" disabled={cannotMutate} onClick={() => void remove(resource)}>Delete</button>
								</td>
							</tr>
						))}
						{data.resources.length === 0 ? <tr><td colSpan={5} className="empty">No mirrored {config.label.toLowerCase()} for this client.</td></tr> : null}
					</tbody>
				</table>
			) : selectedClient ? <div className="empty">Loading {config.label.toLowerCase()}…</div> : null}
			<button type="button" className="btn btn--on" disabled={cannotMutate} title={reason ?? "Create a resource"} onClick={() => setDraft({ id: "", name: "", data: "{}" })}>Create {config.label.slice(0, -1)}</button>
			{draft ? (
				<form className="sync-step-form" onSubmit={(event) => void save(event)}>
					<h3>{data?.resources.some((resource) => resource.id === draft.id) ? "Edit" : "Create"} {config.label.slice(0, -1)}</h3>
					<input className="input" required placeholder="Resource ID" value={draft.id} disabled={data?.resources.some((resource) => resource.id === draft.id)} onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
					<input className="input" required placeholder="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
					<textarea className="sync-context-input" rows={7} value={draft.data} aria-label="Resource JSON data" onChange={(event) => setDraft({ ...draft, data: event.target.value })} />
					<div className="sync-step-form__actions"><button type="button" className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn btn--on" disabled={cannotMutate}>Queue change</button></div>
				</form>
			) : null}
		</div>
	);
}
