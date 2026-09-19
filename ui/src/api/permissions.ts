/** Mirrors the server's closed RBAC catalogue for readable role editing. */
export const PERMISSION_CATALOG = [
	{ id: "activity.read", label: "View Activity", description: "View fleet activity, events and workflows." },
	{ id: "users.read", label: "View users", description: "View dashboard accounts and invitations." },
	{ id: "users.manage", label: "Manage users and roles", description: "Invite, change accounts and manage roles." },
	{ id: "remote.read", label: "View Remote Control", description: "View connected clients and remote state." },
	{ id: "remote.workflows.manage", label: "Manage remote workflows", description: "Create and edit remote workflows." },
	{ id: "remote.workflows.execute", label: "Execute remote workflows", description: "Run, pause, resume and restart workflows." },
	{ id: "remote.templates.manage", label: "Manage templates", description: "Manage remote templates." },
	{ id: "remote.tcp-tools.manage", label: "Manage TCP tools", description: "Manage remote TCP tools." },
	{ id: "remote.rci.manage", label: "Manage RCI", description: "Manage remote RCI resources." },
	{ id: "devices.link", label: "Approve or deny device-link requests", description: "Approve or deny linking an authorized Target hub to your account." },
	{ id: "devices.manage", label: "Manage linked devices", description: "List, revoke and manage linked device identities." },
] as const;
