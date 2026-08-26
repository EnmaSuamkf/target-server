/**
 * Mail transport — nodemailer for SMTP, Resend HTTP API (Render free tier),
 * file outbox for dev/CI, noop for tests.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";

const FROM = process.env.TARGET_MAIL_FROM ?? "target-server@localhost";
const SMTP_URL = process.env.TARGET_SMTP_URL ?? "";
const RESEND_API_KEY = process.env.TARGET_RESEND_API_KEY ?? "";
const FORCED = process.env.TARGET_MAIL_TRANSPORT ?? "";
const OUTBOX = join(process.cwd(), ".mail-outbox");

let transport = null;
let transportName = "file";
let resendApiKey = "";

function resendKeyFromSmtpUrl(url) {
	try {
		const u = new URL(url);
		if (u.hostname.includes("resend.com") && u.username === "resend" && u.password) return u.password;
	} catch {
		// ignore malformed URLs
	}
	return "";
}

function pickTransport() {
	if (FORCED === "noop") return { name: "noop", t: null };
	if (FORCED === "file") return { name: "file", t: null };
	const resendKey = RESEND_API_KEY || resendKeyFromSmtpUrl(SMTP_URL);
	if (FORCED === "resend" || resendKey) {
		if (!resendKey) {
			throw new Error("TARGET_RESEND_API_KEY is required when TARGET_MAIL_TRANSPORT=resend");
		}
		resendApiKey = resendKey;
		return { name: "resend", t: null };
	}
	if (FORCED === "smtp" || SMTP_URL) {
		if (!SMTP_URL) {
			throw new Error(
				"TARGET_SMTP_URL is required when TARGET_MAIL_TRANSPORT=smtp (e.g. smtps://resend:re_KEY@smtp.resend.com:465)",
			);
		}
		const t = nodemailer.createTransport(SMTP_URL);
		return { name: "smtp", t };
	}
	return { name: "file", t: null };
}

async function sendViaResend({ to, subject, text, html }) {
	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${resendApiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from: FROM,
			to: [to],
			subject,
			text,
			...(html ? { html } : {}),
		}),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(body?.message ?? `Resend API ${res.status}`);
	}
	return body;
}

export async function initMailer() {
	const picked = pickTransport();
	transportName = picked.name;
	transport = picked.t;
	if (transport) await transport.verify();
	if (transportName === "file") mkdirSync(OUTBOX, { recursive: true });
	return { transport: transportName };
}

export function mailTransportName() {
	return transportName;
}

export async function sendMail({ to, subject, text, html }) {
	if (transportName === "noop") {
		console.log(`[target-server] mail (noop): to=${to} subject=${subject}`);
		return { sent: true, transport: "noop" };
	}
	if (transportName === "file") {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const path = join(OUTBOX, `${stamp}.eml`);
		const eml = [`From: ${FROM}`, `To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset=utf-8', "", text].join("\r\n");
		writeFileSync(path, eml, "utf8");
		console.log(`[target-server] mail (file): wrote ${path}`);
		return { sent: true, transport: "file", path };
	}
	if (transportName === "resend") {
		await sendViaResend({ to, subject, text, html });
		return { sent: true, transport: "resend" };
	}
	await transport.sendMail({ from: FROM, to, subject, text, html });
	return { sent: true, transport: "smtp" };
}

export function outboxDir() {
	return OUTBOX;
}

export function isDeliveringTransport() {
	return transportName === "smtp" || transportName === "resend";
}
