import assert from "node:assert/strict";
import test from "node:test";
import { publicUrl } from "../db.mjs";

test("publicUrl prefers RENDER_EXTERNAL_URL over stale onrender TARGET_PUBLIC_URL", () => {
	const prev = { ...process.env };
	try {
		process.env.TARGET_PUBLIC_URL = "https://target-server.onrender.com";
		process.env.RENDER_EXTERNAL_URL = "https://target-server-okjn.onrender.com";
		assert.equal(publicUrl(), "https://target-server-okjn.onrender.com");
	} finally {
		process.env = prev;
	}
});

test("publicUrl keeps custom non-onrender TARGET_PUBLIC_URL", () => {
	const prev = { ...process.env };
	try {
		process.env.TARGET_PUBLIC_URL = "https://app.example.com";
		process.env.RENDER_EXTERNAL_URL = "https://target-server-okjn.onrender.com";
		assert.equal(publicUrl(), "https://app.example.com");
	} finally {
		process.env = prev;
	}
});

test("publicUrl falls back to host:port locally", () => {
	const prev = { ...process.env };
	try {
		delete process.env.TARGET_PUBLIC_URL;
		delete process.env.RENDER_EXTERNAL_URL;
		assert.equal(publicUrl({ host: "127.0.0.1", port: "8900" }), "http://127.0.0.1:8900");
	} finally {
		process.env = prev;
	}
});
