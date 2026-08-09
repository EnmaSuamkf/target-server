import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * `server.mjs` serves this app as plain static files: the build lands in
 * `../public/dist/` and the server streams `dist/index.html` at `/` plus
 * everything under `dist/assets/`. Nothing is rendered server-side, so the
 * output has to be self-contained and reference its assets by a root-relative
 * path — hence `base: "/"` and the default `assets/` layout.
 *
 * `server.proxy` only matters for `npm run dev` (Vite's own port): API calls
 * are forwarded to the running report server so the dev server behaves like
 * production, with hot reload on top. Point it at another server with
 * `VITE_SERVER_ORIGIN=... npm run dev` (or a .env file next to this one).
 */
export default defineConfig(({ mode }) => {
	const serverOrigin = loadEnv(mode, ".", "VITE_").VITE_SERVER_ORIGIN ?? "http://127.0.0.1:8900";
	return {
		plugins: [react()],
		base: "/",
		build: {
			// Outside this package's root, so `emptyOutDir` has to be explicit.
			outDir: "../public/dist",
			emptyOutDir: true,
			// A local operator tool — sourcemaps cost nothing here and make a
			// production stack trace readable.
			sourcemap: true,
		},
		server: {
			port: 5174,
			proxy: {
				"/api": { target: serverOrigin, changeOrigin: true },
				"/health": { target: serverOrigin, changeOrigin: true },
				"/ingest": { target: serverOrigin, changeOrigin: true },
			},
		},
	};
});
