interface BarsProps<T> {
	rows: T[];
	/** Which field labels the row, and which one it is measured by. */
	keyName: keyof T;
	valName: keyof T;
	/** Optional prettifier for the row key (e.g. raw event kind → label). */
	keyLabel?: ((key: string) => string) | undefined;
	keyTip?: ((key: string) => string) | undefined;
}

/** A horizontal bar per row, scaled against the largest value in the set. */
export function Bars<T>({ rows, keyName, valName, keyLabel, keyTip }: BarsProps<T>) {
	if (!rows || rows.length === 0) return <div className="empty">No data for this filter.</div>;
	const values = rows.map((r) => Number(r[valName] ?? 0));
	const max = Math.max(1, ...values);
	return (
		<div className="bars">
			{rows.map((r, i) => {
				const key = String(r[keyName] ?? "unknown");
				const value = Number(r[valName] ?? 0);
				return (
					<div className="bar-row" key={`${key}-${i}`}>
						<span className="k" title={keyTip ? keyTip(key) : key}>
							{keyLabel ? keyLabel(key) : key}
						</span>
						<span className="bar-track">
							<span className="bar-fill" style={{ width: `${(value / max) * 100}%` }} />
						</span>
						<span className="n">{value}</span>
					</div>
				);
			})}
		</div>
	);
}
