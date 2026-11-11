/**
 * Pipeline YAML: parsing and validation (server port).
 *
 * This is a port of the hub's `hub/pipeline-yaml.ts`. The two must stay in
 * LOCKSTEP: same rules, same messages, same line numbers, same paths, same
 * sourceHash. Any change to one file must be made to the other, and both must
 * pass the shared conformance fixtures:
 *   - hub:    hub/fixtures/pipeline-conformance.json
 *   - server: test/fixtures/pipeline-conformance.json
 * The two fixture files are byte-identical copies; each repo's test checks
 * that its own validator reproduces every case exactly.
 *
 * Pure: no database, no filesystem, no network. The server stores the raw YAML
 * source and uses this module to validate it on save and on catalog sync. The
 * server never runs a pipeline (out of scope, docs/pipelines.md).
 *
 * @typedef {{ line: number | null, path: string, message: string }} PipelineError
 * @typedef {{ description: string | null, required: boolean, default: string | null }} PipelineInput
 * @typedef {"bash" | "sh" | "pwsh"} PipelineShell
 * @typedef {"success()" | "failure()" | "always()"} PipelineCondition
 * @typedef {{
 *   index: number,
 *   name: string,
 *   id: string | null,
 *   run: string,
 *   shell: PipelineShell,
 *   workingDirectory: string,
 *   env: Record<string, string>,
 *   if: PipelineCondition,
 *   continueOnError: boolean,
 *   timeoutMinutes: number,
 *   report: boolean,
 * }} PipelineJobStep
 * @typedef {{
 *   name: string,
 *   description: string | null,
 *   inputs: Record<string, PipelineInput>,
 *   env: Record<string, string>,
 *   timeoutMinutes: number,
 *   defaults: { run: { shell: PipelineShell, workingDirectory: string } },
 *   runsOn: "host",
 *   steps: PipelineJobStep[],
 * }} PipelineSpec
 * @typedef {{ ok: true, pipeline: PipelineSpec, errors: [] } | { ok: false, errors: PipelineError[] }} ParsePipelineResult
 */

import { createHash } from "node:crypto";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, visit } from "yaml";

/** The document size cap, in bytes of UTF-8. Checked before parsing. */
export const MAX_PIPELINE_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const MAX_TIMEOUT_MINUTES = 360;

const SHELLS = ["bash", "sh", "pwsh"];
const CONDITIONS = ["success()", "failure()", "always()"];

/**
 * Keys of the GitHub Actions job schema that Target recognises and refuses.
 * They get their own message, because a pasted workflow file uses them and the
 * operator needs to know why it does not validate, not that the key is unknown.
 */
const GITHUB_ONLY_KEYS = [
	"on",
	"jobs",
	"needs",
	"strategy",
	"matrix",
	"services",
	"container",
	"uses",
	"with",
	"outputs",
];

const TOP_KEYS = [
	"name",
	"description",
	"inputs",
	"env",
	"timeout-minutes",
	"defaults",
	"runs-on",
	"steps",
];
const DEFAULTS_KEYS = ["run"];
const DEFAULTS_RUN_KEYS = ["shell", "working-directory"];
const INPUT_KEYS = ["description", "required", "default"];
const STEP_KEYS = [
	"name",
	"id",
	"run",
	"shell",
	"working-directory",
	"env",
	"if",
	"continue-on-error",
	"timeout-minutes",
	"report",
];

const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STEP_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** `${{ expr }}`, non-greedy, so two expressions on one line stay two matches. */
const EXPR_RE = /\$\{\{([\s\S]*?)\}\}/g;

/**
 * The only expressions a pipeline may use outside `run:`. Anything else is a
 * validation error, so a typo in an expression never reaches the shell silently.
 */
const INPUT_EXPR = /^inputs\.([A-Za-z][A-Za-z0-9_-]*)$/;
const SECRET_EXPR = /^secrets\.([A-Za-z_][A-Za-z0-9_]*)$/;
const FIXED_EXPRS = new Set([
	"workflow.workdir",
	"workflow.id",
	"workflow.name",
	"step.results_dir",
]);

const RUN_EXPRESSION_MESSAGE =
	'${{ }} is not allowed in "run": the value would be written into the shell script, ' +
	"which allows shell injection. Pass the value through env instead, for example " +
	'env: { VALUE: ${{ inputs.x }} }, and read "$VALUE" in the script.';

/** The YAML parser settings: 1.2 semantics, duplicate keys are errors. */
const PARSE_OPTIONS = {
	version: "1.2",
	uniqueKeys: true,
	prettyErrors: false,
};

/**
 * @typedef {{ source: string, lineStarts: number[], errors: PipelineError[] }} Ctx
 * @typedef {{ key: string, keyLine: number | null, value: unknown, path: string }} Field
 */

/** @param {string} source */
export function sourceHash(source) {
	return createHash("sha256").update(source, "utf8").digest("hex");
}

/**
 * Parses and validates a pipeline. Returns the spec with defaults applied, or
 * every error found. Never throws on bad input.
 * @param {string} source
 * @returns {ParsePipelineResult}
 */
export function parsePipeline(source) {
	const bytes = Buffer.byteLength(source, "utf8");
	if (bytes > MAX_PIPELINE_BYTES) {
		return failure([
			{
				line: null,
				path: "",
				message: `the pipeline is ${bytes} bytes; the limit is ${MAX_PIPELINE_BYTES / 1024} KiB`,
			},
		]);
	}

	/** @type {Ctx} */
	const ctx = { source, lineStarts: lineStartsOf(source), errors: [] };
	const docs = parseAllDocuments(source, PARSE_OPTIONS);

	// Syntax errors make the tree unreliable, so they are returned on their own.
	for (const doc of docs) {
		for (const e of doc.errors) {
			fail(ctx, e.linePos?.[0]?.line ?? null, "", e.message);
		}
	}
	if (docs.length > 1) {
		fail(
			ctx,
			rangeLine(ctx, docs[1]),
			"",
			"a pipeline must be one YAML document; remove the extra '---' separator",
		);
	}
	if (ctx.errors.length > 0) return failure(ctx.errors);
	if (docs.length === 0) {
		return failure([{ line: null, path: "", message: "the pipeline is empty" }]);
	}

	const doc = docs[0];
	checkNoAnchorsOrAliases(ctx, doc);
	// An alias stands for a value the document does not spell out, so every
	// schema check after it would report noise. Only the alias errors are returned.
	if (ctx.errors.length > 0) return failure(ctx.errors);

	const root = doc.contents;
	if (root === null || root === undefined) {
		fail(ctx, null, "", "the pipeline is empty");
		return failure(ctx.errors);
	}
	if (!isMap(root)) {
		fail(
			ctx,
			rangeLine(ctx, root),
			"",
			"the pipeline must be a mapping with keys such as name: and steps:",
		);
		return failure(ctx.errors);
	}

	const pipeline = buildPipeline(ctx, root);
	if (ctx.errors.length > 0) return failure(ctx.errors);
	return { ok: true, pipeline, errors: [] };
}

/** @param {PipelineError[]} errors @returns {ParsePipelineResult} */
function failure(errors) {
	return { ok: false, errors };
}

// --- Aliases and anchors ----------------------------------------------------

/**
 * Anchors and aliases are rejected outright. This keeps the document a plain
 * tree (no alias-expansion blow-up) and keeps what the operator sees identical
 * to what runs.
 * @param {Ctx} ctx @param {unknown} doc
 */
function checkNoAnchorsOrAliases(ctx, doc) {
	visit(/** @type {never} */ (doc), {
		Alias(_key, node) {
			fail(
				ctx,
				rangeLine(ctx, node),
				"",
				"aliases (*name) are not allowed; write the value out in full",
			);
		},
		Node(_key, node) {
			if (!isAlias(node) && /** @type {{ anchor?: string }} */ (node).anchor) {
				fail(
					ctx,
					rangeLine(ctx, node),
					"",
					"anchors (&name) are not allowed; write the value out in full",
				);
			}
		},
	});
}

// --- Building the spec ------------------------------------------------------

/** @param {Ctx} ctx @param {unknown} root @returns {PipelineSpec} */
function buildPipeline(ctx, root) {
	const rootLine = rangeLine(ctx, root);
	const top = fieldsOfMap(ctx, /** @type {never} */ (root), "", TOP_KEYS);
	const by = indexFields(top);

	const name = requireString(ctx, by, "name", rootLine);
	const description = optionalString(ctx, by.get("description"));
	const inputs = parseInputs(ctx, by.get("inputs"));
	const inputNames = new Set(Object.keys(inputs));
	const env = parseEnv(ctx, by.get("env"), inputNames);
	const timeoutMinutes =
		timeoutField(ctx, by.get("timeout-minutes"), MAX_TIMEOUT_MINUTES) ??
		DEFAULT_TIMEOUT_MINUTES;
	const runDefaults = parseDefaults(ctx, by.get("defaults"), inputNames);
	const runsOn = runsOnField(ctx, by.get("runs-on"));
	const steps = parseSteps(
		ctx,
		by.get("steps"),
		rootLine,
		runDefaults,
		timeoutMinutes,
		inputNames,
	);

	return {
		name: name ?? "",
		description: description ?? null,
		inputs,
		env,
		timeoutMinutes,
		defaults: { run: runDefaults },
		runsOn: runsOn ?? "host",
		steps,
	};
}

/** @param {Ctx} ctx @param {Field | undefined} f @returns {Record<string, PipelineInput>} */
function parseInputs(ctx, f) {
	/** @type {Record<string, PipelineInput>} */
	const out = {};
	for (const inp of childFields(ctx, f, undefined)) {
		if (!INPUT_NAME.test(inp.key)) {
			fail(
				ctx,
				inp.keyLine,
				inp.path,
				'input names start with a letter and contain only letters, digits, "-" and "_"',
			);
			continue;
		}
		const sub = childFields(ctx, inp, INPUT_KEYS);
		const idx = indexFields(sub);
		out[inp.key] = {
			description: optionalString(ctx, idx.get("description")) ?? null,
			required: optionalBoolean(ctx, idx.get("required")) ?? false,
			default: optionalString(ctx, idx.get("default")) ?? null,
		};
	}
	return out;
}

/** @param {Ctx} ctx @param {Field | undefined} f @param {ReadonlySet<string>} inputs @returns {Record<string, string>} */
function parseEnv(ctx, f, inputs) {
	/** @type {Record<string, string>} */
	const out = {};
	for (const e of childFields(ctx, f, undefined)) {
		if (!ENV_NAME.test(e.key)) {
			fail(
				ctx,
				e.keyLine,
				e.path,
				'environment names use letters, digits and "_" and do not start with a digit',
			);
			continue;
		}
		const value = stringValue(ctx, e);
		if (value === undefined) continue;
		checkExpressions(ctx, value, fieldLine(ctx, e), e.path, inputs);
		out[e.key] = value;
	}
	return out;
}

/** @param {Ctx} ctx @param {Field | undefined} f @param {ReadonlySet<string>} inputs */
function parseDefaults(ctx, f, inputs) {
	/** @type {{ shell: PipelineShell, workingDirectory: string }} */
	const out = { shell: "bash", workingDirectory: "." };
	const defaults = childFields(ctx, f, DEFAULTS_KEYS);
	const runField = indexFields(defaults).get("run");
	const runFields = childFields(ctx, runField, DEFAULTS_RUN_KEYS);
	const idx = indexFields(runFields);
	const shell = shellField(ctx, idx.get("shell"));
	if (shell !== undefined) out.shell = shell;
	const wd = workingDirectoryField(ctx, idx.get("working-directory"), inputs);
	if (wd !== undefined) out.workingDirectory = wd;
	return out;
}

/** @param {Ctx} ctx @param {Field | undefined} f @returns {"host" | undefined} */
function runsOnField(ctx, f) {
	const value = stringValue(ctx, f);
	if (value === undefined) return undefined;
	if (value !== "host") {
		fail(
			ctx,
			fieldLine(ctx, /** @type {Field} */ (f)),
			/** @type {Field} */ (f).path,
			`runs-on "${value}" is not supported in this version; the only accepted value is "host"`,
		);
		return undefined;
	}
	return "host";
}

/**
 * @param {Ctx} ctx
 * @param {Field | undefined} f
 * @param {number | null} rootLine
 * @param {{ shell: PipelineShell, workingDirectory: string }} defaults
 * @param {number} pipelineTimeout
 * @param {ReadonlySet<string>} inputs
 * @returns {PipelineJobStep[]}
 */
function parseSteps(ctx, f, rootLine, defaults, pipelineTimeout, inputs) {
	/** @type {PipelineJobStep[]} */
	const steps = [];
	if (!f) {
		fail(ctx, rootLine, "steps", '"steps" is required');
		return steps;
	}
	const node = f.value;
	if (!isSeq(node)) {
		fail(ctx, fieldLine(ctx, f), f.path, "must be a list of job steps");
		return steps;
	}
	if (node.items.length === 0) {
		fail(ctx, fieldLine(ctx, f), f.path, "must contain at least one job step");
		return steps;
	}

	/** @type {Map<string, number>} */
	const seenIds = new Map();
	node.items.forEach((item, index) => {
		const path = `steps[${index}]`;
		if (!isMap(item)) {
			fail(
				ctx,
				rangeLine(ctx, item),
				path,
				"a job step must be a mapping with at least a run: key",
			);
			return;
		}
		steps.push(
			parseJobStep(ctx, item, index, path, defaults, pipelineTimeout, inputs, seenIds),
		);
	});
	return steps;
}

/**
 * @param {Ctx} ctx
 * @param {unknown} item
 * @param {number} index
 * @param {string} path
 * @param {{ shell: PipelineShell, workingDirectory: string }} defaults
 * @param {number} pipelineTimeout
 * @param {ReadonlySet<string>} inputs
 * @param {Map<string, number>} seenIds
 * @returns {PipelineJobStep}
 */
function parseJobStep(ctx, item, index, path, defaults, pipelineTimeout, inputs, seenIds) {
	const by = indexFields(
		fieldsOfMap(ctx, /** @type {never} */ (item), path, STEP_KEYS),
	);

	let run = "";
	const runField = by.get("run");
	if (!runField) {
		fail(ctx, rangeLine(ctx, item), path, '"run" is required');
	} else {
		const value = stringValue(ctx, runField);
		if (value !== undefined) {
			if (value.trim() === "") {
				fail(ctx, fieldLine(ctx, runField), runField.path, "must not be empty");
			}
			if (value.includes("${{")) {
				fail(
					ctx,
					runExpressionLine(ctx, runField),
					runField.path,
					RUN_EXPRESSION_MESSAGE,
				);
			}
			run = value;
		}
	}

	const id = optionalStepId(ctx, by.get("id"), seenIds, index);

	return {
		index,
		name: optionalString(ctx, by.get("name")) ?? firstLine(run),
		id: id ?? null,
		run,
		shell: shellField(ctx, by.get("shell")) ?? defaults.shell,
		workingDirectory:
			workingDirectoryField(ctx, by.get("working-directory"), inputs) ??
			defaults.workingDirectory,
		env: parseEnv(ctx, by.get("env"), inputs),
		if: conditionField(ctx, by.get("if")) ?? "success()",
		continueOnError: optionalBoolean(ctx, by.get("continue-on-error")) ?? false,
		timeoutMinutes:
			timeoutField(ctx, by.get("timeout-minutes"), MAX_TIMEOUT_MINUTES) ??
			pipelineTimeout,
		report: optionalBoolean(ctx, by.get("report")) ?? true,
	};
}

/** @param {Ctx} ctx @param {Field | undefined} f @param {Map<string, number>} seenIds @param {number} index */
function optionalStepId(ctx, f, seenIds, index) {
	const value = stringValue(ctx, f);
	if (value === undefined || f === undefined) return undefined;
	if (!STEP_ID.test(value)) {
		fail(
			ctx,
			fieldLine(ctx, f),
			f.path,
			'id starts with a letter or "_" and contains only letters, digits, "-" and "_"',
		);
		return undefined;
	}
	const first = seenIds.get(value);
	if (first !== undefined) {
		fail(
			ctx,
			fieldLine(ctx, f),
			f.path,
			`duplicate id "${value}" (already used by steps[${first}])`,
		);
		return undefined;
	}
	seenIds.set(value, index);
	return value;
}

// --- Scalar fields ----------------------------------------------------------

/** @param {Ctx} ctx @param {Map<string, Field>} by @param {string} key @param {number | null} parentLine */
function requireString(ctx, by, key, parentLine) {
	const f = by.get(key);
	if (!f) {
		fail(ctx, parentLine, key, `"${key}" is required`);
		return undefined;
	}
	const value = stringValue(ctx, f);
	if (value !== undefined && value.trim() === "") {
		fail(ctx, fieldLine(ctx, f), f.path, "must not be empty");
		return undefined;
	}
	return value;
}

/** @param {Ctx} ctx @param {Field | undefined} f */
function optionalString(ctx, f) {
	return stringValue(ctx, f);
}

/** @param {Ctx} ctx @param {Field | undefined} f @returns {string | undefined} */
function stringValue(ctx, f) {
	if (!f) return undefined;
	const node = f.value;
	if (isScalar(node) && typeof node.value === "string") return node.value;
	fail(ctx, fieldLine(ctx, f), f.path, "must be a string");
	return undefined;
}

/** @param {Ctx} ctx @param {Field | undefined} f @returns {boolean | undefined} */
function optionalBoolean(ctx, f) {
	if (!f) return undefined;
	const node = f.value;
	if (isScalar(node) && typeof node.value === "boolean") return node.value;
	// YAML 1.2 keeps `yes`/`on` as strings, so they land here with a clear hint.
	fail(ctx, fieldLine(ctx, f), f.path, "must be true or false");
	return undefined;
}

/** @param {Ctx} ctx @param {Field | undefined} f @param {number} max @returns {number | undefined} */
function timeoutField(ctx, f, max) {
	if (!f) return undefined;
	const node = f.value;
	const value = isScalar(node) ? node.value : undefined;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > max
	) {
		fail(
			ctx,
			fieldLine(ctx, f),
			f.path,
			`must be a whole number of minutes from 1 to ${max}`,
		);
		return undefined;
	}
	return value;
}

/** @param {Ctx} ctx @param {Field | undefined} f @returns {PipelineShell | undefined} */
function shellField(ctx, f) {
	const value = stringValue(ctx, f);
	if (value === undefined || f === undefined) return undefined;
	if (!SHELLS.includes(value)) {
		fail(
			ctx,
			fieldLine(ctx, f),
			f.path,
			`shell must be one of ${SHELLS.join(", ")}; got "${value}"`,
		);
		return undefined;
	}
	return /** @type {PipelineShell} */ (value);
}

/** @param {Ctx} ctx @param {Field | undefined} f @returns {PipelineCondition | undefined} */
function conditionField(ctx, f) {
	const value = stringValue(ctx, f);
	if (value === undefined || f === undefined) return undefined;
	// The `${{ }}` wrapper is optional: `if: always()` and `if: ${{ always() }}`
	// both mean the same thing.
	const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(value.trim());
	const inner = (wrapped ? wrapped[1] : value).replace(/\s+/g, "");
	if (CONDITIONS.includes(inner)) {
		return /** @type {PipelineCondition} */ (inner);
	}
	fail(
		ctx,
		fieldLine(ctx, f),
		f.path,
		"if must be success(), failure() or always() (the ${{ }} wrapper is optional)",
	);
	return undefined;
}

/**
 * A working directory is relative to the workflow's workdir and must not leave
 * it. A value with `${{ }}` cannot be checked here; the executor checks the
 * resolved path again before it starts the job step.
 * @param {Ctx} ctx @param {Field | undefined} f @param {ReadonlySet<string>} inputs @returns {string | undefined}
 */
function workingDirectoryField(ctx, f, inputs) {
	const value = stringValue(ctx, f);
	if (value === undefined || f === undefined) return undefined;
	const line = fieldLine(ctx, f);
	if (value.trim() === "") {
		fail(
			ctx,
			line,
			f.path,
			'must not be empty; use "." for the workdir itself',
		);
		return undefined;
	}
	if (value.includes("${{")) {
		checkExpressions(ctx, value, line, f.path, inputs);
		return value;
	}
	if (/^([\/\\]|[A-Za-z]:)/.test(value)) {
		fail(
			ctx,
			line,
			f.path,
			"must be relative to the workflow's workdir, not an absolute path",
		);
		return undefined;
	}
	let depth = 0;
	for (const segment of value.split(/[\/\\]+/)) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			depth--;
			if (depth < 0) {
				fail(
					ctx,
					line,
					f.path,
					'must stay inside the workflow\'s workdir; ".." leaves it',
				);
				return undefined;
			}
		} else {
			depth++;
		}
	}
	return value;
}

// --- Expressions ------------------------------------------------------------

/**
 * Checks each `${{ }}` in a value that is allowed to have them (env,
 * working-directory). Reports an unterminated `${{` as well, so a typo does
 * not reach the run as literal text.
 * @param {Ctx} ctx @param {string} text @param {number | null} line @param {string} path @param {ReadonlySet<string>} inputs
 */
function checkExpressions(ctx, text, line, path, inputs) {
	const opened = text.split("${{").length - 1;
	let closed = 0;
	for (const match of text.matchAll(EXPR_RE)) {
		closed++;
		const problem = expressionProblem(match[1].trim(), inputs);
		if (problem) fail(ctx, line, path, problem);
	}
	if (opened !== closed) {
		fail(ctx, line, path, "unterminated ${{ expression; close it with }}");
	}
}

/** @param {string} expr @param {ReadonlySet<string>} inputs @returns {string | null} */
function expressionProblem(expr, inputs) {
	const input = INPUT_EXPR.exec(expr);
	if (input) {
		return inputs.has(input[1])
			? null
			: `input "${input[1]}" is not declared in inputs`;
	}
	if (SECRET_EXPR.test(expr) || FIXED_EXPRS.has(expr)) return null;
	return (
		`expression "${expr}" is not supported; allowed: inputs.<name>, ` +
		"secrets.<NAME>, workflow.workdir, workflow.id, workflow.name, step.results_dir"
	);
}

// --- Maps and keys ----------------------------------------------------------

/**
 * The entries of a mapping, with their paths. When `allowed` is given, unknown
 * keys are reported here, with a did-you-mean hint or the GitHub Actions
 * message, so every mapping is checked the same way.
 * @param {Ctx} ctx @param {{ items: { key: unknown, value: unknown }[] }} map @param {string} parentPath @param {readonly string[]} [allowed]
 * @returns {Field[]}
 */
function fieldsOfMap(ctx, map, parentPath, allowed) {
	/** @type {Field[]} */
	const out = [];
	for (const pair of map.items) {
		const keyNode = pair.key;
		const keyValue = isScalar(keyNode) ? keyNode.value : undefined;
		if (typeof keyValue !== "string") {
			fail(
				ctx,
				rangeLine(ctx, keyNode),
				parentPath,
				"keys must be text (quote a key that looks like a number or boolean)",
			);
			continue;
		}
		out.push({
			key: keyValue,
			keyLine: rangeLine(ctx, keyNode),
			value: pair.value,
			path: childPath(parentPath, keyValue),
		});
	}
	if (allowed) {
		for (const f of out) {
			if (allowed.includes(f.key)) continue;
			if (GITHUB_ONLY_KEYS.includes(f.key)) {
				fail(
					ctx,
					f.keyLine,
					f.path,
					`"${f.key}" is a GitHub Actions key that is not supported in this version: ` +
						"a pipeline is a list of run: steps, with env, working-directory, if, " +
						"continue-on-error, timeout-minutes and report. Remove it",
				);
			} else {
				const suggestion = suggestKey(f.key, allowed);
				fail(
					ctx,
					f.keyLine,
					f.path,
					`unknown key "${f.key}"` +
						(suggestion ? ` (did you mean "${suggestion}"?)` : ""),
				);
			}
		}
	}
	return out;
}

/**
 * Fields of a mapping-valued field. A missing or empty (`key:`) value is an
 * empty mapping; any other non-mapping value is an error.
 * @param {Ctx} ctx @param {Field | undefined} f @param {readonly string[] | undefined} allowed @returns {Field[]}
 */
function childFields(ctx, f, allowed) {
	if (!f || isNullValue(f.value)) return [];
	if (!isMap(f.value)) {
		fail(ctx, fieldLine(ctx, f), f.path, "must be a mapping");
		return [];
	}
	return fieldsOfMap(ctx, f.value, f.path, allowed);
}

/** @param {Field[]} fields @returns {Map<string, Field>} */
function indexFields(fields) {
	return new Map(fields.map((f) => [f.key, f]));
}

/** @param {unknown} node */
function isNullValue(node) {
	return node === null || (isScalar(node) && node.value === null);
}

/** @param {string} parent @param {string} key */
function childPath(parent, key) {
	return parent === "" ? key : `${parent}.${key}`;
}

/** @param {string} key @param {readonly string[]} candidates @returns {string | undefined} */
function suggestKey(key, candidates) {
	// `continue_on_error` is the most common slip. Underscores for hyphens is an
	// exact match, so it is suggested before any edit-distance search runs.
	const normalized = key.replace(/_/g, "-").toLowerCase();
	if (candidates.includes(normalized)) return normalized;
	let best;
	let bestDistance = Infinity;
	for (const candidate of candidates) {
		const d = editDistance(normalized, candidate);
		if (d < bestDistance) {
			best = candidate;
			bestDistance = d;
		}
	}
	return bestDistance <= 2 ? best : undefined;
}

/**
 * Levenshtein distance. Small inputs only (keys), so the plain DP is fine.
 * @param {string} a @param {string} b @returns {number}
 */
export function editDistance(a, b) {
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		/** @type {number[]} */
		const cur = [i];
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(
				prev[j] + 1,
				cur[j - 1] + 1,
				prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		prev = cur;
	}
	return prev[b.length];
}

// --- Lines ------------------------------------------------------------------

/** @param {string} source @returns {number[]} */
function lineStartsOf(source) {
	const starts = [0];
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

/** @param {Ctx} ctx @param {number} offset @returns {number} */
function lineOfOffset(ctx, offset) {
	// Binary search for the last line start at or before the offset.
	let lo = 0;
	let hi = ctx.lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (ctx.lineStarts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}

/** @param {Ctx} ctx @param {unknown} node @returns {number | null} */
function rangeLine(ctx, node) {
	const range = /** @type {{ range?: readonly number[] } | null | undefined} */ (node)?.range;
	return range ? lineOfOffset(ctx, range[0]) : null;
}

/** @param {Ctx} ctx @param {Field} f @returns {number | null} */
function fieldLine(ctx, f) {
	return rangeLine(ctx, f.value) ?? f.keyLine;
}

/**
 * The line of the first `${{` inside a scalar. A multi-line run block can have
 * the expression several lines down, so the scalar's first line would point at
 * the wrong place.
 * @param {Ctx} ctx @param {Field} f @returns {number | null}
 */
function runExpressionLine(ctx, f) {
	const range = /** @type {{ range?: readonly number[] } | null} */ (f.value)?.range;
	if (!range) return fieldLine(ctx, f);
	const at = ctx.source.slice(range[0], range[1]).indexOf("${{");
	return at >= 0 ? lineOfOffset(ctx, range[0] + at) : fieldLine(ctx, f);
}

/** @param {Ctx} ctx @param {number | null} line @param {string} path @param {string} message */
function fail(ctx, line, path, message) {
	ctx.errors.push({ line, path, message });
}

/** @param {string} run */
function firstLine(run) {
	return run.trim().split("\n")[0].trim();
}
