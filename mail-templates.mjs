/**
 * Plain-text + minimal HTML mail bodies for invitation and recovery.
 */

const SETUP_PLACEHOLDER = "/setup?token=…";

function inviteHeader(origin, email) {
	return {
		text: `You have been given an account on the Target report server.

  Server:  ${origin}/
  Email:   ${email}
`,
		html: `<p>You have been given an account on the Target report server.</p>
<ul><li><strong>Server:</strong> ${origin}/</li><li><strong>Email:</strong> ${email}</li></ul>`,
	};
}

function passwordSection(setupLink) {
	return {
		text: `
Choose your password to finish setting up the account
(link valid 7 days, single use):

  ${setupLink}

If the link has expired, ask whoever invited you to send a new one.`,
		html: `<p>Choose your password to finish setting up the account (link valid 7 days, single use):</p>
<p><a href="${setupLink}">${setupLink}</a></p>
<p>If the link has expired, ask whoever invited you to send a new one.</p>`,
	};
}

function googleSection(loginLink, email) {
	return {
		text: `
Sign in with Google on the login page using this email address:

  ${loginLink}

Open the page and choose <Continue with Google>. If the Google app is still in Testing mode, the account must be listed as a test user in Google Cloud Console.`,
		html: `<p><strong>Sign in with Google</strong> on the login page using <strong>${email}</strong>:</p>
<p><a href="${loginLink}">${loginLink}</a></p>
<p>Choose <em>Continue with Google</em>. If the Google app is still in Testing mode, the account must be listed as a test user in Google Cloud Console.</p>`,
	};
}

export function inviteMail({ publicUrl, email, allowPassword, allowGoogle, setupUrl, loginUrl }) {
	const origin = publicUrl.replace(/\/$/, "");
	const subject = "Your Target report server account";
	const header = inviteHeader(origin, email);

	const setupLink = setupUrl ?? `${origin}${SETUP_PLACEHOLDER}`;
	const loginLink = loginUrl ?? `${origin}/login`;

	const textParts = [header.text.trimEnd()];
	const htmlParts = [header.html];

	if (allowPassword) {
		const pw = passwordSection(setupLink);
		textParts.push(pw.text.trim());
		htmlParts.push(pw.html);
	}
	if (allowGoogle) {
		const g = googleSection(loginLink, email);
		textParts.push(g.text.trim());
		htmlParts.push(g.html);
	}

	const footerText =
		"If you were not expecting this, ignore this email — the account cannot be used until activation completes.";
	const footerHtml = "<p>If you were not expecting this, ignore this email.</p>";

	const text = `${textParts.join("\n\n")}\n\n${footerText}`;
	const html = `<!doctype html><meta charset=utf-8>
${htmlParts.join("\n")}
${footerHtml}`;

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
	const setupPlaceholder = SETUP_PLACEHOLDER;
	const resetPlaceholder = "/reset?token=…";
	const setupLink = `/setup?token=${token}`;
	const resetLink = `/reset?token=${token}`;
	return {
		subject: body.subject,
		text: body.text.replaceAll(setupPlaceholder, setupLink).replaceAll(resetPlaceholder, resetLink),
		html: body.html.replaceAll(setupPlaceholder, setupLink).replaceAll(resetPlaceholder, resetLink),
	};
}
