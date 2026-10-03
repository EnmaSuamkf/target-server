#!/usr/bin/env node
// POST an OTLP/JSON file to a URL and print the HTTP status and body.
// No dependencies: uses the built-in fetch (Node >= 24).

const USAGE = `Usage: node send.mjs <url> <file.json> [--now]

POSTs <file.json> to <url> with Content-Type: application/json and prints the
HTTP status and the response body. Exits 0 on a 2xx status, 1 otherwise.

Options:
  --now        Rewrite every *UnixNano timestamp to the current time,
               preserving the offsets inside the file (backends reject old data)
  --help, -h   Show this help

Environment:
  OTLP_HEADERS Extra request headers, comma separated "Name=value" pairs,
               e.g. "Authorization=Basic abc,x-langfuse-ingestion-version=4".
               Values are never printed.

Example:
  node send.mjs http://localhost:4318/v1/traces payloads/trace.json --now
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
	process.stdout.write(USAGE);
	process.exit(0);
}
const rewriteNow = args.includes('--now');
const [url, file] = args.filter((a) => !a.startsWith('--'));
if (!url || !file) {
	process.stderr.write(USAGE);
	process.exit(2);
}

import { readFileSync } from 'node:fs';

const headers = { 'Content-Type': 'application/json' };
for (const pair of (process.env.OTLP_HEADERS ?? '').split(',')) {
	const i = pair.indexOf('=');
	if (i > 0) headers[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
}

let body = readFileSync(file, 'utf8');
JSON.parse(body); // fail early on invalid JSON

if (rewriteNow) {
	const doc = JSON.parse(body);
	const times = [];
	const walk = (node) => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (node && typeof node === 'object') {
			for (const [k, v] of Object.entries(node)) {
				if (/UnixNano$/.test(k) && typeof v === 'string') times.push(BigInt(v));
				else walk(v);
			}
		}
	};
	walk(doc);
	if (times.length) {
		const max = times.reduce((a, b) => (a > b ? a : b));
		const shift = BigInt(Date.now()) * 1000000n - max;
		const apply = (node) => {
			if (Array.isArray(node)) return node.forEach(apply);
			if (node && typeof node === 'object') {
				for (const [k, v] of Object.entries(node)) {
					if (/UnixNano$/.test(k) && typeof v === 'string') node[k] = String(BigInt(v) + shift);
					else apply(v);
				}
			}
		};
		apply(doc);
	}
	body = JSON.stringify(doc);
}

try {
	const res = await fetch(url, { method: 'POST', headers, body });
	const text = await res.text();
	console.log(`HTTP ${res.status} ${res.statusText}`);
	const retryAfter = res.headers.get('retry-after');
	if (retryAfter) console.log(`Retry-After: ${retryAfter}`);
	console.log(text);
	process.exit(res.ok ? 0 : 1);
} catch (err) {
	console.error(`Request failed: ${err.message}`);
	process.exit(1);
}
