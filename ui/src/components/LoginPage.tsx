import { useState, type FormEvent } from "react";
import { forgotPassword, login } from "../api/auth.ts";
import type { AuthUser, FieldError } from "../api/types.ts";
import { TargetMark } from "./TargetMark.tsx";

function fieldErrors(errors: FieldError[], field: string) {
	return errors.filter((e) => e.field === field);
}

export function LoginPage({ onSuccess }: { onSuccess: (user: AuthUser) => void }) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [mode, setMode] = useState<"login" | "forgot" | "sent">("login");
	const [errors, setErrors] = useState<FieldError[]>([]);
	const [badCreds, setBadCreds] = useState(false);
	const [busy, setBusy] = useState(false);

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setErrors([]);
		setBadCreds(false);
		try {
			if (mode === "forgot") {
				await forgotPassword(email);
				setMode("sent");
				return;
			}
			const res = await login(email, password);
			if (!res.ok) {
				if ("errors" in res) setErrors(res.errors);
				else setBadCreds(true);
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
					<h1>The Target Project</h1>
					<p className="auth-muted">Report dashboard</p>
				</div>

				{mode === "sent" ? (
					<div className="auth-message">
						<p>If that address has an account, a reset link is on its way.</p>
						<button type="button" className="btn btn--ghost" onClick={() => setMode("login")}>
							Back to sign in
						</button>
					</div>
				) : (
					<form onSubmit={onSubmit} className="auth-form">
						<label className="auth-field">
							<span>Email</span>
							<input
								className="input"
								type="email"
								required
								autoComplete="username"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
							/>
							{fieldErrors(errors, "email").map((e) => (
								<span key={e.code} className="field-err">
									{e.message}
								</span>
							))}
						</label>

						{mode === "login" ? (
							<label className="auth-field">
								<span>Password</span>
								<input
									className="input"
									type="password"
									required
									autoComplete="current-password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
								/>
								{fieldErrors(errors, "password").map((e) => (
									<span key={e.code} className="field-err">
										{e.message}
									</span>
								))}
							</label>
						) : null}

						{badCreds ? <div className="err">Invalid email or password.</div> : null}

						<button type="submit" className="btn btn--on auth-submit" disabled={busy}>
							{mode === "forgot" ? "Send reset link" : "Sign in"}
						</button>

						{mode === "login" ? (
							<button type="button" className="btn btn--ghost auth-link" onClick={() => setMode("forgot")}>
								Forgot your password?
							</button>
						) : (
							<button type="button" className="btn btn--ghost auth-link" onClick={() => setMode("login")}>
								Back to sign in
							</button>
						)}
					</form>
				)}
			</div>
		</div>
	);
}
