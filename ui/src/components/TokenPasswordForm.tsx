import { useMemo, useState, type FormEvent } from "react";
import { resetPassword, setupPassword } from "../api/auth.ts";
import type { AuthUser, FieldError } from "../api/types.ts";
import { TargetMark } from "./TargetMark.tsx";

function fieldErrors(errors: FieldError[], field: string) {
	return errors.filter((e) => e.field === field);
}

export function TokenPasswordForm({
	mode,
	onSuccess,
}: {
	mode: "setup" | "reset";
	onSuccess: (user: AuthUser) => void;
}) {
	const token = useMemo(() => new URLSearchParams(location.search).get("token") ?? "", []);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [errors, setErrors] = useState<FieldError[]>([]);
	const [fatal, setFatal] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const title = mode === "setup" ? "Choose your password" : "Set a new password";
	const hint =
		mode === "setup"
			? "Finish setting up your account. The link is single-use and expires after seven days."
			: "Enter a new password. The link expires after one hour.";

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		setErrors([]);
		setFatal(null);
		if (password !== confirm) {
			setFatal("Passwords do not match.");
			return;
		}
		if (!token) {
			setFatal("Missing token in the link.");
			return;
		}
		setBusy(true);
		try {
			const res = mode === "setup" ? await setupPassword(token, password) : await resetPassword(token, password);
			if (!res.ok) {
				if ("errors" in res) setErrors(res.errors);
				else if (res.error === "already_activated") setFatal("This account is already active — use password recovery instead.");
				else setFatal(mode === "setup" ? "This link is invalid or expired. Ask whoever invited you to resend." : "This link is invalid or expired.");
				return;
			}
			onSuccess(res.user);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="auth-shell">
			<div className="auth-card">
				<div className="auth-brand">
					<span className="mark">
						<TargetMark />
					</span>
					<h1>{title}</h1>
					<p className="auth-muted">{hint}</p>
				</div>
				<form onSubmit={onSubmit} className="auth-form">
					<label className="auth-field">
						<span>New password</span>
						<input
							className="input"
							type="password"
							required
							minLength={12}
							autoComplete="new-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
						/>
						{fieldErrors(errors, "password").map((e) => (
							<span key={e.code} className="field-err">
								{e.message}
							</span>
						))}
					</label>
					<label className="auth-field">
						<span>Confirm password</span>
						<input
							className="input"
							type="password"
							required
							minLength={12}
							autoComplete="new-password"
							value={confirm}
							onChange={(e) => setConfirm(e.target.value)}
						/>
					</label>
					{fatal ? <div className="err">{fatal}</div> : null}
					<button type="submit" className="btn btn--on auth-submit" disabled={busy}>
						Continue
					</button>
				</form>
			</div>
		</div>
	);
}
