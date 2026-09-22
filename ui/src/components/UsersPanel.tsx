import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
	createAuthRole,
	createAuthUser,
	deleteAuthRole,
	deleteAuthUser,
	fetchAuthProviders,
	listAuthRoles,
	listAuthUsers,
	reassignAuthUserRole,
	resendInvite,
	updateAuthRole,
} from "../api/auth.ts";
import { resolvePermissionCatalog } from "../api/permissions.ts";
import type { AuthRole, AuthUser, FieldError, InviteLinks, PermissionCatalog, PermissionCatalogGroup } from "../api/types.ts";
import { timeAgo } from "../lib/format.ts";

function fieldErrors(errors: FieldError[], field: string) {
	return errors.filter((e) => e.field === field || e.field.startsWith(`${field}.`));
}

function activationLabel(u: AuthUser): string | null {
	if (u.status !== "pending") return null;
	const pw = u.inviteAllowPassword !== false;
	const g = u.inviteAllowGoogle === true;
	if (pw && g) return "Password · Google";
	if (g) return "Google only";
	if (pw) return "Password only";
	return null;
}

interface PendingInvite {
	userId: string;
	setupUrl?: string;
	loginUrl?: string;
}

function mergePendingInvite(userId: string, invite: InviteLinks): PendingInvite {
	const setupUrl = invite.setupUrl ?? invite.url;
	return {
		userId,
		...(setupUrl ? { setupUrl } : {}),
		...(invite.loginUrl ? { loginUrl: invite.loginUrl } : {}),
	};
}

export function UsersPanel({ currentUser, catalog = null }: { currentUser: AuthUser; catalog?: PermissionCatalog | null }) {
	const [users, setUsers] = useState<AuthUser[] | null>(null);
	const [roles, setRoles] = useState<AuthRole[] | null>(null);
	const [roleCatalog, setRoleCatalog] = useState<PermissionCatalog | null>(catalog);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [email, setEmail] = useState("");
	const [roleId, setRoleId] = useState("");
	const [errors, setErrors] = useState<FieldError[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
	const [confirmDelete, setConfirmDelete] = useState<{ id: string; email: string; typed: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [googleAvailable, setGoogleAvailable] = useState(false);
	const [allowPassword, setAllowPassword] = useState(true);
	const [allowGoogle, setAllowGoogle] = useState(false);
	const [roleDraft, setRoleDraft] = useState<{ id?: string; name: string; permissions: string[] } | null>(null);

	const load = useCallback(async () => {
		try {
			const [userRes, roleRes] = await Promise.all([listAuthUsers(), listAuthRoles()]);
			setUsers(userRes.users);
			setRoles(roleRes.roles);
			if (roleRes.catalog) setRoleCatalog(roleRes.catalog);
			setRoleId((current) => current || roleRes.roles[0]?.id || "");
			setLoadError(null);
		} catch (e) {
			setLoadError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		void (async () => {
			try {
				const providers = await fetchAuthProviders();
				setGoogleAvailable(providers.google);
				if (providers.google) {
					setAllowPassword(true);
					setAllowGoogle(true);
				} else {
					setAllowGoogle(false);
					setAllowPassword(true);
				}
			} catch {
				setGoogleAvailable(false);
				setAllowGoogle(false);
			}
		})();
	}, []);

	function storePendingInvite(userId: string, invite: InviteLinks) {
		const entry = mergePendingInvite(userId, invite);
		setPendingInvites((prev) => [...prev.filter((p) => p.userId !== userId), entry]);
	}

	async function onInvite(e: FormEvent) {
		e.preventDefault();
		if (!allowPassword && !allowGoogle) {
			setErrors([{ field: "activation", code: "required", message: "Choose at least one activation method." }]);
			return;
		}
		setBusy(true);
		setErrors([]);
		setNotice(null);
		try {
			if (!roleId) return;
			const res = await createAuthUser(email, roleId, { password: allowPassword, google: allowGoogle });
			if (!res.ok) {
				setErrors(res.errors);
				return;
			}
			setEmail("");
			storePendingInvite(res.user.id, res.invite);
			setNotice(
				res.mail.sent
					? `Invited ${res.user.email} — invitation email sent (${res.mail.transport}).`
					: `Invited ${res.user.email} — email failed (${res.mail.error ?? "unknown"}). Copy the link below.`,
			);
			await load();
		} finally {
			setBusy(false);
		}
	}

	async function saveRole() {
		if (!roleDraft) return;
		setBusy(true);
		try {
			const res = roleDraft.id
				? await updateAuthRole(roleDraft.id, roleDraft.name, roleDraft.permissions)
				: await createAuthRole(roleDraft.name, roleDraft.permissions);
			if (!res.ok) {
				setNotice("Role needs a name and valid permissions.");
				return;
			}
			setRoleDraft(null);
			await load();
		} finally {
			setBusy(false);
		}
	}

	async function removeRole(role: AuthRole) {
		if (!window.confirm(`Delete role “${role.name}”?`)) return;
		setBusy(true);
		try {
			const res = await deleteAuthRole(role.id);
			setNotice(res.ok ? `Deleted ${role.name}.` : "A system role or assigned role cannot be deleted.");
			if (res.ok) await load();
		} finally {
			setBusy(false);
		}
	}

	async function changeUserRole(user: AuthUser, nextRoleId: string) {
		setBusy(true);
		try {
			const res = await reassignAuthUserRole(user.id, nextRoleId);
			setNotice(res.ok ? `Updated ${user.email}.` : "Role change was not allowed.");
			if (res.ok) await load();
		} finally {
			setBusy(false);
		}
	}

	async function onResend(user: AuthUser) {
		setBusy(true);
		setNotice(null);
		try {
			const res = await resendInvite(user.id);
			if (!res.ok) {
				setNotice("Account is already active.");
				return;
			}
			storePendingInvite(user.id, res.invite);
			setNotice(
				res.mail.sent ? `Invitation resent to ${user.email}.` : `Resend failed — copy the link below for ${user.email}.`,
			);
		} finally {
			setBusy(false);
		}
	}

	async function onDelete() {
		if (!confirmDelete) return;
		setBusy(true);
		try {
			const res = await deleteAuthUser(confirmDelete.id);
			if (!res.ok) {
				setNotice(res.error === "last_user" ? "Cannot delete the last user." : "Cannot delete your own account.");
				return;
			}
			setConfirmDelete(null);
			setPendingInvites((prev) => prev.filter((p) => p.userId !== confirmDelete.id));
			await load();
		} finally {
			setBusy(false);
		}
	}

	const inviteFor = (id: string) => pendingInvites.find((p) => p.userId === id);
	const loginPageUrl = `${window.location.origin}/login`;
	const lastUser = (users?.length ?? 0) <= 1;

	return (
		<div className="users-panel">
			<p className="panel-note">
				Choose how each invitee may activate: a one-time <strong>password setup link</strong>,{" "}
				<strong>Sign in with Google</strong> (same email, invite-only), or both. Google requires{" "}
				<code>TARGET_GOOGLE_CLIENT_ID</code> and <code>TARGET_GOOGLE_CLIENT_SECRET</code> on the server — see the README
				Google OAuth section.
			</p>
			<form onSubmit={onInvite} className="users-invite">
				<input
					className="input"
					type="email"
					required
					placeholder="colleague@example.com"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				<select className="input" aria-label="Role for invitee" value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={busy}>
					{roles?.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
				</select>
				<div className="users-invite-methods">
					<label className="users-check">
						<input
							type="checkbox"
							checked={allowPassword}
							onChange={(e) => setAllowPassword(e.target.checked)}
							disabled={busy || (!allowGoogle && allowPassword)}
						/>
						Password setup link
					</label>
					<label className={`users-check${googleAvailable ? "" : " users-check--disabled"}`}>
						<input
							type="checkbox"
							checked={allowGoogle}
							onChange={(e) => setAllowGoogle(e.target.checked)}
							disabled={busy || !googleAvailable || (!allowPassword && allowGoogle)}
						/>
						Sign in with Google
					</label>
				</div>
				<button type="submit" className="btn btn--on" disabled={busy || !roleId || (!allowPassword && !allowGoogle)}>
					Invite
				</button>
			</form>
			{!googleAvailable ? (
				<p className="panel-note users-invite-hint">Google sign-in is not configured on this server — password setup only.</p>
			) : null}
			{fieldErrors(errors, "email").map((e) => (
				<div key={`${e.field}-${e.code}`} className="field-err">
					{e.message}
				</div>
			))}
			{fieldErrors(errors, "activation").map((e) => (
				<div key={`${e.field}-${e.code}`} className="field-err">
					{e.message}
				</div>
			))}
			{notice ? <div className={notice.includes("failed") ? "err" : "panel-note"}>{notice}</div> : null}

			{loadError ? <div className="err">{`Could not load accounts: ${loadError}`}</div> : null}

			{!users && !loadError ? (
				<div className="empty">Loading users…</div>
			) : users && users.length === 0 ? (
				<div className="empty">No accounts yet.</div>
			) : users ? (
				<table>
					<thead>
						<tr>
							<th>Email</th>
							<th>Status</th>
							<th>Role</th>
							<th>Created</th>
							<th>Last login</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{users.map((u) => {
							const pending = u.status === "pending";
							const cached = inviteFor(u.id);
							const setupUrl = cached?.setupUrl;
							const showGoogleHint = pending && (cached?.loginUrl || u.inviteAllowGoogle);
							const loginUrl = cached?.loginUrl ?? (u.inviteAllowGoogle ? loginPageUrl : undefined);
							const methods = activationLabel(u);
							const disableDelete = u.id === currentUser.id || lastUser;
							return (
								<tr key={u.id}>
									<td>{u.email}</td>
									<td>
										{pending ? (
											<span className="badge badge--warn" title="Invitation not completed">
												Pending invitation
												{methods ? ` · ${methods}` : ""}
											</span>
										) : (
											<span className="badge badge--success">Active</span>
										)}
									</td>
									<td>
										<select
											className="input"
											aria-label={`Role for ${u.email}`}
											value={u.role}
											disabled={busy || u.id === currentUser.id}
											onChange={(e) => void changeUserRole(u, e.target.value)}
										>
											{roles?.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
										</select>
									</td>
									<td className="mono">{timeAgo(u.createdAt)}</td>
									<td className="mono">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "—"}</td>
									<td className="users-actions">
										{pending && setupUrl ? (
											<button
												type="button"
												className="btn btn--sm"
												onClick={() => void navigator.clipboard.writeText(setupUrl)}
											>
												Copy setup link
											</button>
										) : null}
										{pending && showGoogleHint && loginUrl ? (
											<button
												type="button"
												className="btn btn--sm"
												title="Login page for Sign in with Google"
												onClick={() => void navigator.clipboard.writeText(loginUrl)}
											>
												Copy login URL
											</button>
										) : null}
										{pending ? (
											<button type="button" className="btn btn--sm" disabled={busy} onClick={() => void onResend(u)}>
												{setupUrl || showGoogleHint ? "Resend" : "Resend / copy link"}
											</button>
										) : null}
										<button
											type="button"
											className="btn btn--sm btn--ghost"
											disabled={disableDelete}
											title={
												u.id === currentUser.id
													? "You cannot delete your own account"
													: lastUser
														? "Cannot delete the last user"
														: "Delete account"
											}
											onClick={() => setConfirmDelete({ id: u.id, email: u.email, typed: "" })}
										>
											Delete
										</button>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			) : null}

			<div className="panel users-roles">
				<div className="panel-heading">
					<div>
						<h2>Roles and permissions</h2>
						<p className="panel-note">System Administrator has every permission and cannot be edited or deleted.</p>
					</div>
					<button type="button" className="btn btn--on" disabled={busy} onClick={() => setRoleDraft({ name: "", permissions: [] })}>Create role</button>
				</div>
				{roles?.map((role) => (
					<div className="users-role-row" key={role.id}>
						<div><strong>{role.name}</strong>{role.isSystem ? " · System" : ""}<span className="panel-note"> · {role.userCount} users</span></div>
						<div className="users-actions">
							<button type="button" className="btn btn--sm" disabled={role.isSystem || busy} onClick={() => setRoleDraft({ id: role.id, name: role.name, permissions: role.permissions })}>Edit</button>
							<button type="button" className="btn btn--sm btn--ghost" disabled={role.isSystem || role.userCount > 0 || busy} onClick={() => void removeRole(role)}>Delete</button>
						</div>
					</div>
				))}
			</div>

			{roleDraft ? (
				<div className="users-confirm" role="dialog" aria-modal="true" aria-label="Role editor">
					<h2>{roleDraft.id ? "Edit role" : "Create role"}</h2>
					<input className="input" value={roleDraft.name} placeholder="Role name" onChange={(e) => setRoleDraft({ ...roleDraft, name: e.target.value })} />
					<RoleCatalogEditor
						groups={resolvePermissionCatalog(roleCatalog ?? catalog)}
						selected={roleDraft.permissions}
						onChange={(permissions) => setRoleDraft({ ...roleDraft, permissions })}
					/>
					<div className="users-confirm-actions">
						<button type="button" className="btn" onClick={() => setRoleDraft(null)}>Cancel</button>
						<button type="button" className="btn btn--on" disabled={busy || !roleDraft.name.trim()} onClick={() => void saveRole()}>Save role</button>
					</div>
				</div>
			) : null}

			{confirmDelete ? (
				<div className="users-confirm">
					<p>
						Type <strong>{confirmDelete.email}</strong> to delete this account.
					</p>
					<input
						className="input"
						value={confirmDelete.typed}
						onChange={(e) => setConfirmDelete({ ...confirmDelete, typed: e.target.value })}
					/>
					<div className="users-confirm-actions">
						<button type="button" className="btn" onClick={() => setConfirmDelete(null)}>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn--on"
							disabled={confirmDelete.typed !== confirmDelete.email || busy}
							onClick={() => void onDelete()}
						>
							Delete
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}

const ROLE_SCOPES = [
	{ id: "server" as const, label: "Server" },
	{ id: "client" as const, label: "Client" },
];

function toggleIds(selected: string[], ids: string[], checked: boolean) {
	if (checked) return [...new Set([...selected, ...ids])];
	const drop = new Set(ids);
	return selected.filter((id) => !drop.has(id));
}

function RoleCatalogEditor({
	groups,
	selected,
	onChange,
}: {
	groups: PermissionCatalogGroup[];
	selected: string[];
	onChange: (permissions: string[]) => void;
}) {
	return (
		<div className="users-permissions">
			{ROLE_SCOPES.map((scope) => {
				const scoped = groups.filter((group) => group.scope === scope.id);
				if (!scoped.length) return null;
				return (
					<section key={scope.id} className="users-perm-scope">
						<h3 className="users-perm-scope__title">{scope.label}</h3>
						{scoped.map((group) => {
							const ids = group.permissions.map((permission) => permission.id);
							const chosen = ids.filter((id) => selected.includes(id)).length;
							const all = ids.length > 0 && chosen === ids.length;
							const some = chosen > 0 && !all;
							return (
								<div className="users-perm-group" key={group.id}>
									<label className="users-check users-perm-group__all">
										<input
											type="checkbox"
											checked={all}
											ref={(el) => {
												if (el) el.indeterminate = some;
											}}
											onChange={(e) => onChange(toggleIds(selected, ids, e.target.checked))}
										/>
										<span>
											<strong>Select all · {group.label}</strong>
											<small>{group.description}</small>
										</span>
									</label>
									<div className="users-perm-group__list">
										{group.permissions.map((permission) => (
											<label className="users-check" key={permission.id}>
												<input
													type="checkbox"
													checked={selected.includes(permission.id)}
													onChange={(e) => onChange(toggleIds(selected, [permission.id], e.target.checked))}
												/>
												<span>
													<strong>{permission.label}</strong>
													<small>{permission.description}</small>
												</span>
											</label>
										))}
									</div>
								</div>
							);
						})}
					</section>
				);
			})}
		</div>
	);
}
