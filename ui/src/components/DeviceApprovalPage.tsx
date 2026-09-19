import { useState } from "react";
import type { AuthUser } from "../api/types.ts";
import { TargetMark } from "./TargetMark.tsx";

export function DeviceApprovalPage({ user, requestId }: { user: AuthUser; requestId: string }) {
	const [state, setState] = useState<"ready" | "working" | "approved" | "denied" | "error">("ready");
	const [message, setMessage] = useState("");
	const allowed = user.permissions.includes("devices.link");

	async function decide(action: "approve" | "deny") {
		setState("working");
		setMessage("");
		try {
			const response = await fetch(`/api/device-links/requests/${encodeURIComponent(requestId)}/${action}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			const body = await response.json();
			if (!response.ok) throw new Error(body.error === "forbidden" ? "Your account cannot approve devices." : "This link request is unavailable or expired.");
			setState(action === "approve" ? "approved" : "denied");
		} catch (error) {
			setState("error");
			setMessage(error instanceof Error ? error.message : "Could not complete the request.");
		}
	}

	const terminal = state === "approved" || state === "denied" || state === "error";
	const title =
		state === "approved" ? "Device approved" :
		state === "denied" ? "Link denied" :
		state === "error" ? "Link unavailable" :
		"Approve this Target hub";

	return (
		<main className="device-approval-shell">
			<section className="device-approval-card" aria-labelledby="device-approval-title">
				<div className="device-approval-brand">
					<span className="device-approval-mark"><TargetMark /></span>
					<span>The Target Project</span>
				</div>
				<div className={`device-approval-status device-approval-status--${state}`} aria-hidden="true">
					<span className="device-approval-status__ring" />
					<span className="device-approval-status__hub">⌂</span>
				</div>
				<p className="device-approval-eyebrow">Secure device linking</p>
				<h1 id="device-approval-title">{title}</h1>
				{!terminal && <p className="device-approval-lede">A Target hub is waiting for your decision. Confirm only if you started this connection from a hub you trust.</p>}
				<div className="device-approval-security" role="note">
					<span aria-hidden="true">⌁</span>
					<span>Google/email and password sign-in stay with this server. They are never delivered to the hub.</span>
				</div>
				<div className="device-approval-message" aria-live="polite" aria-atomic="true">
					{state === "working" && <p>Saving your decision securely…</p>}
					{state === "approved" && <p>Approved. Return to Target to finish connecting this hub.</p>}
					{state === "denied" && <p>Denied. The hub remains local-only and can be linked again later.</p>}
					{state === "error" && <p role="alert">{message || "This request may have expired or is no longer available."}</p>}
					{state === "ready" && !allowed && <p role="alert">Your account does not have permission to approve devices.</p>}
				</div>
				{state === "ready" && allowed && (
					<div className="device-approval-actions">
						<button type="button" className="btn device-approval-approve" onClick={() => void decide("approve")}>Approve device</button>
						<button type="button" className="btn btn--ghost device-approval-deny" onClick={() => void decide("deny")}>Deny</button>
					</div>
				)}
				<p className="device-approval-footnote">No device secret, pairing code, or account identifier is displayed on this page.</p>
			</section>
		</main>
	);
}
