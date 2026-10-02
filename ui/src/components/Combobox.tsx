import { useEffect, useMemo, useRef, useState } from "react";

export interface ComboboxOption {
	value: string;
	label: string;
	/** Extra text matched on but not shown; defaults to `label`. */
	searchText?: string;
}

interface ComboboxProps {
	id: string;
	options: ComboboxOption[];
	value: string;
	onChange: (value: string) => void;
	/** Row shown pinned at the top that clears the selection (value `""`). */
	allLabel: string;
	placeholder?: string;
	emptyText?: string;
}

/**
 * Accessible single-select combobox: click or focus to open, type to filter
 * live (case-insensitive substring on `searchText`/`label`), Arrow keys to
 * move, Enter to pick, Escape/click-outside to close. Mirrors a native
 * `<select>`'s value contract (`onChange(value)`) so callers need no state
 * shape changes.
 */
export function Combobox({ id, options, value, onChange, allLabel, placeholder, emptyText = "No matches" }: ComboboxProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const listId = `${id}-listbox`;

	const selected = options.find((o) => o.value === value);
	const committedLabel = value === "" ? allLabel : selected ? selected.label : value;

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return options;
		return options.filter((o) => (o.searchText ?? o.label).toLowerCase().includes(q));
	}, [options, query]);

	// Row 0 is always the pinned "All ..." clear option; real options follow.
	const rowCount = filtered.length + 1;

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				closeList();
			}
		};
		document.addEventListener("mousedown", onPointerDown, true);
		return () => document.removeEventListener("mousedown", onPointerDown, true);
	}, [open]);

	function openList() {
		if (open) return;
		setOpen(true);
		setQuery("");
		setActiveIndex(0);
	}

	function closeList() {
		setOpen(false);
		setQuery("");
	}

	function commit(nextValue: string) {
		onChange(nextValue);
		closeList();
	}

	function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			if (!open) {
				openList();
				return;
			}
			setActiveIndex((i) => Math.min(i + 1, rowCount - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			if (!open) {
				openList();
				return;
			}
			setActiveIndex((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			if (!open) return;
			e.preventDefault();
			if (activeIndex === 0) {
				commit("");
			} else {
				const opt = filtered[activeIndex - 1];
				if (opt) commit(opt.value);
			}
		} else if (e.key === "Escape") {
			if (!open) return;
			e.preventDefault();
			closeList();
		}
	}

	const displayValue = open ? query : committedLabel;
	const activeId = open ? (activeIndex === 0 ? `${id}-opt-all` : `${id}-opt-${filtered[activeIndex - 1]?.value}`) : undefined;

	return (
		<div className="combobox" ref={rootRef}>
			<input
				id={id}
				className="combobox-input"
				type="text"
				role="combobox"
				aria-expanded={open}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={activeId}
				placeholder={placeholder}
				value={displayValue}
				onFocus={openList}
				onClick={openList}
				onChange={(e) => {
					if (!open) setOpen(true);
					setQuery(e.target.value);
					setActiveIndex(0);
				}}
				onKeyDown={onKeyDown}
				onBlur={closeList}
			/>
			{open ? (
				<ul className="combobox-list" id={listId} role="listbox" onMouseDown={(e) => e.preventDefault()}>
					<li
						id={`${id}-opt-all`}
						role="option"
						aria-selected={value === ""}
						className={`combobox-option${activeIndex === 0 ? " combobox-option--active" : ""}${value === "" ? " combobox-option--selected" : ""}`}
						onMouseEnter={() => setActiveIndex(0)}
						onClick={() => commit("")}
					>
						{allLabel}
					</li>
					{filtered.length === 0 ? (
						<li className="combobox-empty" role="presentation">
							{emptyText}
						</li>
					) : (
						filtered.map((opt, i) => (
							<li
								key={opt.value}
								id={`${id}-opt-${opt.value}`}
								role="option"
								aria-selected={opt.value === value}
								className={`combobox-option${activeIndex === i + 1 ? " combobox-option--active" : ""}${opt.value === value ? " combobox-option--selected" : ""}`}
								onMouseEnter={() => setActiveIndex(i + 1)}
								onClick={() => commit(opt.value)}
							>
								{opt.label}
							</li>
						))
					)}
				</ul>
			) : null}
		</div>
	);
}
