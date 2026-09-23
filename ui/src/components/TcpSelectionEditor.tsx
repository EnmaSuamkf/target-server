import { useState } from "react";
import type { Tcp, TcpSelection } from "../api/types.ts";
import {
	describeTcpSelection,
	isTcpFullySelected,
	isTcpPartiallySelected,
	isToolSelected,
	toggleTcpAll,
	toggleTcpTool,
} from "../lib/tcpSelection.ts";

function selectionLabel(summary: ReturnType<typeof describeTcpSelection>): string | null {
	if (!summary.attached) return null;
	if (summary.allTools) return "All tools";
	return `${summary.count} selected`;
}

/** Compact TCP picker: one row per pack, expand to choose individual tools. */
export function TcpSelectionEditor({
	tcps,
	selections,
	disabled,
	onChange,
}: {
	tcps: Tcp[];
	selections: TcpSelection[];
	disabled?: boolean;
	onChange: (next: TcpSelection[]) => void;
}) {
	const [pickerTcpId, setPickerTcpId] = useState<string | null>(null);

	if (tcps.length === 0) {
		return <p className="hint">No TCP packs yet — create one in Agent Resources.</p>;
	}

	return (
		<ul className="catalog-picker sync-catalog-list">
			{tcps.map((tcp) => {
				const fullySelected = isTcpFullySelected(selections, tcp.id);
				const partiallySelected = isTcpPartiallySelected(selections, tcp.id);
				const summary = describeTcpSelection(selections, tcp.id, tcp.tools.length);
				const label = selectionLabel(summary);
				const toolNames = tcp.tools.map((tool) => tool.name);
				const open = pickerTcpId === tcp.id;

				return (
					<li key={tcp.id} className="sync-catalog-row">
						<div className="sync-catalog-row__main">
							<label className="users-check">
								<input
									type="checkbox"
									checked={fullySelected}
									ref={(el) => {
										if (el) el.indeterminate = partiallySelected;
									}}
									disabled={disabled}
									onChange={() => onChange(toggleTcpAll(selections, tcp.id))}
								/>
								<span>{tcp.name}</span>
								<span className="hint">
									({tcp.tools.length} tool{tcp.tools.length === 1 ? "" : "s"})
								</span>
							</label>
							<div className="sync-catalog-row__actions">
								{label ? (
									<span className={`badge ${summary.allTools ? "badge--success" : "badge--neutral"}`}>{label}</span>
								) : null}
								{tcp.tools.length > 0 ? (
									<button
										type="button"
										className="btn btn--sm btn--ghost"
										disabled={disabled}
										onClick={() => setPickerTcpId(open ? null : tcp.id)}
									>
										{open ? "Done" : "Choose tools…"}
									</button>
								) : null}
							</div>
						</div>
						{open ? (
							<div className="catalog-picker-tools">
								{tcp.tools.map((tool) => (
									<label key={tool.name} className="users-check">
										<input
											type="checkbox"
											checked={isToolSelected(selections, tcp.id, tool.name)}
											disabled={disabled}
											onChange={() => onChange(toggleTcpTool(selections, tcp.id, tool.name, toolNames))}
										/>
										{tool.name}
										{tool.description ? <span className="hint">{tool.description}</span> : null}
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
