import type { AuthUser, PermissionCatalog, PermissionCatalogEntry, PermissionCatalogGroup } from "./types.ts";

/** Thin fallback of the server's closed RBAC catalogue for readable role editing. */
export const PERMISSION_CATALOG = [
	{ id: "activity.read", label: "View Activity", description: "View fleet activity, events and workflows." },
	{ id: "users.read", label: "View users", description: "View dashboard accounts and invitations." },
	{ id: "users.manage", label: "Manage users and roles", description: "Invite, change accounts and manage roles." },
	{ id: "devices.link", label: "Approve or deny device-link requests", description: "Approve or deny linking an authorized Target hub to your account." },
	{ id: "devices.manage", label: "Manage linked devices", description: "List, revoke and manage linked device identities." },
	{ id: "templates.read", label: "View templates", description: "View workflow templates stored on this server." },
	{ id: "templates.create", label: "Create templates", description: "Create workflow templates stored on this server." },
	{ id: "templates.edit", label: "Edit templates", description: "Edit workflow templates stored on this server." },
	{ id: "templates.delete", label: "Delete templates", description: "Delete workflow templates stored on this server." },
	{ id: "templates.import", label: "Import templates", description: "Import workflow templates stored on this server." },
	{ id: "templates.export", label: "Export templates", description: "Export workflow templates stored on this server." },
	{ id: "tcp-tools.read", label: "View TCP tools", description: "View TCP packs stored on this server." },
	{ id: "tcp-tools.create", label: "Create TCP tools", description: "Create TCP packs stored on this server." },
	{ id: "tcp-tools.edit", label: "Edit TCP tools", description: "Edit TCP packs stored on this server." },
	{ id: "tcp-tools.delete", label: "Delete TCP tools", description: "Delete TCP packs stored on this server." },
	{ id: "tcp-tools.import", label: "Import TCP tools", description: "Import TCP packs stored on this server." },
	{ id: "tcp-tools.export", label: "Export TCP tools", description: "Export TCP packs stored on this server." },
	{ id: "rci.read", label: "View RCI resources", description: "View RCI resource sets stored on this server." },
	{ id: "rci.create", label: "Create RCI resources", description: "Create RCI resource sets stored on this server." },
	{ id: "rci.edit", label: "Edit RCI resources", description: "Edit RCI resource sets stored on this server." },
	{ id: "rci.delete", label: "Delete RCI resources", description: "Delete RCI resource sets stored on this server." },
	{ id: "rci.import", label: "Import RCI resources", description: "Import RCI resource sets stored on this server." },
	{ id: "rci.export", label: "Export RCI resources", description: "Export RCI resource sets stored on this server." },
	{ id: "client.read", label: "View clients", description: "View connected clients and their state." },
	{ id: "client.workflows.create", label: "Create workflows", description: "Create client workflows." },
	{ id: "client.workflows.steps.add", label: "Add workflow steps", description: "Add steps to client workflows." },
	{ id: "client.workflows.steps.edit", label: "Edit workflow steps", description: "Edit steps on client workflows." },
	{ id: "client.workflows.manage", label: "Manage client workflows", description: "Delete client workflows, set conversation context and choose run selection." },
	{ id: "client.workflows.execute", label: "Execute client workflows", description: "Start, pause, resume and restart client workflows." },
	{ id: "client.templates.create", label: "Create templates", description: "Create client workflow templates." },
	{ id: "client.templates.edit", label: "Edit templates", description: "Edit client workflow templates." },
	{ id: "client.templates.delete", label: "Delete templates", description: "Delete client workflow templates." },
	{ id: "client.templates.import", label: "Import templates", description: "Import client workflow templates." },
	{ id: "client.templates.export", label: "Export templates", description: "Export client workflow templates." },
	{ id: "client.tcp-tools.create", label: "Create TCP tools", description: "Create client TCP tools." },
	{ id: "client.tcp-tools.edit", label: "Edit TCP tools", description: "Edit client TCP tools." },
	{ id: "client.tcp-tools.delete", label: "Delete TCP tools", description: "Delete client TCP tools." },
	{ id: "client.tcp-tools.import", label: "Import TCP tools", description: "Import client TCP tools." },
	{ id: "client.tcp-tools.export", label: "Export TCP tools", description: "Export client TCP tools." },
	{ id: "client.rci.create", label: "Create RCI resources", description: "Create client RCI resources." },
	{ id: "client.rci.edit", label: "Edit RCI resources", description: "Edit client RCI resources." },
	{ id: "client.rci.delete", label: "Delete RCI resources", description: "Delete client RCI resources." },
	{ id: "client.rci.import", label: "Import RCI resources", description: "Import client RCI resources." },
	{ id: "client.rci.export", label: "Export RCI resources", description: "Export client RCI resources." },
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
