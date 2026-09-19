# Invite activation methods (design)

Operators invite dashboard users from **Users**. Today every invite email only describes the **password setup link** (`/setup?token=…`). This document specifies how an admin chooses **password**, **Google**, or **both** per invite, how that choice is stored, and how invitation email and UI behave.

**Scope:** design only — implementation follows in later workflow steps. **No secrets** in this file.

## Product rules (unchanged)

- Invite-only: the invited **email must exist** in `auth_users` before sign-in (password or Google).
- Google OAuth remains optional (`TARGET_GOOGLE_CLIENT_ID` + `TARGET_GOOGLE_CLIENT_SECRET`).
- Pending users activate via **password setup** and/or **Sign in with Google** according to the methods allowed for that invite.
- Admin invite/resend still does not expose passwords in email.

## Activation methods

| Method | Meaning for the invitee |
| --- | --- |
| **password** | Use the one-time **setup link** to choose a password, then sign in with email + password. |
| **google** | Open the server **login page** and use **Continue with Google** with the same email (no setup link required). |
| **both** | Either path above; email includes both instructions and URLs. |

At least **one** method must be enabled per invite.

### Defaults (UI)

When the admin opens the invite form:

- If `GET /api/auth/providers` → `{ "google": true }`: default **both** `password` and `google` checked.
- If Google is not configured: default **password** only; Google checkbox hidden or disabled.

Admin can uncheck one option when both are available (e.g. Google-only for a team that uses SSO-style login).

## Database

Add two nullable booleans on `auth_users` (migration in `db.mjs`):

| Column | Type | Default for new invites |
| --- | --- | --- |
| `invite_allow_password` | INTEGER 0/1 | `1` when password method selected at create |
| `invite_allow_google` | INTEGER 0/1 | `1` when google method selected at create |

**Invariants:**

- At create time: `(invite_allow_password OR invite_allow_google) = 1`.
- Values are **immutable for resend** unless a future “change activation methods” feature is added; **resend** and **copy link** use the stored flags (no re-prompt on resend).
- Existing rows before migration: treat as `invite_allow_password = 1`, `invite_allow_google = 0` (matches current behavior).

Expose in API responses via `publicUser` / list users (camelCase):

- `inviteAllowPassword: boolean`
- `inviteAllowGoogle: boolean`

Optional derived label for UI: `activationMethods: "password" | "google" | "both"` (computed, not stored).

## API

### `POST /api/auth/users`

**Request body** (extend `user.create` in `blueprint.mjs`):

```json
{
  "email": "colleague@example.com",
  "activation": {
    "password": true,
    "google": false
  }
}
```

- `activation` optional; if omitted, server applies the same defaults as the UI (both when Google configured, else password only).
- Validation:
  - At least one of `activation.password` or `activation.google` must be `true`.
  - If `activation.google === true` and Google OAuth is **not** configured → **422** with field error on `activation.google` (code e.g. `google_oauth_disabled`). No silent fallback to password-only (admin must fix selection or configure OAuth).

**Response** (201) — extend `invite` object:

```json
{
  "user": { "id": "…", "email": "…", "status": "pending", "inviteAllowPassword": true, "inviteAllowGoogle": false },
  "invite": {
    "expiresAt": "2026-…",
    "setupUrl": "https://…/setup?token=…",
    "loginUrl": "https://…/login"
  },
  "mail": { "sent": true, "transport": "resend" }
}
```

- `setupUrl` present only when `invite_allow_password` is true (new token issued).
- `loginUrl` always the public origin + `/login` when `invite_allow_google` is true (no token).
- Backward compatibility: clients may still read `invite.url` as alias for `setupUrl` when password is allowed (implementation choice; document both in README when implemented).

### `POST /api/auth/users/:id/invite` (resend)

- No body change; reads `invite_allow_*` from the user row.
- Same `invite` response shape as create.
- If user already active → **409** `already_activated` (unchanged).

### Google callback (unchanged logic, clarified)

- Invited pending user with **google allowed**: existing callback activates via `activateAuthUserWithGoogle`.
- Invited pending with **password only**: Google sign-in for that email still works only if product later allows; for this feature, **google-only path** means no setup token; **password-only** means Google callback may still hit `not_invited` or `oauth_failed` if we enforce method — **recommended:** if `invite_allow_google` is false, callback returns redirect `auth_error=oauth_failed` or a new code `activation_method_not_allowed` (prefer one clear code in implementation step).

## `issueInvite` / mail

Refactor `issueInvite(user)` in `server.mjs`:

1. Load `invite_allow_password`, `invite_allow_google` from `user`.
2. **Setup token:** create `auth_resets` row + raw token **only if** `invite_allow_password`.
3. Call `inviteMail({ publicUrl, email, allowPassword, allowGoogle, setupUrl?, loginUrl })`.
4. Send mail via existing `sendMail`.

### Mail variants (`mail-templates.mjs`)

Shared header in all variants:

- Server origin, invited email, short “you were invited” line.

| allowPassword | allowGoogle | Email content |
| --- | --- | --- |
| true | false | Password section only: setup link, 7-day single-use (current copy). |
| false | true | Google section only: login URL, “Continue with Google”, same email; note GCP test user if app in Testing. |
| true | true | Both sections, clearly separated (headings or bullets), distinct URLs. |

- **Google-only:** do **not** include `/setup?token=…` in text or HTML.
- **Password-only:** do **not** instruct Google sign-in (optional one line: “Password login only for this account” — keep minimal).
- Subject line: keep generic or slightly vary (“… — set password” vs “… — sign in with Google”); implementation may use one subject for simplicity.

Plain-text and minimal HTML (same style as today). Use placeholders for setup link like today (`/setup?token=…` + `withToken` only when token exists).

## Dashboard UI (`UsersPanel`)

**Invite form:**

- Email input (unchanged).
- Two checkboxes:
  - **Password setup link**
  - **Sign in with Google** (disabled + helper text when `providers.google === false`).
- Defaults per above; submit sends `activation: { password, google }`.

**After invite / resend:**

- **Copy link:** copy `setupUrl` only if password allowed; show separate “Login page” copy or static text with `loginUrl` when Google allowed.
- **Resend:** unchanged button; server uses stored flags.
- **Table:** optional badge or subtitle on pending rows: “Password · Google” / “Google only” / “Password only” from `inviteAllow*`.

Panel note: explain that Google requires OAuth env vars and invite-only Google match (existing Google doc link).

## Edge cases

| Case | Behavior |
| --- | --- |
| Google not configured, request `google: true` | **422** on create |
| Google-only invite, OAuth later disabled | Pending user can only activate if OAuth re-enabled; resend email still shows login URL |
| Password-only, user tries Google | Redirect login with `activation_method_not_allowed` (or document `oauth_failed`) |
| Both allowed | Either activation path; first successful activation wins (existing) |
| Resend invalidates old setup token | Unchanged: new token only when password allowed |
| Mail transport file/noop | Unchanged; admin uses copy link for setup and/or login URL |

## Testing (implementation step)

- `test/users.test.mjs`: three mail bodies (password / google / both); google-only response has no `setupUrl`; create with `google: true` when OAuth env unset → 422.
- Resend preserves methods without new activation payload.

## Related docs

- [Google OAuth console checklist](./google-oauth-console-checklist.md)
- README **Authentication** and local Google + mail sections (update when implemented)
