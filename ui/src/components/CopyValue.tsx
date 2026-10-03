import { useEffect, useRef, useState } from "react";

/**
 * A value in monospace with a small Copy button. The value stays selectable, so
 * when the clipboard API is missing or rejects, a visible message tells the user
 * to select it by hand. "Copied" shows for about two seconds.
 */
export function CopyValue({ value, label }: { value: string; label: string }) {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

	async function copy() {
		let next: "copied" | "failed" = "copied";
		try {
			await navigator.clipboard.writeText(value);
		} catch {
			next = "failed";
		}
		setState(next);
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setState("idle"), next === "copied" ? 2000 : 6000);
	}

	return (
		<span className="copy-value">
			<span className="mono copy-value__text">{value}</span>
			<button type="button" className="btn btn--sm" aria-label={`Copy ${label}`} onClick={() => void copy()}>
				{state === "copied" ? "Copied" : "Copy"}
			</button>
			<span className="copy-value__status" role="status" data-state={state}>
				{state === "copied" ? "Copied to clipboard" : state === "failed" ? "Could not copy: select the value and copy it manually." : ""}
			</span>
		</span>
	);
}
