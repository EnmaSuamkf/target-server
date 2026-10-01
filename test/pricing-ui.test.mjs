/**
 * Source-reading checks for the cost UI: the Settings tab and each panel
 * control sit behind their own permission, and cost shows up where promised.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("the Settings tab is gated on pricing.read", () => {
	const app = read("../ui/src/App.tsx");
	assert.match(app, /const canSettings = can\("pricing\.read"\)/);
	assert.match(app, /\.\.\.\(canSettings \? \["settings" as const\] : \[\]\)/);
	assert.match(app, /\{canSettings \? <button[\s\S]*?Settings\s*<\/button> : null\}/);
	assert.match(app, /tab === "settings"/);
	assert.match(app, /canEdit=\{can\("pricing\.edit"\)\}/);
	assert.match(app, /canImport=\{can\("pricing\.import"\)\}/);
	assert.match(app, /canExport=\{can\("pricing\.export"\)\}/);
});

test("each PricingPanel control is gated by its own permission prop", () => {
	const panel = read("../ui/src/components/PricingPanel.tsx");
	// Add / edit / delete / "Add rule" from the unpriced list: edit.
	assert.match(panel, /\{canEdit \? \(\s*<button[^>]*onClick=\{\(\) => openForm\("new"\)\}/);
	assert.match(panel, /onClick=\{\(\) => openForm\(rule\)\}/);
	assert.match(panel, /onDelete\(rule\)/);
	assert.match(panel, /addFromUnpriced\(u\)/);
	assert.equal((panel.match(/\{canEdit \?/g) ?? []).length >= 4, true);
	// Import and export each hide behind their own prop.
	assert.match(panel, /\{canImport \? \(\s*<button/);
	assert.match(panel, /\{canExport \? \(\s*<button/);
	assert.doesNotMatch(panel, /canImport[^\n]*onExport|canExport[^\n]*setImportOpen/);
	assert.match(panel, /Unpriced usage/);
	assert.match(panel, /window\.confirm/);
	assert.match(panel, /replace/);
	assert.match(panel, /merge/);
});

test("cost is shown as an Est. cost KPI, a table column and a usage line", () => {
	const app = read("../ui/src/App.tsx");
	assert.match(app, /label="Est\. cost"/);
	assert.match(app, /unpricedSessions > 0/);
	const table = read("../ui/src/components/WorkflowsTable.tsx");
	assert.match(table, /"Est\. cost"/);
	assert.match(table, /costPartial \? ">=" : ""/);
	assert.match(table, /w\.costUsd == null \? "-"/);
	const meter = read("../ui/src/components/UsageMeter.tsx");
	assert.match(meter, /data-usage-cost/);
	assert.match(meter, /no pricing rule/);
	assert.match(meter, /reported by hub/);
	assert.match(meter, /est\./);
});

test("the pricing client maps duplicate_rule to a readable message", () => {
	const api = read("../ui/src/api/pricing.ts");
	assert.match(api, /duplicate_rule/);
	assert.match(api, /already exists/);
});

test("formatUsd follows the stated rules", async () => {
	const src = read("../ui/src/lib/format.ts");
	const body = src.slice(src.indexOf("export function formatUsd"));
	const formatUsd = new Function(`${body.replace("export function", "function").replace(/: number \| null \| undefined/, "").replace(/\): string/, ")")}; return formatUsd;`)();
	assert.equal(formatUsd(null), "-");
	assert.equal(formatUsd(0.004), "<$0.01");
	assert.equal(formatUsd(12.345), "$12.35");
	assert.equal(formatUsd(1234.6), "$1,235");
});
