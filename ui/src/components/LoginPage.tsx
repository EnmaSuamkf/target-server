import { useEffect, useState, type FormEvent } from "react";
import { fetchAuthProviders, forgotPassword, login } from "../api/auth.ts";
import type { AuthSession, FieldError } from "../api/types.ts";
import { TargetMark } from "./TargetMark.tsx";

function fieldErrors(errors: FieldError[], field: string) {
	return errors.filter((e) => e.field === field);
}

/** Google “G” mark (Sign in with Google branding guidelines, inline SVG). */
function GoogleGIcon() {
	return (
		<svg className="auth-google__icon" width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
			<path
				fill="#EA4335"
				d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
			/>
			<path
				fill="#4285F4"
				d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
			/>
			<path
				fill="#FBBC05"
				d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
			/>
			<path
				fill="#34A853"
				d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
			/>
			<path fill="none" d="M0 0h48v48H0z" />
		</svg>
	);
}

function oauthErrorMessage(code: string | null): string | null {
	switch (code) {
		case "not_invited":
			return "That Google account is not invited. Ask an admin to invite your email, then try again.";
		case "oauth_denied":
			return "Google sign-in was cancelled.";
		case "oauth_failed":
			return "Google sign-in failed. Try again or sign in with email and password.";
		default:
			return code ? "Sign-in failed. Try again." : null;
	}
}

export function LoginPage({ onSuccess }: { onSuccess: (session: AuthSession) => void }) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [mode, setMode] = useState<"login" | "forgot" | "sent">("login");
	const [errors, setErrors] = useState<FieldError[]>([]);
	const [badCreds, setBadCreds] = useState(false);
	const [busy, setBusy] = useState(false);
	const [googleEnabled, setGoogleEnabled] = useState(false);
	const [oauthError, setOauthError] = useState<string | null>(null);

	useEffect(() => {
		const params = new URLSearchParams(location.search);
		const authError = params.get("auth_error");
		setOauthError(oauthErrorMessage(authError));
		if (authError) {
			const url = new URL(location.href);
			url.searchParams.delete("auth_error");
			const next = `${url.pathname}${url.search}${url.hash}`;
			history.replaceState(null, "", next);
		}
	}, []);

	useEffect(() => {
		void fetchAuthProviders()
			.then((providers) => setGoogleEnabled(providers.google))
			.catch(() => setGoogleEnabled(false));
	}, []);

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
			onSuccess({ user: res.user, catalog: res.catalog ?? { groups: [] } });
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

						{oauthError ? <div className="err">{oauthError}</div> : null}
						{badCreds ? <div className="err">Invalid email or password.</div> : null}

						<button type="submit" className="btn btn--on auth-submit" disabled={busy}>
							{mode === "forgot" ? "Send reset link" : "Sign in"}
						</button>

						{mode === "login" && googleEnabled ? (
							<>
								<p className="auth-muted auth-or">or</p>
								<a className="auth-google" href="/api/auth/google">
									<GoogleGIcon />
									<span>Continue with Google</span>
								</a>
							</>
						) : null}

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
