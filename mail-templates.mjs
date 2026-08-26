/**
 * Plain-text + minimal HTML mail bodies for invitation and recovery.
 */

export function inviteMail({ publicUrl, email }) {
	const origin = publicUrl.replace(/\/$/, "");
	const subject = "Your Target report server account";
	const link = `${origin}/setup?token=…`;
	const text = `You have been given an account on the Target report server.

  Server:  ${origin}/
  Email:   ${email}

Choose your password to finish setting up the account
(link valid 7 days, single use):

  ${link}

If the link has expired, ask whoever invited you to send a new one.
If you were not expecting this, ignore this email — the account
cannot be used until someone opens the link.`;
	const html = `<!doctype html><meta charset=utf-8>
<p>You have been given an account on the Target report server.</p>
<ul><li><strong>Server:</strong> ${origin}/</li><li><strong>Email:</strong> ${email}</li></ul>
<p>Choose your password to finish setting up the account (link valid 7 days, single use):</p>
<p><a href="${link}">${link}</a></p>
<p>If the link has expired, ask whoever invited you to send a new one.</p>`;
	return { subject, text, html };
}

export function resetMail({ publicUrl, email }) {
	const origin = publicUrl.replace(/\/$/, "");
	const subject = "Reset your Target report server password";
	const link = `${origin}/reset?token=…`;
	const text = `A password reset was requested for ${email} on the Target report server.

  Server:  ${origin}/

Set a new password (link valid 1 hour, single use):

  ${link}

If you did not request this, ignore this email — your password stays unchanged.`;
	const html = `<!doctype html><meta charset=utf-8>
<p>A password reset was requested for <strong>${email}</strong> on the Target report server.</p>
<p>Set a new password (link valid 1 hour, single use):</p>
<p><a href="${link}">${link}</a></p>
<p>If you did not request this, ignore this email.</p>`;
	return { subject, text, html };
}

/** Inject the real token into template placeholders after building the body. */
export function withToken(body, token) {
	const setupPlaceholder = "/setup?token=…";
	const resetPlaceholder = "/reset?token=…";
	const setupLink = `/setup?token=${token}`;
	const resetLink = `/reset?token=${token}`;
	return {
		subject: body.subject,
		text: body.text.replaceAll(setupPlaceholder, setupLink).replaceAll(resetPlaceholder, resetLink),
		html: body.html.replaceAll(setupPlaceholder, setupLink).replaceAll(resetPlaceholder, resetLink),
	};
}
