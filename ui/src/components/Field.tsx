import { useId, type ReactNode } from "react";

export type FieldControlProps = {
	id: string;
	"aria-describedby"?: string;
	"aria-invalid"?: boolean;
};

/**
 * Labelled form control: a real `<label>`, optional required mark, the control,
 * then a hint and an inline error. Help stays on the page (aria-describedby)
 * instead of living only in a `title` tooltip.
 */
export function Field({
	label,
	hint,
	error,
	required,
	children,
}: {
	label: string;
	hint?: string;
	error?: string;
	required?: boolean;
	children: (props: FieldControlProps) => ReactNode;
}): React.JSX.Element {
	const id = useId();
	const hintId = hint ? `${id}-hint` : undefined;
	const errorId = error ? `${id}-error` : undefined;
	const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
	const controlProps: FieldControlProps = { id };
	if (describedBy) controlProps["aria-describedby"] = describedBy;
	if (error) controlProps["aria-invalid"] = true;

	return (
		<div className="field">
			<label className="label" htmlFor={id}>
				{label}
				{required ? (
					<span className="field-required" aria-hidden="true">
						*
					</span>
				) : null}
			</label>
			{children(controlProps)}
			{hint ? (
				<p className="hint" id={hintId}>
					{hint}
				</p>
			) : null}
			{error ? (
				<p className="msg msg--error" id={errorId} role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
