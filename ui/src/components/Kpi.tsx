import type { ReactNode } from "react";

/** One number in the KPI row. `tone` paints it (accent / danger). */
export function Kpi({ label, value, tone = "" }: { label: string; value: ReactNode; tone?: string }) {
	return (
		<div className={`kpi ${tone}`.trimEnd()}>
			<div className="label">{label}</div>
			<div className="value">{value}</div>
		</div>
	);
}
