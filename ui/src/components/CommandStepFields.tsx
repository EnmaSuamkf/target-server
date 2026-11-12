import { useEffect, useState } from "react";
import { validatePipeline } from "../api/catalog.ts";
import type { Pipeline, TemplateStep } from "../api/types.ts";

interface DeclaredInput {
	name: string;
	required: boolean;
	default: string | null;
}

/**
 * The fields of a template step that runs a pipeline: which pipeline, and one
 * text field per input the pipeline declares. The declared inputs come from the
 * server's validator, the same one that checks the YAML on save.
 */
export function CommandStepFields({
	step,
	pipelines,
	disabled,
	onChange,
}: {
	step: TemplateStep;
	pipelines: Pipeline[];
	disabled: boolean;
	onChange: (patch: Partial<TemplateStep>) => void;
}) {
	const chosen = pipelines.find((item) => item.id === step.pipelineId) ?? null;
	const chosenSource = chosen?.source ?? null;
	const [declared, setDeclared] = useState<{ source: string; inputs: DeclaredInput[] } | null>(null);
	const [inputsError, setInputsError] = useState<string | null>(null);

	useEffect(() => {
		if (chosenSource === null) return;
		let cancelled = false;
		void validatePipeline(chosenSource).then((result) => {
			if (cancelled) return;
			if (result.ok && result.data.ok) {
				setDeclared({ source: chosenSource, inputs: result.data.inputs ?? [] });
				setInputsError(null);
			} else {
				setDeclared(null);
				setInputsError(
					result.ok
						? "This pipeline no longer validates, so its inputs cannot be read."
						: "Its inputs could not be read. Reading them needs the Pipelines create or edit permission.",
				);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [chosenSource]);

	const inputs = declared && declared.source === chosenSource ? declared.inputs : [];
	const values = step.pipelineInputs ?? {};

	return (
		<div className="command-step">
			<label className="catalog-field">
				<span>Pipeline</span>
				<select
					className="input"
					disabled={disabled}
					value={step.pipelineId ?? ""}
					onChange={(event) => onChange({ pipelineId: event.target.value || null, pipelineInputs: {} })}
				>
					<option value="">{pipelines.length === 0 ? "No pipelines on this server yet" : "Choose a pipeline…"}</option>
					{pipelines.map((item) => (
						<option key={item.id} value={item.id}>
							{item.name}
						</option>
					))}
				</select>
			</label>
			{step.pipelineId && !chosen ? <p className="err">This pipeline is no longer on the server. Pick another one.</p> : null}
			{chosen && inputsError ? <p className="hint">{inputsError}</p> : null}
			{chosen && !inputsError && inputs.length === 0 && declared ? <p className="hint">This pipeline declares no inputs.</p> : null}
			{inputs.map((input) => (
				<label key={input.name} className="catalog-field">
					<span>
						{input.name}
						{input.required ? " *" : ""}
						{input.default !== null ? ` (default ${input.default})` : ""}
					</span>
					<input
						className="input"
						disabled={disabled}
						value={values[input.name] ?? ""}
						placeholder={input.default ?? ""}
						required={input.required && input.default === null}
						onChange={(event) => onChange({ pipelineInputs: { ...values, [input.name]: event.target.value } })}
					/>
				</label>
			))}
			{/* The branch agents (the hub's docs/pipelines.md, "Branch agents"): only a
			    task each, no acceptance criteria, no judge. Empty = no agent. */}
			<div className="command-step__branches">
				<label className="catalog-field command-step__branch command-step__branch--success">
					<span>Agent on success (optional)</span>
					<textarea
						className="input"
						rows={2}
						disabled={disabled}
						value={step.onSuccessTask ?? ""}
						placeholder="What an agent does after the pipeline passes"
						onChange={(event) => onChange({ onSuccessTask: event.target.value || null })}
					/>
					<small className="hint">Runs with the pipeline report. No acceptance criteria, no judge.</small>
				</label>
				<label className="catalog-field command-step__branch command-step__branch--failure">
					<span>Agent on failure (optional)</span>
					<textarea
						className="input"
						rows={2}
						disabled={disabled}
						value={step.onFailureTask ?? ""}
						placeholder="What an agent does after the pipeline fails, e.g. fix the cause"
						onChange={(event) => onChange({ onFailureTask: event.target.value || null })}
					/>
					<small className="hint">Runs after every failed run, before the next retry. No acceptance criteria, no judge.</small>
				</label>
			</div>
		</div>
	);
}
