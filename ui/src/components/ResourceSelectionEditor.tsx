import { useState } from "react";
import type { ResourceSelection, ResourceSet } from "../api/types.ts";
import {
	describeResourceSelection,
	isResourceSelected,
	isSetFullySelected,
	isSetPartiallySelected,
	toggleResource,
	toggleSetAll,
} from "../lib/rciSelection.ts";

function selectionLabel(summary: ReturnType<typeof describeResourceSelection>): string | null {
	if (!summary.attached) return null;
	if (summary.allResources) return "All resources";
	return `${summary.count} selected`;
}

/** Compact RCI picker: one row per set, expand to choose individual resources. */
export function ResourceSelectionEditor({
	resourceSets,
	selections,
	disabled,
	onChange,
}: {
	resourceSets: ResourceSet[];
	selections: ResourceSelection[];
	disabled?: boolean;
	onChange: (next: ResourceSelection[]) => void;
}) {
	const [pickerId, setPickerId] = useState<string | null>(null);

	if (resourceSets.length === 0) {
		return <p className="hint">No resource sets yet — create one in Agent Resources.</p>;
	}

	return (
		<ul className="catalog-picker sync-catalog-list">
			{resourceSets.map((set) => {
				const summary = describeResourceSelection(selections, set.id, set.resources.length);
				const label = selectionLabel(summary);
				const resourceNames = set.resources.map((resource) => resource.name);
				const open = pickerId === set.id;

				return (
					<li key={set.id} className="sync-catalog-row">
						<div className="sync-catalog-row__main">
							<label className="users-check">
								<input
									type="checkbox"
									checked={isSetFullySelected(selections, set.id)}
									ref={(el) => {
										if (el) el.indeterminate = isSetPartiallySelected(selections, set.id);
									}}
									disabled={disabled}
									onChange={() => onChange(toggleSetAll(selections, set.id))}
								/>
								<span>{set.name}</span>
								<span className="hint">
									({set.resources.length} resource{set.resources.length === 1 ? "" : "s"})
								</span>
							</label>
							<div className="sync-catalog-row__actions">
								{label ? (
									<span className={`badge ${summary.allResources ? "badge--success" : "badge--neutral"}`}>{label}</span>
								) : null}
								{set.resources.length > 0 ? (
									<button
										type="button"
										className="btn btn--sm btn--ghost"
										disabled={disabled}
										onClick={() => setPickerId(open ? null : set.id)}
									>
										{open ? "Done" : "Choose resources…"}
									</button>
								) : null}
							</div>
						</div>
						{open ? (
							<div className="catalog-picker-tools">
								{set.resources.map((resource) => (
									<label key={resource.name} className="users-check">
										<input
											type="checkbox"
											checked={isResourceSelected(selections, set.id, resource.name)}
											disabled={disabled}
											onChange={() =>
												onChange(toggleResource(selections, set.id, resource.name, resourceNames))
											}
										/>
										{resource.name}
										{resource.description ? <span className="hint">{resource.description}</span> : null}
									</label>
								))}
							</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}
