# Provision a customer tenant (subdomain)

Each customer gets an **isolated** `target-server` Web Service on Render, a **fresh SQLite disk**, and a subdomain of `targetworkflows.com`.

Example: eDreams → `https://edreams.targetworkflows.com`

## Naming

| Item | Convention |
| --- | --- |
| Render service | `target-server-<slug>` (e.g. `target-server-edreams`) |
| Public URL | `https://<slug>.targetworkflows.com` |
| Disk mount | `/var/data` (1 GB) |
| DB path | `/var/data/target-server.db` |

## 1. Render — new Web Service

1. Dashboard → **New** → **Web Service**.
2. Connect repo `EnmaSuamkf/target-server` (prefer **Git Provider** with auto-deploy; public URL works but needs manual deploys).
3. Settings:
   - **Name:** `target-server-<slug>`
   - **Region:** Oregon (same as production)
   - **Language:** Node
   - **Branch:** `main`
   - **Build:** `npm ci && npm --prefix ui ci && npm run build`
   - **Start:** `node server.mjs`
   - **Plan:** Starter (`0.5c-512mb`) or higher
4. **Advanced:**
   - Health check path: `/health`
   - Disk: name `target-server-<slug>-data`, mount `/var/data`, size **1 GB**
5. Environment variables:

| Key | Value |
| --- | --- |
| `NODE_VERSION` | `24` |
| `HOST` | `0.0.0.0` |
| `TARGET_PUBLIC_URL` | `https://<slug>.targetworkflows.com` |
| `TARGET_MAIL_FROM` | `Target <noreply@targetworkflows.com>` |
| `TARGET_MAIL_TRANSPORT` | `resend` |
| `TARGET_ALLOW_FILE_MAIL` | `1` (boot safety; keep Resend configured) |
| `TARGET_SERVER_DB` | `/var/data/target-server.db` |
| `TARGET_USE_PUBLISHED_ADMIN` | `1` |
| `TARGET_SEED_ADMIN_PASSWORD` | unique strong password (store in password manager) |
| `TARGET_AUTH_SECRET` | random 32+ bytes hex |
| `TARGET_INGEST_TOKEN` | random token |
| `TARGET_DEVICE_LINKING_MODE` | `optional` |
| `TARGET_SMTP_URL` | same Resend SMTP URL as production (`smtps://resend:re_…@smtp.resend.com:465`) |
| `TARGET_GOOGLE_CLIENT_ID` | shared OAuth client (or a per-tenant client) |
| `TARGET_GOOGLE_CLIENT_SECRET` | matching secret |

6. **Deploy web service** and wait until **Live**.

## 2. DNS — IONOS

Add a **CNAME** on `targetworkflows.com`:

| Type | Host | Value | TTL |
| --- | --- | --- | --- |
| CNAME | `<slug>` | `<service-name>.onrender.com` | 1 minute initially |

Example: `edreams` → `target-server-edreams.onrender.com`

Do **not** add an AAAA for the subdomain.

## 3. Render — custom domain

1. Service → **Settings** → **Custom Domains** → **Add Custom Domain**.
2. Enter `<slug>.targetworkflows.com`.
3. Click **Verify** after DNS propagates (often a few minutes).
4. Confirm `https://<slug>.targetworkflows.com/health` returns `{"ok":true}`.

## 4. Google OAuth

In the shared OAuth client (`target-server web`), add:

- **Authorized JavaScript origin:** `https://<slug>.targetworkflows.com`
- **Authorized redirect URI:** `https://<slug>.targetworkflows.com/api/auth/google/callback`

Save. While the consent screen is in **Testing**, add customer Google accounts as test users.

## 5. Smoke test

1. Open `https://<slug>.targetworkflows.com/login`.
2. Sign in as `admin@admin.com` with the seeded password; change it immediately.
3. **Users** → invite a customer admin; confirm Resend shows **Delivered** from `noreply@targetworkflows.com`.
4. Optional: hub → Connect with my server → that tenant URL.

## Notes

- Tenants do **not** share SQLite data; each disk is isolated.
- Mail sending reuses the verified Resend domain `targetworkflows.com`.
- Prefer linking the GitHub repo via **Git Provider** so each tenant auto-deploys from `main`.
- Blueprint `render.yaml` drives the **primary** service (`targetworkflows.com`) only. Customer tenants are separate Web Services so a Blueprint sync cannot overwrite their URLs/secrets.
