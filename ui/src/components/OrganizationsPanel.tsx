import { useCallback, useEffect, useState, type FormEvent } from "react";
import { fetchAuthProviders } from "../api/auth.ts";
import { createPlatformOrg, listPlatformOrgs, resendPlatformAdminInvite } from "../api/platform.ts";
import type { FieldError, InviteLinks, PlatformOrg } from "../api/types.ts";
import { timeAgo } from "../lib/format.ts";
import { Field } from "./Field.tsx";
import { Modal } from "./Modal.tsx";

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
	const [busy, setBusy] = useState(false);
	const [pendingInvites, setPendingInvites] = useState<Record<string, InviteLinks>>({});

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
		setNotice(null);
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
			setNotice(
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
		setNotice(null);
		try {
			const res = await resendPlatformAdminInvite(org.id);
			if (!res.ok) {
				setNotice(res.error === "already_activated" ? "That admin has already activated." : "Could not resend invite.");
				return;
			}
			setPendingInvites((prev) => ({ ...prev, [org.id]: res.invite }));
			setNotice(
				res.mail.sent
					? `Invitation resent to ${res.admin.email}.`
					: `Resend failed — copy the link below for ${res.admin.email}.`,
			);
			await load();
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
			{notice ? <div className={notice.includes("failed") ? "err" : "panel-note"}>{notice}</div> : null}
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
									<td>{org.name}</td>
									<td className="mono">{org.slug}</td>
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
		</div>
	);
}
