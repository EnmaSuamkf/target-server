import type { StepNote, StepNoteTheme } from "../api/types.ts";
import { authorLabel, isEdited, noteTimeLabel, orderNotesForTimeline } from "../lib/stepTimeline.ts";

function dotClass(theme: StepNoteTheme): string {
	switch (theme) {
		case "warning":
			return "step-timeline__dot step-timeline__dot--warning";
		case "success":
			return "step-timeline__dot step-timeline__dot--success";
		default:
			return "step-timeline__dot step-timeline__dot--neutral";
	}
}

/**
 * Read-only timeline of a step's notes: oldest first, each row with its position,
 * time, author, an Edited marker when the note changed after creation, the full
 * text and a theme dot. Dots are joined by a vertical rail; the last row has none.
 */
export function StepTimeline({ notes, now = new Date() }: { notes: StepNote[]; now?: Date }): React.JSX.Element | null {
	if (notes.length === 0) return null;
	const ordered = orderNotesForTimeline(
		notes.map((note) => ({ ...note, createdAt: note.createdAt ?? "" })),
	);
	return (
		<div className="step-notes step-timeline" data-step-notes>
			<span className="step-notes__label">Notes</span>
			<ol className="step-timeline__list" aria-label="Step notes timeline">
				{ordered.map((note, index) => {
					const time = note.createdAt ? noteTimeLabel(note.createdAt, now) : "";
					const edited = note.createdAt && note.updatedAt ? isEdited({ createdAt: note.createdAt, updatedAt: note.updatedAt }) : false;
					return (
						<li
							key={note.id}
							className="step-timeline__item"
							data-note-theme={note.theme}
							data-note-source={note.source ?? "operator"}
						>
							<span className="step-timeline__rail" aria-hidden="true">
								<span className={dotClass(note.theme)} />
							</span>
							<div className={`step-note step-note--${note.theme} step-timeline__note`}>
								<div className="step-timeline__meta">
									<span className="step-timeline__pos">{index + 1}</span>
									{time ? (
										<time className="step-timeline__time" dateTime={note.createdAt ?? undefined}>
											{time}
										</time>
									) : null}
									<span className="step-timeline__author">{authorLabel(note.source ?? "operator")}</span>
									{edited ? <span className="step-timeline__edited">Edited</span> : null}
								</div>
								<div className="step-timeline__text">{note.content}</div>
							</div>
						</li>
					);
				})}
			</ol>
		</div>
	);
}
