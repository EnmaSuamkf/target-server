import type { ReactNode } from "react";

/**
 * One number in the KPI row. `tone` paints it (accent / danger); `hint` is an
 * optional second reading of the same number underneath — the token tiles use
 * it for the client's compact form ("16.0M"), so the full digits and the string
 * the operator's client prints are both on screen.
 */
export function Kpi({ label, value, tone = "", hint = null }: { label: string; value: ReactNode; tone?: string; hint?: ReactNode }) {
	return (
		<div className={`kpi ${tone}`.trimEnd()}>
			<div className="label">{label}</div>
			<div className="value">{value}</div>
			{hint ? <div className="hint">{hint}</div> : null}
		</div>
	);
}
