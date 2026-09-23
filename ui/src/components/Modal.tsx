import { useEffect, useId, useRef, type ReactNode } from "react";

const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible dialog: titled header, Escape to close, Tab trapped inside,
 * backdrop click dismisses only when the gesture started and ended outside.
 */
export function Modal({
	open,
	title,
	description,
	onClose,
	children,
	footer,
}: {
	open: boolean;
	title: string;
	description?: string;
	onClose: () => void;
	children?: ReactNode;
	footer?: ReactNode;
}): React.JSX.Element | null {
	const boxRef = useRef<HTMLDivElement>(null);
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	const pointerDownInside = useRef(false);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const titleId = useId();
	const descId = useId();

	useEffect(() => {
		if (!open) return;

		restoreFocusRef.current = document.activeElement as HTMLElement | null;
		const box = boxRef.current;
		const firstInBody = box?.querySelector<HTMLElement>(".modal-body")?.querySelector<HTMLElement>(FOCUSABLE);
		(firstInBody ?? box)?.focus();

		const onKeyDown = (ev: KeyboardEvent): void => {
			if (ev.key === "Escape") {
				ev.stopPropagation();
				onCloseRef.current();
				return;
			}
			if (ev.key !== "Tab") return;
			const items = boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
			if (!items || items.length === 0) return;
			const first = items[0];
			const last = items[items.length - 1];
			if (!first || !last) return;
			if (ev.shiftKey && document.activeElement === first) {
				ev.preventDefault();
				last.focus();
			} else if (!ev.shiftKey && document.activeElement === last) {
				ev.preventDefault();
				first.focus();
			}
		};

		document.addEventListener("keydown", onKeyDown, true);
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			document.body.style.overflow = previousOverflow;
			restoreFocusRef.current?.focus?.();
		};
	}, [open]);

	if (!open) return null;

	return (
		<div
			className="modal-backdrop"
			onPointerDown={(ev) => {
				pointerDownInside.current = boxRef.current?.contains(ev.target as Node) ?? false;
			}}
			onClick={(ev) => {
				if (ev.target === ev.currentTarget && !pointerDownInside.current) onClose();
				pointerDownInside.current = false;
			}}
		>
			<div
				ref={boxRef}
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				{...(description ? { "aria-describedby": descId } : {})}
				tabIndex={-1}
			>
				<div className="modal-header">
					<h2 id={titleId} className="modal-title">
						{title}
					</h2>
					<button
						type="button"
						className="btn btn--ghost btn--sm modal-close"
						onClick={onClose}
						aria-label="Close dialog"
					>
						×
					</button>
				</div>
				{description ? (
					<p id={descId} className="modal-desc">
						{description}
					</p>
				) : null}
				{children ? <div className="modal-body">{children}</div> : null}
				{footer ? <div className="modal-footer">{footer}</div> : null}
			</div>
		</div>
	);
}
