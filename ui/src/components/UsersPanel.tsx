import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createAuthUser, deleteAuthUser, listAuthUsers, resendInvite } from "../api/auth.ts";
import type { AuthUser, FieldError } from "../api/types.ts";
import { timeAgo } from "../lib/format.ts";

function fieldErrors(errors: FieldError[], field: string) {
	return errors.filter((e) => e.field === field);
}

interface PendingLink {
	userId: string;
	url: string;
}

export function UsersPanel({ currentUser }: { currentUser: AuthUser }) {
	const [users, setUsers] = useState<AuthUser[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [email, setEmail] = useState("");
	const [errors, setErrors] = useState<FieldError[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [pendingLinks, setPendingLinks] = useState<PendingLink[]>([]);
	const [confirmDelete, setConfirmDelete] = useState<{ id: string; email: string; typed: string } | null>(null);
	const [busy, setBusy] = useState(false);

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

	async function onInvite(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setErrors([]);
		setNotice(null);
		try {
			const res = await createAuthUser(email);
			if (!res.ok) {
				setErrors(res.errors);
				return;
			}
			setEmail("");
			setPendingLinks((prev) => [...prev.filter((p) => p.userId !== res.user.id), { userId: res.user.id, url: res.invite.url }]);
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
			setPendingLinks((prev) => [...prev.filter((p) => p.userId !== user.id), { userId: user.id, url: res.invite.url }]);
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
			setPendingLinks((prev) => prev.filter((p) => p.userId !== confirmDelete.id));
			await load();
		} finally {
			setBusy(false);
		}
	}

	const linkFor = (id: string) => pendingLinks.find((p) => p.userId === id)?.url;
	const lastUser = (users?.length ?? 0) <= 1;

	return (
		<div className="users-panel">
			<form onSubmit={onInvite} className="users-invite">
				<input
					className="input"
					type="email"
					required
					placeholder="colleague@example.com"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				<button type="submit" className="btn btn--on" disabled={busy}>
					Invite
				</button>
			</form>
			{fieldErrors(errors, "email").map((e) => (
				<div key={e.code} className="field-err">
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
							const link = linkFor(u.id);
							const disableDelete = u.id === currentUser.id || lastUser;
							return (
								<tr key={u.id}>
									<td>{u.email}</td>
									<td>
										{pending ? (
											<span className="badge badge--warn" title="Invitation not completed">
												Pending invitation
											</span>
										) : (
											<span className="badge badge--success">Active</span>
										)}
									</td>
									<td className="mono">{timeAgo(u.createdAt)}</td>
									<td className="mono">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "—"}</td>
									<td className="users-actions">
										{pending && link ? (
											<button type="button" className="btn btn--sm" onClick={() => void navigator.clipboard.writeText(link)}>
												Copy link
											</button>
										) : null}
										{pending ? (
											<button type="button" className="btn btn--sm" disabled={busy} onClick={() => void onResend(u)}>
												{link ? "Resend" : "Resend / copy link"}
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
