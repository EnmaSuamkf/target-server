/**
 * Request validation — single source of truth (joi on the server only).
 */
import Joi from "joi";

const EMAIL = Joi.string()
	.trim()
	.lowercase()
	.max(254)
	.email({ minDomainSegments: 2, tlds: { allow: true } })
	.required();

const PASSWORD = Joi.string().min(12).max(200).required();
const TOKEN = Joi.string().hex().length(64).required();

const USER_CREATE_ACTIVATION = Joi.object({
	password: Joi.boolean().default(false),
	google: Joi.boolean().default(false),
}).custom((value, helpers) => {
	if (value.password || value.google) return value;
	return helpers.error("any.custom", { message: "At least one activation method must be enabled" });
});

const STRING = Joi.string().trim().min(1);
const OPTIONAL_STRING = Joi.string().trim().allow("");
const STEP_KEY = Joi.string().trim().min(1);
const ISO_TIME = Joi.string().isoDate();
const DEVICE_ID = Joi.string().trim().min(1).max(200);
const DEVICE_PUBLIC_KEY = Joi.object({
	algorithm: Joi.string().valid("ed25519").required(),
	value: Joi.string().trim().min(32).max(1000).required(),
});

const TEMPLATE_STEP_NOTE = Joi.object({
	id: OPTIONAL_STRING.optional(),
	content: STRING.required(),
	theme: Joi.string().valid("warning", "success", "neutral").optional(),
});

const STEP_DEF = Joi.object({
	step_key: STEP_KEY.required(),
	description: STRING.required(),
	acceptance_criteria: OPTIONAL_STRING.optional(),
	manual_review: Joi.boolean().optional(),
	use_subagent: Joi.boolean().optional(),
	max_retries: Joi.number().integer().min(0).optional(),
	retry_interval_seconds: Joi.number().integer().min(0).optional(),
	order_index: Joi.number().integer().min(0).optional(),
});
const TCP_SELECTION = Joi.object({
	tcpId: STRING.optional(),
	mtpId: STRING.optional(),
	toolNames: Joi.array().items(STRING).allow(null).optional(),
}).or("tcpId", "mtpId");
const RESOURCE_SELECTION = Joi.object({
	resourceSetId: STRING.optional(),
	skillSetId: STRING.optional(),
	resourceNames: Joi.array().items(STRING).allow(null).optional(),
	skillNames: Joi.array().items(STRING).allow(null).optional(),
}).or("resourceSetId", "skillSetId");

export const COMMAND_TYPES = [
	"workflow.create",
	"workflow.delete",
	"workflow.rename",
	"workflow.set_context",
	"workflow.start",
	"workflow.pause",
	"workflow.resume",
	"workflow.restart",
	"workflow.set_selection",
	"workflow.set_status",
	"step.add",
	"step.edit",
	"step.remove",
	"step.move",
	"step.run",
	"step.abort",
	"step.continue",
	"step.set_status",
	"workflow.create_with_steps",
	"workflow.apply_template",
	"template.upsert",
	"template.delete",
	"tcp-tool.upsert",
	"tcp-tool.delete",
	"resource-set.upsert",
	"resource-set.delete",
];

export const EVENT_TYPES = [
	"client.heartbeat",
	"command.ack",
	"workflow.created",
	"workflow.status_changed",
	"step.status_changed",
	"step.result",
	"workflow.completed",
	"workflow.failed",
	"template.upserted",
	"template.deleted",
	"tcp-tool.upserted",
	"tcp-tool.deleted",
	"resource-set.upserted",
	"resource-set.deleted",
];

const RESOURCE_CAPABILITIES = Joi.object({
	version: Joi.number().integer().valid(2).required(),
	templates: Joi.boolean().default(false),
	tcp_tools: Joi.boolean().default(false),
	resource_sets: Joi.boolean().default(false),
}).optional();

const CAPABILITIES = Joi.object({
	commands: Joi.array()
		.items(Joi.string().valid(...COMMAND_TYPES))
		.optional(),
	max_batch_events: Joi.number().integer().min(1).max(1000).optional(),
	resources: RESOURCE_CAPABILITIES,
}).unknown(true);

const COMMAND_PAYLOADS = {
	"command.workflow.create": Joi.object({
		name: STRING.required(),
		workdir: OPTIONAL_STRING.optional(),
		agent: OPTIONAL_STRING.optional(),
		sandbox: OPTIONAL_STRING.optional(),
	}),
	"command.workflow.delete": Joi.object({
		force: Joi.boolean().optional(),
	}).default({}),
	"command.workflow.rename": Joi.object({
		name: STRING.required(),
	}),
	"command.workflow.set_context": Joi.object({
		conversation_context: STRING.required(),
	}),
	"command.workflow.start": Joi.object({
		step_keys: Joi.array().items(STEP_KEY).optional(),
	}).default({}),
	"command.workflow.pause": Joi.object({}).max(0).default({}),
	"command.workflow.resume": Joi.object({
		step_keys: Joi.array().items(STEP_KEY).optional(),
	}).default({}),
	"command.workflow.restart": Joi.object({
		preserve_context: Joi.boolean().optional(),
		step_keys: Joi.array().items(STEP_KEY).optional(),
	}).default({}),
	"command.workflow.set_selection": Joi.object({
		tcp_selections: Joi.array().items(TCP_SELECTION).optional(),
		resource_selections: Joi.array().items(RESOURCE_SELECTION).optional(),
	}).min(1),
	"command.workflow.set_status": Joi.object({
		status: STRING.required(),
	}),
	"command.step.add": Joi.object({
		step_key: STEP_KEY.required(),
		description: STRING.required(),
		acceptance_criteria: OPTIONAL_STRING.optional(),
		manual_review: Joi.boolean().optional(),
		use_subagent: Joi.boolean().optional(),
		max_retries: Joi.number().integer().min(0).optional(),
		retry_interval_seconds: Joi.number().integer().min(0).optional(),
		order_index: Joi.number().integer().min(0).optional(),
		notes: Joi.array().items(TEMPLATE_STEP_NOTE).optional(),
	}),
	"command.step.edit": Joi.object({
		step_key: STEP_KEY.required(),
		description: OPTIONAL_STRING.optional(),
		acceptance_criteria: OPTIONAL_STRING.optional(),
		manual_review: Joi.boolean().optional(),
		use_subagent: Joi.boolean().optional(),
		max_retries: Joi.number().integer().min(0).optional(),
		retry_interval_seconds: Joi.number().integer().min(0).optional(),
	}).min(2),
	"command.step.remove": Joi.object({
		step_key: STEP_KEY.required(),
	}),
	"command.step.move": Joi.object({
		step_key: STEP_KEY.required(),
		to_index: Joi.number().integer().min(0).required(),
	}),
	"command.step.run": Joi.object({
		step_key: STEP_KEY.required(),
	}),
	"command.step.abort": Joi.object({
		step_key: STEP_KEY.required(),
	}),
	"command.step.continue": Joi.object({
		step_key: STEP_KEY.required(),
		note: OPTIONAL_STRING.optional(),
	}),
	"command.step.set_status": Joi.object({
		step_key: STEP_KEY.required(),
		status: STRING.required(),
	}),
	"command.workflow.create_with_steps": Joi.object({
		name: STRING.required(),
		workdir: OPTIONAL_STRING.optional(),
		conversation_context: OPTIONAL_STRING.optional(),
		steps: Joi.array().items(STEP_DEF).min(1).required(),
	}),
	"command.workflow.apply_template": Joi.object({
		template_id: STRING.required(),
		name: OPTIONAL_STRING.optional(),
		workdir: OPTIONAL_STRING.optional(),
		variables: Joi.object().optional(),
	}),
	"command.template.upsert": Joi.object({
		resource: Joi.object({ id: STRING.required(), name: STRING.required(), data: Joi.object().unknown(true).default({}) }).required(),
	}),
	"command.template.delete": Joi.object({ resource_id: STRING.required() }),
	"command.tcp-tool.upsert": Joi.object({
		resource: Joi.object({ id: STRING.required(), name: STRING.required(), data: Joi.object().unknown(true).default({}) }).required(),
	}),
	"command.tcp-tool.delete": Joi.object({ resource_id: STRING.required() }),
	"command.resource-set.upsert": Joi.object({
		resource: Joi.object({ id: STRING.required(), name: STRING.required(), data: Joi.object().unknown(true).default({}) }).required(),
	}),
	"command.resource-set.delete": Joi.object({ resource_id: STRING.required() }),
};

const EVENT_PAYLOADS = {
	"event.client.heartbeat": Joi.object({
		status: Joi.string().valid("idle", "busy").required(),
		active_remote_ids: Joi.array().items(STRING).optional(),
	}),
	"event.command.ack": Joi.object({
		command_id: STRING.required(),
		status: Joi.string().valid("acked", "failed").required(),
		error: Joi.object().optional(),
	}),
	"event.workflow.created": Joi.object({
		name: STRING.required(),
		origin: Joi.string().valid("local", "remote").required(),
		workdir: OPTIONAL_STRING.optional(),
	}),
	"event.workflow.status_changed": Joi.object({
		from: OPTIONAL_STRING.optional(),
		to: STRING.required(),
	}),
	"event.step.status_changed": Joi.object({
		step_key: STEP_KEY.required(),
		local_step_id: OPTIONAL_STRING.optional(),
		from: OPTIONAL_STRING.optional(),
		to: STRING.required(),
	}),
	"event.step.result": Joi.object({
		step_key: STEP_KEY.required(),
		local_step_id: OPTIONAL_STRING.optional(),
		outcome: STRING.required(),
		summary: OPTIONAL_STRING.optional(),
		usage: Joi.object().optional(),
	}),
	"event.workflow.completed": Joi.object({
		final_status: STRING.required(),
		step_count: Joi.number().integer().min(0).optional(),
	}),
	"event.workflow.failed": Joi.object({
		reason: STRING.required(),
		failed_step_key: OPTIONAL_STRING.optional(),
		error: Joi.object().optional(),
	}),
	"event.template.upserted": Joi.object({ resource: Joi.object({ id: STRING.required(), name: STRING.required(), data: Joi.object().unknown(true).default({}) }).required() }),
	"event.template.deleted": Joi.object({ resource_id: STRING.required() }),
	"event.tcp-tool.upserted": Joi.object({ resource: Joi.object({ id: STRING.required(), name: STRING.required(), data: Joi.object().unknown(true).default({}) }).required() }),
	"event.tcp-tool.deleted": Joi.object({ resource_id: STRING.required() }),
	"event.resource-set.upserted": Joi.object({ resource: Joi.object({ id: STRING.required(), name: STRING.required(), data: Joi.object().unknown(true).default({}) }).required() }),
	"event.resource-set.deleted": Joi.object({ resource_id: STRING.required() }),
};

const SYNC_EVENT_ITEM = Joi.object({
	id: STRING.required(),
	type: Joi.string()
		.valid(...EVENT_TYPES)
		.required(),
	remote_id: OPTIONAL_STRING.optional(),
	payload: Joi.object().default({}),
	created_at: ISO_TIME.optional(),
});

const TAGS = Joi.array().items(Joi.string().trim().allow(""));
const TEMPLATE_STEP = Joi.object({
	description: STRING.required(),
	acceptanceCriteria: OPTIONAL_STRING.allow(null).optional(),
	manualReview: Joi.boolean().optional(),
	useSubagent: Joi.boolean().optional(),
	maxRetries: Joi.number().integer().min(0).optional(),
	retryIntervalSeconds: Joi.number().integer().min(0).optional(),
	notes: Joi.array().items(TEMPLATE_STEP_NOTE).optional(),
});
const TEMPLATE_CREATE = Joi.object({
	name: STRING.required(),
	tags: TAGS.optional(),
	steps: Joi.array().items(TEMPLATE_STEP).optional(),
	tcpIds: Joi.array().items(STRING).optional(),
	tcpSelections: Joi.array().items(TCP_SELECTION).optional(),
	resourceSelections: Joi.array().items(RESOURCE_SELECTION).optional(),
});
const TEMPLATE_UPDATE = Joi.object({
	name: STRING.optional(),
	tags: TAGS.optional(),
	steps: Joi.array().items(TEMPLATE_STEP).optional(),
	tcpIds: Joi.array().items(STRING).optional(),
	tcpSelections: Joi.array().items(TCP_SELECTION).optional(),
	resourceSelections: Joi.array().items(RESOURCE_SELECTION).optional(),
});
const TEMPLATE_IMPORT = Joi.alternatives()
	.try(
		Joi.object({
			kind: Joi.string().valid("target.templates").required(),
			schemaVersion: Joi.number().integer().min(1).optional(),
			exportedAt: OPTIONAL_STRING.optional(),
			templates: Joi.array().items(TEMPLATE_CREATE).min(1).required(),
		}),
		TEMPLATE_CREATE,
		Joi.array().items(TEMPLATE_CREATE).min(1),
	)
	.required();

const TCP_TOOL_INPUT = Joi.object({
	name: STRING.required(),
	placeholder: STRING.required(),
	description: OPTIONAL_STRING.optional(),
	required: Joi.boolean().optional(),
});
const TCP_TOOL = Joi.object({
	name: STRING.required(),
	description: OPTIONAL_STRING.optional(),
	requestTemplate: STRING.required(),
	inputs: Joi.array().items(TCP_TOOL_INPUT).optional(),
	tokens: Joi.object().pattern(Joi.string(), Joi.string().allow("")).optional(),
});
const TCP_CREATE = Joi.object({
	name: STRING.required(),
	tags: TAGS.optional(),
	tools: Joi.array().items(TCP_TOOL).optional(),
});
const TCP_UPDATE = Joi.object({
	name: STRING.optional(),
	tags: TAGS.optional(),
	tools: Joi.array().items(TCP_TOOL).optional(),
});
const TCP_IMPORT = Joi.alternatives()
	.try(
		Joi.object({
			kind: Joi.string().valid("target.tcps").required(),
			schemaVersion: Joi.number().integer().min(1).optional(),
			exportedAt: OPTIONAL_STRING.optional(),
			tcps: Joi.array().items(TCP_CREATE).min(1).required(),
		}),
		TCP_CREATE,
		Joi.array().items(TCP_CREATE).min(1),
	)
	.required();

function rejectDotDot(value, helpers) {
	if (String(value).includes("..")) return helpers.error("any.invalid");
	return value;
}
const RESOURCE_FILE = Joi.object({
	path: STRING.required().custom(rejectDotDot),
	content: Joi.string().allow("").required(),
});
const RESOURCE = Joi.object({
	name: STRING.required(),
	description: OPTIONAL_STRING.optional(),
	kind: Joi.string().valid("skill", "agent", "doc").optional(),
	entryFile: OPTIONAL_STRING.optional().custom(rejectDotDot),
	content: Joi.string().allow("").optional(),
	files: Joi.array().items(RESOURCE_FILE).optional(),
});
const RESOURCE_SET_CREATE = Joi.object({
	name: STRING.required(),
	tags: TAGS.optional(),
	resources: Joi.array().items(RESOURCE).optional(),
});
const RESOURCE_SET_UPDATE = Joi.object({
	name: STRING.optional(),
	tags: TAGS.optional(),
	resources: Joi.array().items(RESOURCE).optional(),
});
const RESOURCE_SET_IMPORT = Joi.alternatives()
	.try(
		Joi.object({
			kind: Joi.string().valid("target-server.resource-sets").required(),
			resourceSets: Joi.array().items(RESOURCE_SET_CREATE).min(1).required(),
		}),
		RESOURCE_SET_CREATE,
		Joi.array().items(RESOURCE_SET_CREATE).min(1),
	)
	.required();

export const BLUEPRINTS = {
	"user.create": Joi.object({
		email: EMAIL,
		role_id: Joi.string().trim().min(1).optional(),
		activation: USER_CREATE_ACTIVATION.optional(),
	}),
	"user.role": Joi.object({
		role_id: Joi.string().trim().min(1).required(),
	}),
	"role.create": Joi.object({
		name: Joi.string().trim().min(1).max(100).required(),
		permissions: Joi.array().items(Joi.string().trim().min(1)).required(),
	}),
	"role.update": Joi.object({
		name: Joi.string().trim().min(1).max(100).required(),
		permissions: Joi.array().items(Joi.string().trim().min(1)).required(),
	}),
	"auth.login": Joi.object({ email: EMAIL, password: Joi.string().required() }),
	"auth.forgot": Joi.object({ email: EMAIL }),
	"auth.passwordReset": Joi.object({
		deliver: Joi.string().valid("email", "link").required(),
	}),
	"auth.setup": Joi.object({ token: TOKEN, password: PASSWORD }),
	"auth.reset": Joi.object({ token: TOKEN, password: PASSWORD }),

	"sync.register": Joi.object({
		name: OPTIONAL_STRING.optional(),
		instance_id: OPTIONAL_STRING.optional(),
		display_name: OPTIONAL_STRING.optional(),
		version: OPTIONAL_STRING.optional(),
		capabilities: CAPABILITIES.optional(),
		registration_secret: OPTIONAL_STRING.optional(),
	}),
	"sync.heartbeat": Joi.object({
		status: Joi.string().valid("idle", "busy").required(),
		capabilities: CAPABILITIES.optional(),
		version: OPTIONAL_STRING.optional(),
		hub_version: OPTIONAL_STRING.optional(),
		instance_id: OPTIONAL_STRING.optional(),
		active_remote_ids: Joi.array().items(STRING).optional(),
		sent_at: ISO_TIME.optional(),
	}),
	"sync.command_ack": Joi.object({
		status: Joi.string().valid("applied", "failed").required(),
		local_id: OPTIONAL_STRING.optional(),
		remote_id: OPTIONAL_STRING.optional(),
		result: Joi.object().optional(),
		error: Joi.object().optional(),
	}),
	"sync.events": Joi.object({
		batch_id: OPTIONAL_STRING.optional(),
		events: Joi.array().items(SYNC_EVENT_ITEM).min(1).required(),
	}),
	"sync.remote_workflow.create": Joi.object({
		client_id: STRING.required(),
		name: STRING.required(),
		conversation_context: OPTIONAL_STRING.optional(),
		agent: Joi.string().valid("claude", "free-code", "cursor").optional(),
		template_id: STRING.optional(),
	}),
	"sync.remote_workflow.steps_from_template": Joi.object({
		template_id: STRING.required(),
	}),
	"sync.remote_workflow.enqueue_command": Joi.object({
		type: Joi.string()
			.valid(...COMMAND_TYPES)
			.required(),
		// Allow command-specific keys (e.g. step_keys) — stripUnknown on a bare
		// Joi.object() would drop them before resolveRunCommandPayload runs.
		payload: Joi.object().unknown(true).optional().default({}),
	}),
	"sync.remote_workflow.run_selection": Joi.object({
		step_keys: Joi.array().items(STEP_KEY).min(1).required(),
	}),
	"sync.remote_workflow.set_tcps": Joi.object({
		tcp_selections: Joi.array().items(TCP_SELECTION).required(),
	}),
	"sync.remote_workflow.set_resource_sets": Joi.object({
		resource_selections: Joi.array().items(RESOURCE_SELECTION).required(),
	}),
	"sync.resource.upsert": Joi.object({
		resource: Joi.object({
			id: STRING.required(),
			name: STRING.required(),
			data: Joi.object().unknown(true).default({}),
		}).required(),
	}),
	"sync.resource.import": Joi.object({
		contract_version: Joi.string().valid("sync/v2").optional(),
		domain: Joi.string().valid("templates", "tcp_tools", "resource_sets").optional(),
		resources: Joi.array()
			.items(
				Joi.object({
					id: STRING.required(),
					name: STRING.required(),
					data: Joi.object().unknown(true).default({}),
				}),
			)
			.min(1)
			.required(),
	}),
	"device_link.create": Joi.object({
		contract_version: Joi.string().valid("device-link/v1").required(),
		device_name: Joi.string().trim().min(1).max(200).required(),
		hub_version: OPTIONAL_STRING.optional(),
		public_key: DEVICE_PUBLIC_KEY.required(),
		requested_scopes: Joi.array().items(Joi.string().valid("ingest:write", "sync:write")).min(1).unique().required(),
	}),
	"device_link.rotate": Joi.object({
		public_key: DEVICE_PUBLIC_KEY.required(),
	}),

	"catalog.template.create": TEMPLATE_CREATE,
	"catalog.template.update": TEMPLATE_UPDATE,
	"catalog.templates.import": TEMPLATE_IMPORT,
	"catalog.tcp.create": TCP_CREATE,
	"catalog.tcp.update": TCP_UPDATE,
	"catalog.tcps.import": TCP_IMPORT,
	"catalog.resource_set.create": RESOURCE_SET_CREATE,
	"catalog.resource_set.update": RESOURCE_SET_UPDATE,
	"catalog.resource_sets.import": RESOURCE_SET_IMPORT,

	...COMMAND_PAYLOADS,
	...EVENT_PAYLOADS,
};

const OPTS = { abortEarly: false, stripUnknown: true, convert: true };

const MESSAGES = {
	"string.email": "Enter a valid email address",
	"string.min": "Must be at least {#limit} characters",
	"string.max": "Must be at most {#limit} characters",
	"string.hex": "Invalid token",
	"string.length": "Invalid token",
	"any.required": "Required",
	"any.only": "Invalid value",
};

function toFieldError(d) {
	return {
		field: d.path.join(".") || "_",
		code: d.type,
		message: d.message.replace(/^"[^"]+"\s/, ""),
	};
}

/** → { ok: true, value } | { ok: false, errors: [{ field, code, message }] } */
export function validate(name, input) {
	const schema = BLUEPRINTS[name];
	if (!schema) throw new Error(`unknown blueprint: ${name}`);
	const { value, error } = schema.validate(input ?? {}, { ...OPTS, messages: MESSAGES });
	if (!error) return { ok: true, value };
	return { ok: false, errors: error.details.map(toFieldError) };
}

/** Validate a server→client command payload by command type string. */
export function validateCommand(type, payload) {
	if (typeof type !== "string" || !type) {
		return {
			ok: false,
			errors: [{ field: "type", code: "any.required", message: "Required" }],
		};
	}
	const key = `command.${type}`;
	if (!BLUEPRINTS[key]) {
		return {
			ok: false,
			errors: [{ field: "type", code: "unknown_command_type", message: `Unknown command type: ${type}` }],
		};
	}
	return validate(key, payload);
}

/** Validate a client→server sync event payload by event type string. */
export function validateEvent(type, payload) {
	if (typeof type !== "string" || !type) {
		return {
			ok: false,
			errors: [{ field: "type", code: "any.required", message: "Required" }],
		};
	}
	const key = `event.${type}`;
	if (!BLUEPRINTS[key]) {
		return {
			ok: false,
			errors: [{ field: "type", code: "unknown_event_type", message: `Unknown event type: ${type}` }],
		};
	}
	return validate(key, payload ?? {});
}

/** Validate sync event batch envelope and each event payload. */
export function validateSyncEventBatch(body) {
	const batch = validate("sync.events", body);
	if (!batch.ok) return batch;
	const errors = [];
	for (let i = 0; i < batch.value.events.length; i++) {
		const event = batch.value.events[i];
		const pv = validateEvent(event.type, event.payload);
		if (!pv.ok) {
			for (const e of pv.errors) {
				const prefix = e.field === "type" ? `events.${i}.type` : `events.${i}.payload.${e.field}`;
				errors.push({ ...e, field: prefix });
			}
		}
	}
	if (errors.length) return { ok: false, errors };
	return batch;
}
