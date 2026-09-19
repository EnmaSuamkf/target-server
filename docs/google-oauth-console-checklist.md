# Google OAuth — Cloud Console checklist (target-server)

Operational record for invite-only Google sign-in. **Do not put `TARGET_GOOGLE_CLIENT_SECRET` (or any OAuth JSON download) in this repo.**

## Google Cloud project

| Field | Value |
| --- | --- |
| **Project name** | `target-server` |
| **Project ID** | `target-server-508916` |
| **Console** | [Google Cloud Console — target-server](https://console.cloud.google.com/?project=target-server-508916) |

## OAuth consent screen

| Field | Value |
| --- | --- |
| **User type** | External |
| **Publishing status** | **Testing** (not Production) |
| **App name** | `target-server` |
| **Scopes** | `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` |
| **Test users added** | `pabloacastaneda86@gmail.com` — add every invited Google account under **Google Auth Platform → Público → Usuarios de prueba** while status is Testing |

## OAuth 2.0 client (Web application)

| Field | Value |
| --- | --- |
| **Client name** | `target-server web` |
| **Client ID** (`TARGET_GOOGLE_CLIENT_ID`) | `892961992399-2c5bql24kkod3m4ofbje51v5d3u7rq62.apps.googleusercontent.com` |

### Authorized JavaScript origins

- `https://target-server-okjn.onrender.com`
- `http://127.0.0.1:8900`

### Authorized redirect URIs

- `https://target-server-okjn.onrender.com/api/auth/google/callback`
- `http://127.0.0.1:8900/api/auth/google/callback`

## Render environment variables

Set on the **target-server** web service (production URL `https://target-server-okjn.onrender.com`):

| Key | Value |
| --- | --- |
| `TARGET_GOOGLE_CLIENT_ID` | Same as **Client ID** above (or copy from [Google Auth Platform → Clientes](https://console.cloud.google.com/auth/clients?project=target-server-508916)) |
| `TARGET_GOOGLE_CLIENT_SECRET` | `<from OAuth client JSON or Console — never commit>` |

**Where to set:** [Render Dashboard](https://dashboard.render.com) → open service **target-server** → **Environment** tab → add/update variables → save ( redeploy if prompted ).

Local dev: export the same two variables in your shell or `.env` (gitignored); use the local redirect URI and origin above with the app on port **8900**.

## Post-setup reminders

- [ ] Every user who must sign in while the app is in **Testing** is listed as a **test user** in GCP.
- [ ] Render has both `TARGET_GOOGLE_CLIENT_ID` and `TARGET_GOOGLE_CLIENT_SECRET` set; secret exists only in Render / local env, not in git.
- [ ] OAuth JSON download kept offline (e.g. `~/Descargas/client_secret_*.json`), not in the repository.

## Post-deploy verification — local

1. Export `TARGET_GOOGLE_CLIENT_ID`, `TARGET_GOOGLE_CLIENT_SECRET`, and `TARGET_PUBLIC_URL=http://127.0.0.1:8900` (see README).
2. `npm run build && npm start` on port **8900**.
3. `curl -s http://127.0.0.1:8900/api/auth/providers` → expect `"google":true` when vars are set; `"google":false` when unset.
4. Admin → **Users** → invite the Google email you will test with.
5. **Sign in with Google** on `/login` → land in the dashboard.
6. Sign out; attempt Google with a **non-invited** account → login shows not-invited message (`auth_error=not_invited`).

## Post-deploy verification — Render

1. After deploy, open `https://target-server-okjn.onrender.com/api/auth/providers` — `"google":true` only if both env vars are set on the service.
2. **Environment** tab: confirm `TARGET_GOOGLE_CLIENT_ID` and `TARGET_GOOGLE_CLIENT_SECRET` exist (values not copied into git or chat).
3. Invite a test user from **Users** (production dashboard).
4. `/login` → **Sign in with Google** with that invited account → dashboard loads.
5. Optional: uninvited Google account → `not_invited` error on login.
6. If OAuth fails with `oauth_failed`, re-check redirect URIs and that the Render deploy finished after env changes.
