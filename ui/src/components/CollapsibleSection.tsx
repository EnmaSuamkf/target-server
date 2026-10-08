import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

const STORAGE_PREFIX = 'target.collapsible.'

function readStored(id: string, fallback: boolean): boolean {
	try {
		const v = window.localStorage.getItem(STORAGE_PREFIX + id)
		if (v === '1') return true
		if (v === '0') return false
	} catch {
		/* storage unavailable */
	}
	return fallback
}

function writeStored(id: string, open: boolean): void {
	try {
		window.localStorage.setItem(STORAGE_PREFIX + id, open ? '1' : '0')
	} catch {
		/* storage unavailable */
	}
}

export interface CollapsibleSectionProps {
	/** Stable persistence key. */
	id: string
	title: ReactNode
	/** Muted text shown in the header next to the title. */
	summary?: ReactNode
	/** Header controls; clicking them does not toggle the section. */
	actions?: ReactNode
	defaultOpen?: boolean
	/** Opens the section when it becomes true. */
	forceOpen?: boolean
	/** Shows an "unsaved" indicator and opens the section when it becomes true. */
	dirty?: boolean
	children?: ReactNode
}

export function CollapsibleSection({
	id,
	title,
	summary,
	actions,
	defaultOpen = false,
	forceOpen = false,
	dirty = false,
	children,
}: CollapsibleSectionProps) {
	const [open, setOpen] = useState<boolean>(() => readStored(id, defaultOpen))
	const bodyId = useId()
	const wantOpen = forceOpen || dirty
	const prevWantOpen = useRef(wantOpen)

	// Rising edge only: never re-open or close because of unrelated re-renders.
	useEffect(() => {
		if (wantOpen && !prevWantOpen.current) setOpen(true)
		prevWantOpen.current = wantOpen
	}, [wantOpen])

	function toggle() {
		const next = !open
		setOpen(next)
		writeStored(id, next)
	}

	return (
		<section className={`sync-collapsible${open ? ' sync-collapsible--open' : ''}`}>
			<div className="sync-collapsible-head">
				<button
					type="button"
					className="sync-collapsible-toggle"
					aria-expanded={open}
					aria-controls={bodyId}
					onClick={toggle}
				>
					<span className="sync-collapsible-chevron" aria-hidden="true">
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
							<path d="M4 2.5 7.5 6 4 9.5" />
						</svg>
					</span>
					<span className="sync-collapsible-title">{title}</span>
					{dirty && <span className="sync-collapsible-dirty">unsaved</span>}
					{summary != null && <span className="sync-collapsible-summary">{summary}</span>}
				</button>
				{actions != null && (
					<div className="sync-collapsible-actions" onClick={(e) => e.stopPropagation()}>
						{actions}
					</div>
				)}
			</div>
			<div className="sync-collapsible-body" id={bodyId} hidden={!open}>
				{children}
			</div>
		</section>
	)
}
