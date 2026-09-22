import { useState } from "react";
import { hasPermission } from "../api/permissions.ts";
import type { AuthUser, CatalogActions } from "../api/types.ts";
import { ResourceSetsPanel } from "./ResourceSetsPanel.tsx";
import { TcpPacksPanel } from "./TcpPacksPanel.tsx";
import { TemplatesPanel } from "./TemplatesPanel.tsx";

type LibraryTab = "templates" | "tcp" | "rci";

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

export function LibraryPanel({ user }: { user: AuthUser }) {
	const templateActions = catalogActions(user, "templates");
	const tcpActions = catalogActions(user, "tcp-tools");
	const rciActions = catalogActions(user, "rci");
	const [tab, setTab] = useState<LibraryTab>(() => {
		if (templateActions.read) return "templates";
		if (tcpActions.read) return "tcp";
		return "rci";
	});

	return (
		<div className="panel" id="server-library">
			<h2>Agent Resources</h2>
			<p className="panel-note">
				Templates, TCP packs and RCI resource sets stored on this server. This is not a per-client sync mirror.
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
			</div>
			{tab === "templates" ? (
				<TemplatesPanel actions={templateActions} canReadTcps={tcpActions.read} canReadRci={rciActions.read} />
			) : null}
			{tab === "tcp" ? <TcpPacksPanel actions={tcpActions} /> : null}
			{tab === "rci" ? <ResourceSetsPanel actions={rciActions} /> : null}
		</div>
	);
}
