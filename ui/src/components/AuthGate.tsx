import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { fetchMe } from "../api/auth.ts";
import type { AuthSession, AuthUser, PermissionCatalog } from "../api/types.ts";
import { App } from "../App.tsx";
import { DeviceApprovalPage } from "./DeviceApprovalPage.tsx";
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
	const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
	const path = typeof location !== "undefined" ? location.pathname : "/";

	const applySession = useCallback((session: AuthSession | null) => {
		if (!session) {
			setUser(null);
			setCatalog(null);
			setState("anonymous");
			return;
		}
		setUser(session.user);
		setCatalog(session.catalog);
		setState("signed-in");
	}, []);

	const probe = useCallback(async () => {
		try {
			applySession(await fetchMe());
		} catch {
			applySession(null);
		}
	}, [applySession]);

	useEffect(() => {
		void probe();
	}, [probe]);

	const onUnauthorized = useCallback(() => {
		applySession(null);
	}, [applySession]);

	const onSignedIn = useCallback((session: AuthSession) => {
		applySession(session);
		if (path === "/setup" || path === "/reset") {
			history.replaceState(null, "", "/");
		}
	}, [applySession, path]);

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

	const linkMatch = /^\/link\/device\/([^/]+)$/.exec(path);
	if (linkMatch) {
		return <DeviceApprovalPage user={user!} requestId={decodeURIComponent(linkMatch[1]!)} />;
	}

	return (
		<UnauthorizedContext.Provider value={onUnauthorized}>
			<App user={user!} catalog={catalog} onSignOut={() => { applySession(null); }} />
		</UnauthorizedContext.Provider>
	);
}
