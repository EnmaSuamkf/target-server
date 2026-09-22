import type { AuthUser, PermissionCatalog, PermissionCatalogEntry, PermissionCatalogGroup } from "./types.ts";

/** Thin fallback of the server's closed RBAC catalogue for readable role editing. */
export const PERMISSION_CATALOG = [
	{ id: "activity.read", label: "View Activity", description: "View fleet activity, events and workflows." },
	{ id: "users.read", label: "View users", description: "View dashboard accounts and invitations." },
	{ id: "users.manage", label: "Manage users and roles", description: "Invite, change accounts and manage roles." },
	{ id: "devices.link", label: "Approve or deny device-link requests", description: "Approve or deny linking an authorized Target hub to your account." },
	{ id: "devices.manage", label: "Manage linked devices", description: "List, revoke and manage linked device identities." },
	{ id: "remote.read", label: "View Remote Control", description: "View connected clients and remote state." },
	{ id: "remote.workflows.create", label: "Create workflows", description: "Create remote workflows." },
	{ id: "remote.workflows.steps.add", label: "Add workflow steps", description: "Add steps to remote workflows." },
	{ id: "remote.workflows.steps.edit", label: "Edit workflow steps", description: "Edit steps on remote workflows." },
	{ id: "remote.workflows.manage", label: "Manage remote workflows", description: "Delete remote workflows, set conversation context and choose run selection." },
	{ id: "remote.workflows.execute", label: "Execute remote workflows", description: "Run, pause, resume and restart workflows." },
	{ id: "remote.templates.create", label: "Create templates", description: "Create remote templates." },
	{ id: "remote.templates.edit", label: "Edit templates", description: "Edit remote templates." },
	{ id: "remote.templates.delete", label: "Delete templates", description: "Delete remote templates." },
	{ id: "remote.templates.import", label: "Import templates", description: "Import remote templates." },
	{ id: "remote.templates.export", label: "Export templates", description: "Export remote templates." },
	{ id: "remote.tcp-tools.create", label: "Create TCP tools", description: "Create remote TCP tools." },
	{ id: "remote.tcp-tools.edit", label: "Edit TCP tools", description: "Edit remote TCP tools." },
	{ id: "remote.tcp-tools.delete", label: "Delete TCP tools", description: "Delete remote TCP tools." },
	{ id: "remote.tcp-tools.import", label: "Import TCP tools", description: "Import remote TCP tools." },
	{ id: "remote.tcp-tools.export", label: "Export TCP tools", description: "Export remote TCP tools." },
	{ id: "remote.rci.create", label: "Create RCI resources", description: "Create remote RCI resources." },
	{ id: "remote.rci.edit", label: "Edit RCI resources", description: "Edit remote RCI resources." },
	{ id: "remote.rci.delete", label: "Delete RCI resources", description: "Delete remote RCI resources." },
	{ id: "remote.rci.import", label: "Import RCI resources", description: "Import remote RCI resources." },
	{ id: "remote.rci.export", label: "Export RCI resources", description: "Export remote RCI resources." },
] as const;

/** Prefer the session/roles catalogue; fall back to the static list only if it is missing. */
export function resolvePermissionCatalog(catalog?: PermissionCatalog | null): PermissionCatalogGroup[] {
	return catalog?.groups?.length ? catalog.groups : fallbackGroups();
}

export function catalogPermissionEntries(catalog?: PermissionCatalog | null): readonly PermissionCatalogEntry[] {
	const groups = resolvePermissionCatalog(catalog);
	return groups.flatMap((group) => group.permissions);
}

/** Authorization checks use granted IDs from the current user, never the catalog blob. */
export function hasPermission(user: Pick<AuthUser, "permissions"> | null | undefined, permission: string): boolean {
	return Boolean(user?.permissions?.includes(permission));
}

const FALLBACK_GROUP_ID = "fallback";

function fallbackGroups(): PermissionCatalogGroup[] {
	return [
		{
			id: FALLBACK_GROUP_ID,
			scope: "server",
			label: "Permissions",
			description: "Closed catalogue fallback when the session has not sent groups yet.",
			permissions: PERMISSION_CATALOG.map((entry) => ({
				id: entry.id,
				label: entry.label,
				description: entry.description,
			})),
		},
	];
}
