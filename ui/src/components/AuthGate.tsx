import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { fetchMe } from "../api/auth.ts";
import type { AuthUser } from "../api/types.ts";
import { App } from "../App.tsx";
import { LoginPage } from "./LoginPage.tsx";
import { TokenPasswordForm } from "./TokenPasswordForm.tsx";

type GateState = "checking" | "anonymous" | "signed-in";

export const UnauthorizedContext = createContext<(() => void) | null>(null);

export function useUnauthorized() {
	return useContext(UnauthorizedContext);
}

export function AuthGate() {
	const [state, setState] = useState<GateState>("checking");
	const [user, setUser] = useState<AuthUser | null>(null);
	const path = typeof location !== "undefined" ? location.pathname : "/";

	const probe = useCallback(async () => {
		try {
			const me = await fetchMe();
			if (me) {
				setUser(me.user);
				setState("signed-in");
			} else {
				setUser(null);
				setState("anonymous");
			}
		} catch {
			setUser(null);
			setState("anonymous");
		}
	}, []);

	useEffect(() => {
		void probe();
	}, [probe]);

	const onUnauthorized = useCallback(() => {
		setUser(null);
		setState("anonymous");
	}, []);

	const onSignedIn = useCallback((u: AuthUser) => {
		setUser(u);
		setState("signed-in");
		if (path === "/setup" || path === "/reset") {
			history.replaceState(null, "", "/");
		}
	}, [path]);

	if (path === "/setup" || path === "/reset") {
		return (
			<UnauthorizedContext.Provider value={onUnauthorized}>
				<TokenPasswordForm mode={path === "/setup" ? "setup" : "reset"} onSuccess={onSignedIn} />
			</UnauthorizedContext.Provider>
		);
	}

	if (state === "checking") {
		return (
			<div className="auth-shell">
				<p className="auth-muted">Checking session…</p>
			</div>
		);
	}

	if (state === "anonymous") {
		return <LoginPage onSuccess={onSignedIn} />;
	}

	return (
		<UnauthorizedContext.Provider value={onUnauthorized}>
			<App user={user!} onSignOut={() => { setUser(null); setState("anonymous"); }} />
		</UnauthorizedContext.Provider>
	);
}
