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

export const BLUEPRINTS = {
	"user.create": Joi.object({ email: EMAIL }),
	"auth.login": Joi.object({ email: EMAIL, password: Joi.string().required() }),
	"auth.forgot": Joi.object({ email: EMAIL }),
	"auth.setup": Joi.object({ token: TOKEN, password: PASSWORD }),
	"auth.reset": Joi.object({ token: TOKEN, password: PASSWORD }),
};

const OPTS = { abortEarly: false, stripUnknown: true, convert: true };

const MESSAGES = {
	"string.email": "Enter a valid email address",
	"string.min": "Password must be at least {#limit} characters",
	"string.max": "Must be at most {#limit} characters",
	"string.hex": "Invalid token",
	"string.length": "Invalid token",
	"any.required": "Required",
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
