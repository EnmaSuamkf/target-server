import { useState } from "react";
import { hasPermission } from "../api/permissions.ts";
import type { AuthUser, CatalogActions } from "../api/types.ts";
import { PipelinesPanel } from "./PipelinesPanel.tsx";
import { ResourceSetsPanel } from "./ResourceSetsPanel.tsx";
import { TcpPacksPanel } from "./TcpPacksPanel.tsx";
import { TemplatesPanel } from "./TemplatesPanel.tsx";

type LibraryTab = "templates" | "tcp" | "rci" | "pipelines";

function catalogActions(user: AuthUser, prefix: "templates" | "tcp-tools" | "rci"): CatalogActions {
	const can = (permission: string) => hasPermission(user, permission);
	return {
		read: can(`${prefix}.read`),
		create: can(`${prefix}.create`),
		edit: can(`${prefix}.edit`),
		delete: can(`${prefix}.delete`),
		import: can(`${prefix}.import`),
		export: can(`${prefix}.export`),
	};
}

/**
 * Pipelines have no `.read` permission of their own: a user can see the list when
 * they hold any of the six `client.pipelines.*` permissions, and each write action
 * is gated by its own.
 */
function pipelineActions(user: AuthUser): CatalogActions {
	const can = (permission: string) => hasPermission(user, permission);
	return {
		read: ["create", "edit", "delete", "import", "export", "sync"].some((action) => can(`client.pipelines.${action}`)),
		create: can("client.pipelines.create"),
		edit: can("client.pipelines.edit"),
		delete: can("client.pipelines.delete"),
		import: can("client.pipelines.import"),
		export: can("client.pipelines.export"),
	};
}

export function LibraryPanel({ user }: { user: AuthUser }) {
	const templateActions = catalogActions(user, "templates");
	const tcpActions = catalogActions(user, "tcp-tools");
	const rciActions = catalogActions(user, "rci");
	const pipelinesAccess = pipelineActions(user);
	const [tab, setTab] = useState<LibraryTab>(() => {
		if (templateActions.read) return "templates";
		if (tcpActions.read) return "tcp";
		if (pipelinesAccess.read) return "pipelines";
		return "rci";
	});

	return (
		<div className="panel" id="server-library">
			<h2>Agent Resources</h2>
			<p className="panel-note">
				Templates, TCP packs, RCI resource sets and pipelines stored on this server. This is not a per-client sync mirror.
			</p>
			<div className="dash-tabs catalog-tabs" aria-label="Agent Resources catalogs">
				<button type="button" className={`dash-tab${tab === "templates" ? " dash-tab--active" : ""}`} onClick={() => setTab("templates")}>
					Templates
				</button>
				<button type="button" className={`dash-tab${tab === "tcp" ? " dash-tab--active" : ""}`} onClick={() => setTab("tcp")}>
					TCP tools
				</button>
				<button type="button" className={`dash-tab${tab === "rci" ? " dash-tab--active" : ""}`} onClick={() => setTab("rci")}>
					RCI
				</button>
				<button type="button" className={`dash-tab${tab === "pipelines" ? " dash-tab--active" : ""}`} onClick={() => setTab("pipelines")}>
					Pipelines
				</button>
			</div>
			{tab === "templates" ? (
				<TemplatesPanel
					actions={templateActions}
					canReadTcps={tcpActions.read}
					canReadRci={rciActions.read}
					canReadPipelines={pipelinesAccess.read}
				/>
			) : null}
			{tab === "tcp" ? <TcpPacksPanel actions={tcpActions} /> : null}
			{tab === "rci" ? <ResourceSetsPanel actions={rciActions} /> : null}
			{tab === "pipelines" ? <PipelinesPanel actions={pipelinesAccess} /> : null}
		</div>
	);
}
