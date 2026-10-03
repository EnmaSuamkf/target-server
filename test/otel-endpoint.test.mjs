import assert from "node:assert/strict";
import http from "node:http";
import test, { after } from "node:test";
import { ENDPOINT_ERRORS, isPrivateAddress, noRedirectFetch, validateOtelEndpoint } from "../otel-endpoint.mjs";
import { sendOtlp } from "../otel-client.mjs";

const lookupTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
const check = (url, opts = {}) => validateOtelEndpoint(url, { lookup: lookupTo("93.184.216.34"), allowPrivate: false, ...opts });

test("a public https endpoint is accepted", async () => {
	const r = await check("https://otlp.example.com/v1/traces");
	assert.deepEqual(r, { ok: true, url: "https://otlp.example.com/v1/traces" });
	assert.equal((await check("https://93.184.216.34:4318")).ok, true);
	assert.equal((await check("https://[2606:4700:4700::1111]/")).ok, true);
});

test("http is refused without the allow flag, with a stable code", async () => {
	const r = await check("http://otlp.example.com");
	assert.equal(r.ok, false);
	assert.equal(r.code, ENDPOINT_ERRORS.scheme);
	assert.equal((await check("ftp://otlp.example.com")).code, ENDPOINT_ERRORS.invalid);
	assert.equal((await check("not a url")).code, ENDPOINT_ERRORS.invalid);
	assert.equal((await check("")).code, ENDPOINT_ERRORS.invalid);
});

test("credentials in the URL are refused", async () => {
	assert.equal((await check("https://user:pw@otlp.example.com")).code, ENDPOINT_ERRORS.credentials);
});

test("localhost, loopback, private, link-local and metadata literals are rejected", async () => {
	const urls = [
		"https://localhost",
		"https://LOCALHOST.:4318",
		"https://foo.localhost",
		"https://127.0.0.1",
		"https://127.1",
		"https://2130706433",
		"https://0x7f.0.0.1",
		"https://0.0.0.0",
		"https://10.0.0.5",
		"https://172.16.0.1",
		"https://172.31.255.255",
		"https://192.168.1.1",
		"https://169.254.169.254/latest/meta-data",
		"https://100.100.100.200",
		"https://100.64.0.1",
		"https://[::1]",
		"https://[::]",
		"https://[fe80::1]",
		"https://[fd00:ec2::254]",
		"https://[fc00::1]",
		"https://[::ffff:127.0.0.1]",
		"https://[::ffff:7f00:1]",
		"https://[::ffff:169.254.169.254]",
		"https://[64:ff9b::a00:1]",
		"https://[2002:a00:1::]",
		"https://metadata.google.internal",
		"https://printer.local",
	];
	for (const url of urls) {
		const r = await check(url);
		assert.equal(r.ok, false, url);
		assert.equal(r.code, ENDPOINT_ERRORS.private, url);
	}
});

test("addresses just outside the private ranges are accepted", async () => {
	for (const ip of ["172.15.255.255", "172.32.0.1", "11.0.0.1", "100.63.255.255", "169.253.1.1", "8.8.8.8"]) {
		assert.equal(isPrivateAddress(ip), false, ip);
	}
	assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
	assert.equal(isPrivateAddress("::ffff:8.8.8.8"), false);
});

test("a hostname is rejected when ANY resolved address is private", async () => {
	assert.equal((await check("https://rebind.example.com", { lookup: lookupTo("127.0.0.1") })).code, ENDPOINT_ERRORS.private);
	assert.equal((await check("https://rebind.example.com", { lookup: lookupTo("93.184.216.34", "10.0.0.1") })).code, ENDPOINT_ERRORS.private);
	assert.equal((await check("https://rebind.example.com", { lookup: lookupTo("93.184.216.34", "::1") })).code, ENDPOINT_ERRORS.private);
	assert.equal((await check("https://meta.example.com", { lookup: lookupTo("169.254.169.254") })).code, ENDPOINT_ERRORS.private);
});

test("an unresolvable hostname is reported as such", async () => {
	const lookup = async () => {
		throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
	};
	assert.equal((await check("https://nx.example.com", { lookup })).code, ENDPOINT_ERRORS.unresolvable);
	assert.equal((await check("https://nx.example.com", { lookup: async () => [] })).code, ENDPOINT_ERRORS.unresolvable);
});

test("TARGET_OTEL_ALLOW_PRIVATE=1 allows http and private targets", async () => {
	const prev = process.env.TARGET_OTEL_ALLOW_PRIVATE;
	process.env.TARGET_OTEL_ALLOW_PRIVATE = "1";
	try {
		for (const url of ["http://127.0.0.1:4318", "https://localhost", "http://169.254.169.254", "http://10.0.0.5"]) {
			const r = await validateOtelEndpoint(url, { lookup: lookupTo("127.0.0.1") });
			assert.equal(r.ok, true, url);
		}
		// Still must be a well-formed http(s) URL without credentials.
		assert.equal((await validateOtelEndpoint("ftp://x")).ok, false);
		assert.equal((await validateOtelEndpoint("http://u:p@127.0.0.1")).code, ENDPOINT_ERRORS.credentials);
	} finally {
		if (prev === undefined) delete process.env.TARGET_OTEL_ALLOW_PRIVATE;
		else process.env.TARGET_OTEL_ALLOW_PRIVATE = prev;
	}
});

test("the allow flag defaults to off (only \"1\" enables it)", async () => {
	const prev = process.env.TARGET_OTEL_ALLOW_PRIVATE;
	try {
		for (const v of [undefined, "", "0", "true"]) {
			if (v === undefined) delete process.env.TARGET_OTEL_ALLOW_PRIVATE;
			else process.env.TARGET_OTEL_ALLOW_PRIVATE = v;
			assert.equal((await validateOtelEndpoint("http://127.0.0.1")).ok, false);
		}
	} finally {
		if (prev === undefined) delete process.env.TARGET_OTEL_ALLOW_PRIVATE;
		else process.env.TARGET_OTEL_ALLOW_PRIVATE = prev;
	}
});

test("noRedirectFetch does not follow redirects", async () => {
	let targetHits = 0;
	const target = http.createServer((req, res) => {
		targetHits++;
		res.end("secret");
	});
	await new Promise((r) => target.listen(0, "127.0.0.1", r));
	const redirector = http.createServer((req, res) => {
		res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/` });
		res.end();
	});
	await new Promise((r) => redirector.listen(0, "127.0.0.1", r));
	after(() => {
		target.close();
		redirector.close();
	});
	const endpoint = `http://127.0.0.1:${redirector.address().port}`;
	const res = await noRedirectFetch(`${endpoint}/x`, { method: "POST", body: "{}" });
	assert.equal(res.status, 302);
	const sent = await sendOtlp({ endpoint, signal: "traces", body: {}, fetchImpl: noRedirectFetch, maxAttempts: 1 });
	assert.equal(sent.ok, false);
	assert.equal(sent.status, 302);
	assert.equal(targetHits, 0);
});
