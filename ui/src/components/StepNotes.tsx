import type { StepNote, StepNoteTheme } from "../api/types.ts";

function noteClass(theme: StepNoteTheme): string {
	switch (theme) {
		case "warning":
			return "step-note step-note--warning";
		case "success":
			return "step-note step-note--success";
		default:
			return "step-note step-note--neutral";
	}
}

/** Read-only sticky notes — same post-it layout as the Target hub client. */
export function StepNotes({ notes }: { notes: StepNote[] }): React.JSX.Element | null {
	if (notes.length === 0) return null;
	return (
		<div className="step-notes" data-step-notes>
			<span className="step-notes__label">Notes</span>
			<div className="step-notes__list">
				{notes.map((note) => (
					<div key={note.id} className={noteClass(note.theme)} data-note-theme={note.theme}>
						{note.content}
					</div>
				))}
			</div>
		</div>
	);
}
