import { useCallback, useEffect, useState, type FormEvent } from "react";
import { fetchAuthProviders } from "../api/auth.ts";
import {
	createPlatformOrg,
	deletePlatformOrg,
	listPlatformOrgs,
	resendPlatformAdminInvite,
	setPlatformOrgStatus,
} from "../api/platform.ts";
import type { FieldError, InviteLinks, PlatformOrg } from "../api/types.ts";
import { timeAgo } from "../lib/format.ts";
import { CopyValue } from "./CopyValue.tsx";
import { Field } from "./Field.tsx";
import { Modal } from "./Modal.tsx";

const DEFAULT_ORG_ID = "default";

function fieldError(errors: FieldError[], field: string) {
	return errors.find((e) => e.field === field || e.field.startsWith(`${field}.`))?.message;
}

export function OrganizationsPanel() {
	const [orgs, setOrgs] = useState<PlatformOrg[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [adminEmail, setAdminEmail] = useState("");
	const [allowPassword, setAllowPassword] = useState(true);
	const [allowGoogle, setAllowGoogle] = useState(false);
	const [googleAvailable, setGoogleAvailable] = useState(false);
	const [errors, setErrors] = useState<FieldError[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [noticeError, setNoticeError] = useState(false);
	const [busy, setBusy] = useState(false);
	const [pendingInvites, setPendingInvites] = useState<Record<string, InviteLinks>>({});
	const [confirmDelete, setConfirmDelete] = useState<{ org: PlatformOrg; typed: string } | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	/** Create/resend notices keep the "failed" → error styling; lifecycle actions pass `error` explicitly. */
	function showNotice(text: string | null, error = text?.includes("failed") ?? false) {
		setNotice(text);
		setNoticeError(error);
	}

	const load = useCallback(async () => {
		try {
			const body = await listPlatformOrgs();
			setOrgs(body.orgs);
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

	function closeModal() {
		setOpen(false);
		setErrors([]);
	}

	async function onCreate(e: FormEvent) {
		e.preventDefault();
		if (!allowPassword && !allowGoogle) {
			setErrors([{ field: "activation", code: "required", message: "Choose at least one activation method." }]);
			return;
		}
		setBusy(true);
		setErrors([]);
		showNotice(null);
		try {
			const res = await createPlatformOrg({
				name,
				slug,
				admin_email: adminEmail,
				activation: { password: allowPassword, google: allowGoogle },
			});
			if (!res.ok) {
				setErrors(res.errors);
				return;
			}
			setPendingInvites((prev) => ({ ...prev, [res.org.id]: res.invite }));
			showNotice(
				res.mail.sent
					? `Created ${res.org.name} — invitation sent to ${res.admin.email} (${res.mail.transport}).`
					: `Created ${res.org.name} — email failed (${res.mail.error ?? "unknown"}). Copy the invite from the table.`,
			);
			setName("");
			setSlug("");
			setAdminEmail("");
			closeModal();
			await load();
		} finally {
			setBusy(false);
		}
	}

	async function onResend(org: PlatformOrg) {
		setBusy(true);
		showNotice(null);
		try {
			const res = await resendPlatformAdminInvite(org.id);
			if (!res.ok) {
				showNotice(res.error === "already_activated" ? "That admin has already activated." : "Could not resend invite.");
				return;
			}
			setPendingInvites((prev) => ({ ...prev, [org.id]: res.invite }));
			showNotice(
				res.mail.sent
					? `Invitation resent to ${res.admin.email}.`
					: `Resend failed — copy the link below for ${res.admin.email}.`,
			);
			await load();
		} finally {
			setBusy(false);
		}
	}

	async function onToggleStatus(org: PlatformOrg) {
		const next = org.status === "disabled" ? "active" : "disabled";
		setBusy(true);
		showNotice(null);
		try {
			const res = await setPlatformOrgStatus(org.id, next);
			if (!res.ok) {
				showNotice(
					res.error === "default_org_protected"
						? "The default organization cannot be disabled."
						: res.error === "not_found"
							? `${org.name} no longer exists.`
							: `Could not change the status of ${org.name}.`,
					true,
				);
				await load();
				return;
			}
			showNotice(
				next === "disabled"
					? `Disabled ${res.org.name} — its users and hubs are refused until it is enabled again.`
					: `Enabled ${res.org.name} — access restored.`,
				false,
			);
			await load();
		} catch (e) {
			showNotice(`Could not change the status of ${org.name}: ${e instanceof Error ? e.message : String(e)}`, true);
		} finally {
			setBusy(false);
		}
	}

	function openDelete(org: PlatformOrg) {
		showNotice(null);
		setDeleteError(null);
		setConfirmDelete({ org, typed: "" });
	}

	function closeDelete() {
		setConfirmDelete(null);
		setDeleteError(null);
	}

	async function onDelete() {
		if (!confirmDelete || confirmDelete.typed !== confirmDelete.org.slug) return;
		const { org, typed } = confirmDelete;
		setBusy(true);
		setDeleteError(null);
		try {
			const res = await deletePlatformOrg(org.id, typed);
			if (!res.ok) {
				if (res.error === "invalid") {
					setDeleteError(fieldError(res.errors, "confirm_slug") ?? "The slug does not match.");
					return;
				}
				closeDelete();
				showNotice(
					res.error === "default_org_protected"
						? "The default organization cannot be deleted."
						: `${org.name} no longer exists.`,
					true,
				);
				await load();
				return;
			}
			closeDelete();
			setPendingInvites((prev) => {
				const rest = { ...prev };
				delete rest[org.id];
				return rest;
			});
			const archived = res.deleted.archivedTo;
			showNotice(
				archived.length > 0
					? `Deleted ${res.deleted.name}. Files archived to ${archived.join(", ")}.`
					: `Deleted ${res.deleted.name}. No database files were found to archive.`,
				false,
			);
			await load();
		} catch (e) {
			setDeleteError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	const nameError = fieldError(errors, "name");
	const slugError = fieldError(errors, "slug");
	const adminEmailError = fieldError(errors, "admin_email");

	return (
		<div className="orgs-panel">
			<div className="orgs-toolbar">
				<button type="button" className="btn btn--on" onClick={() => setOpen(true)}>
					Create organization
				</button>
			</div>
			{notice ? <div className={noticeError ? "err" : "panel-note"}>{notice}</div> : null}
			{loadError ? <div className="err">{`Could not load organizations: ${loadError}`}</div> : null}
			{!orgs && !loadError ? (
				<div className="empty">Loading organizations…</div>
			) : orgs && orgs.length === 0 ? (
				<div className="empty">No organizations yet.</div>
			) : orgs ? (
				<table>
					<thead>
						<tr>
							<th>Name</th>
							<th>Slug</th>
							<th>ID</th>
							<th>Users</th>
							<th>Hubs</th>
							<th>Created</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{orgs.map((org) => {
							const invite = pendingInvites[org.id];
							const setupUrl = invite?.setupUrl ?? invite?.url;
							const pending = org.adminStatus === "pending";
							return (
								<tr key={org.id}>
									<td>
										{org.name}
										{org.status === "disabled" ? (
											<>
												{" "}
												<span className="badge badge--danger" title="Users and hubs of this organization are refused">
													Disabled
												</span>
											</>
										) : null}
									</td>
									<td className="mono">{org.slug}</td>
									<td>
										<CopyValue value={org.id} label={`id of ${org.name}`} />
									</td>
									<td>{org.userCount}</td>
									<td>{org.deviceCount}</td>
									<td className="mono">{timeAgo(org.createdAt)}</td>
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
										{pending ? (
											<button type="button" className="btn btn--sm" disabled={busy} onClick={() => void onResend(org)}>
												Resend invite
											</button>
										) : null}
										{org.id !== DEFAULT_ORG_ID ? (
											<>
												<button
													type="button"
													className="btn btn--sm"
													disabled={busy}
													onClick={() => void onToggleStatus(org)}
												>
													{org.status === "disabled" ? "Enable" : "Disable"}
												</button>
												<button
													type="button"
													className="btn btn--sm btn--danger"
													disabled={busy}
													onClick={() => openDelete(org)}
												>
													Delete
												</button>
											</>
										) : null}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			) : null}

			<Modal
				open={open}
				title="Create organization"
				description="Creates an isolated org database and invites its first Organization Admin."
				onClose={closeModal}
				footer={
					<>
						<button type="button" className="btn btn--ghost" onClick={closeModal} disabled={busy}>
							Cancel
						</button>
						<button type="submit" form="create-org-form" className="btn btn--on" disabled={busy || (!allowPassword && !allowGoogle)}>
							Create
						</button>
					</>
				}
			>
				<form id="create-org-form" className="orgs-create" onSubmit={onCreate}>
					<Field label="Name" required {...(nameError ? { error: nameError } : {})}>
						{(props) => (
							<input
								{...props}
								className="input"
								required
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						)}
					</Field>
					<Field
						label="Slug"
						required
						hint="Lowercase kebab-case, unique"
						{...(slugError ? { error: slugError } : {})}
					>
						{(props) => (
							<input
								{...props}
								className="input"
								required
								pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
								value={slug}
								onChange={(e) => setSlug(e.target.value)}
							/>
						)}
					</Field>
					<Field
						label="First admin email"
						required
						{...(adminEmailError ? { error: adminEmailError } : {})}
					>
						{(props) => (
							<input
								{...props}
								className="input"
								type="email"
								required
								value={adminEmail}
								onChange={(e) => setAdminEmail(e.target.value)}
							/>
						)}
					</Field>
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
					{fieldError(errors, "activation") ? (
						<p className="msg msg--error" role="alert">
							{fieldError(errors, "activation")}
						</p>
					) : null}
					{!googleAvailable ? (
						<p className="hint">Google sign-in is not configured on this server — password setup only.</p>
					) : null}
				</form>
			</Modal>

			<Modal
				open={confirmDelete !== null}
				title="Delete organization"
				description="Users lose access; files are archived to deleted-orgs/"
				onClose={closeDelete}
				footer={
					<>
						<button type="button" className="btn btn--ghost" onClick={closeDelete} disabled={busy}>
							Cancel
						</button>
						<button
							type="submit"
							form="delete-org-form"
							className="btn btn--danger"
							disabled={busy || !confirmDelete || confirmDelete.typed !== confirmDelete.org.slug}
						>
							Delete organization
						</button>
					</>
				}
			>
				{confirmDelete ? (
					<form
						id="delete-org-form"
						className="orgs-delete"
						onSubmit={(e) => {
							e.preventDefault();
							void onDelete();
						}}
					>
						<dl className="orgs-delete-summary">
							<dt>Name</dt>
							<dd>{confirmDelete.org.name}</dd>
							<dt>Slug</dt>
							<dd className="mono">{confirmDelete.org.slug}</dd>
							<dt>Users</dt>
							<dd>{confirmDelete.org.userCount}</dd>
							<dt>Hubs</dt>
							<dd>{confirmDelete.org.deviceCount}</dd>
						</dl>
						<p className="msg msg--error" role="alert">
							Users lose access; files are archived to deleted-orgs/. Sessions, invitations and linked hubs of
							this organization stop working immediately.
						</p>
						<Field
							label={`Type ${confirmDelete.org.slug} to confirm`}
							required
							{...(deleteError ? { error: deleteError } : {})}
						>
							{(props) => (
								<input
									{...props}
									className="input mono"
									autoComplete="off"
									spellCheck={false}
									value={confirmDelete.typed}
									onChange={(e) => setConfirmDelete({ ...confirmDelete, typed: e.target.value })}
								/>
							)}
						</Field>
					</form>
				) : null}
			</Modal>
		</div>
	);
}
