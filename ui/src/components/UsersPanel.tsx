import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
	createAuthUser,
	deleteAuthUser,
	fetchAuthProviders,
	listAuthUsers,
	resendInvite,
} from "../api/auth.ts";
import type { AuthUser, FieldError, InviteLinks } from "../api/types.ts";
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

export function UsersPanel({ currentUser }: { currentUser: AuthUser }) {
	const [users, setUsers] = useState<AuthUser[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [email, setEmail] = useState("");
	const [errors, setErrors] = useState<FieldError[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
	const [confirmDelete, setConfirmDelete] = useState<{ id: string; email: string; typed: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [googleAvailable, setGoogleAvailable] = useState(false);
	const [allowPassword, setAllowPassword] = useState(true);
	const [allowGoogle, setAllowGoogle] = useState(false);

	const load = useCallback(async () => {
		try {
			const res = await listAuthUsers();
			setUsers(res.users);
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
			const res = await createAuthUser(email, { password: allowPassword, google: allowGoogle });
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
				<button type="submit" className="btn btn--on" disabled={busy || (!allowPassword && !allowGoogle)}>
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
