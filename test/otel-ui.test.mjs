/**
 * Source-reading checks for the Telemetry export panel: navigation and edit
 * gating, masked headers, presets and their "untested" labels, the states the
 * panel renders and the pricing notice. Style of pricing-ui.test.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const app = read("../ui/src/App.tsx");
const panel = read("../ui/src/components/OtelPanel.tsx");
const client = read("../ui/src/api/otel.ts");

test("the Settings tab opens for telemetry.read and the panel is rendered only with it", () => {
	assert.match(app, /const canTelemetry = can\("telemetry\.read"\)/);
	assert.match(app, /const canSettings = canPricing \|\| canTelemetry/);
	assert.match(app, /\{canTelemetry \? <OtelPanel canEdit=\{can\("telemetry\.write"\)\} \/> : null\}/);
	// Pricing keeps its own gate, so a telemetry-only user does not see it.
	assert.match(app, /\{canPricing \? \(\s*<PricingPanel/);
});

test("without telemetry.write the form is read-only and Save / Test are hidden", () => {
	assert.match(panel, /export function OtelPanel\(\{ canEdit \}: \{ canEdit: boolean \}\)/);
	assert.match(panel, /const locked = !canEdit \|\| !secretsOk/);
	assert.match(panel, /<fieldset className="otel-fieldset" disabled=\{locked\}>/);
	assert.match(panel, /data-state="read-only"/);
	assert.match(panel, /needs the telemetry\.write permission/);
	// The Save and Test buttons live inside the canEdit branch.
	assert.match(panel, /\{canEdit \? \(\s*<div className="catalog-toolbar">\s*<button className="btn btn--on"[\s\S]*?Test connection[\s\S]*?<\/div>\s*\) : null\}/);
	assert.match(panel, /const canTest = canEdit && secretsOk/);
});

test("stored header values are never rendered, logged or sent back", () => {
	// A stored row starts with an empty value; the mask is only a placeholder.
	assert.match(panel, /newRow\(\{ name: h\.name, stored: true, masked: h\.masked \}\)/);
	assert.match(panel, /placeholder=\{row\.stored \? `\$\{row\.masked\} \(saved, type to replace\)`/);
	assert.match(panel, /type="password"/);
	assert.match(panel, /readOnly=\{row\.stored\}/);
	// Unchanged rows go out as "" so the server keeps the stored secret.
	assert.match(panel, /headers\[row\.name\.trim\(\)\] = row\.value/);
	for (const file of [panel, client]) assert.doesNotMatch(file, /console\./);
	assert.doesNotMatch(panel, /dangerouslySetInnerHTML/);
});

test("presets only pre-fill the form: endpoint, header names, signals", () => {
	const fn = panel.slice(panel.indexOf("function applyPreset"), panel.indexOf("async function onSubmit"));
	assert.match(fn, /setDraft\(\{ \.\.\.draft, endpoint: p\.endpoint, headers, signals: p\.signals, langfuseAttrs: p\.langfuseAttrs \}\)/);
	assert.doesNotMatch(fn, /saveOtelSettings|testOtelConnection|fetch\(/);
	assert.match(panel, /Nothing is saved until you press Save/);
	assert.match(panel, /endpoint: "https:\/\/cloud\.langfuse\.com\/api\/public\/otel"/);
	assert.match(panel, /name: "x-langfuse-ingestion-version", value: "4"/);
	assert.match(panel, /endpoint: "https:\/\/otlp-gateway-<REGION>\.grafana\.net\/otlp"/);
	assert.match(panel, /label: "My own OpenTelemetry Collector"/);
	assert.match(panel, /endpoint: "http:\/\/collector\.example\.com:4318"/);
	// Authorization is entered by the user, never prefilled.
	assert.match(panel, /\{ name: "Authorization", value: "" \}/);
	assert.match(panel, /echo -n 'pk-lf-\.\.\.:sk-lf-\.\.\.' \| base64/);
	assert.match(panel, /echo -n 'INSTANCE_ID:TOKEN' \| base64/);
});

test("presets are marked untested where phase 0 says NOT TESTED or FAIL", () => {
	const findings = read("../docs/observability/phase0-findings.md");
	assert.match(findings, /\| Grafana Cloud \| traces \| JSON \| NOT TESTED/);
	assert.match(findings, /\| Langfuse \| metrics \| JSON \| FAIL/);
	assert.match(panel, /id: "langfuse"[\s\S]*?untested: \["metrics"\]/);
	assert.match(panel, /id: "grafana-cloud"[\s\S]*?untested: \["traces", "metrics"\]/);
	assert.match(panel, /id: "collector"[\s\S]*?untested: \[\]/);
	assert.match(panel, /p\.untested\.length === 2 \? "untested"/);
});

test("secretsAvailable=false disables the form and names TARGET_SECRETS_KEY", () => {
	assert.match(panel, /const secretsOk = settings\?\.secretsAvailable \?\? true/);
	assert.match(panel, /data-state="secrets-unavailable"/);
	assert.match(panel, /the server administrator must set TARGET_SECRETS_KEY/);
	assert.match(panel, /The form is disabled until then/);
});

test("the panel has distinct labelled states", () => {
	for (const state of ["loading", "empty", "configured", "secrets-unavailable", "read-only", "test-loading", "test-success", "test-failure", "status"]) {
		assert.match(panel, new RegExp(`data-state=(?:"${state}"|\\{[^}]*"${state}")`), state);
	}
	assert.match(panel, /Retry/);
	assert.match(panel, /Not configured/);
});

test("test connection shows the HTTP status and error, and only tests saved settings", () => {
	assert.match(client, /\$\{BASE\}\/test/);
	assert.match(client, /"POST"/);
	assert.match(panel, /setTesting\(true\)/);
	assert.match(panel, /Testing the connection/);
	assert.match(panel, /The destination accepted the test data/);
	assert.match(panel, /HTTP \$\{testResult\.status\}/);
	assert.match(panel, /testResult\.error \?\? "The destination did not accept the test data\."/);
	assert.match(panel, /!dirty/);
	// Status block: last success (relative and absolute) and last error.
	assert.match(panel, /timeAgo\(settings\.status\.lastOkAt\)/);
	assert.match(panel, /absoluteTime\(settings\.status\.lastOkAt\)/);
	assert.match(panel, /settings\.status\.lastError \?\? "None"/);
});

test("the pricing notice is present verbatim", () => {
	assert.match(panel, />Editing a price in Pricing does not change data that was already exported\.<\/div>/);
});

test("telemetry permissions are in the role editor catalogue", () => {
	const source = read("../ui/src/api/permissions.ts");
	assert.match(source, /id: "telemetry\.read"/);
	assert.match(source, /id: "telemetry\.write"/);
});

const copyValue = read("../ui/src/components/CopyValue.tsx");
const orgsPanel = read("../ui/src/components/OrganizationsPanel.tsx");
const types = read("../ui/src/api/types.ts");
const css = read("../ui/src/styles/global.css");

test("the panel shows the organization name and id with a Copy button", () => {
	assert.match(types, /organization\?: \{ id: string; name: string \}/);
	assert.match(panel, /import \{ CopyValue \} from "\.\/CopyValue\.tsx"/);
	assert.match(panel, /settings\?\.organization\?\.id \? \(/);
	assert.match(panel, /<strong>\{settings\.organization\.name\}<\/strong>/);
	assert.match(panel, /<CopyValue value=\{settings\.organization\.id\} label="organization id" \/>/);
	assert.match(panel, /This id is the value that appears as target\.org in Grafana, Tempo and Prometheus\./);
	// The block sits above the form, and nothing in it renders a header value.
	assert.ok(panel.indexOf('data-state="organization"') < panel.indexOf("<form"));
	const block = panel.slice(panel.indexOf('data-state="organization"'), panel.indexOf("Editing a price in Pricing"));
	assert.doesNotMatch(block, /headers|masked|\.value\b/);
});

test("no organization block is rendered when the API gives no id", () => {
	// The whole block is gated on the id, so an old server (no `organization`) shows nothing.
	assert.match(panel, /\{settings\?\.organization\?\.id \? \(\s*<div className="otel-org"/);
});

test("CopyValue: aria-label, keyboard-operable button, Copied feedback, clipboard failure", () => {
	assert.match(copyValue, /<button type="button" className="btn btn--sm" aria-label=\{`Copy \$\{label\}`\}/);
	assert.match(copyValue, /await navigator\.clipboard\.writeText\(value\)/);
	assert.match(copyValue, /state === "copied" \? "Copied" : "Copy"/);
	assert.match(copyValue, /setTimeout\(\(\) => setState\("idle"\), next === "copied" \? 2000 : 6000\)/);
	// Failure path: a rejected (or missing) clipboard API shows a message; the value stays selectable.
	assert.match(copyValue, /catch \{\s*next = "failed";/);
	assert.match(copyValue, /Could not copy: select the value and copy it manually\./);
	assert.match(copyValue, /role="status"/);
	assert.match(copyValue, /<span className="mono copy-value__text">\{value\}<\/span>/);
	assert.match(css, /\.copy-value__text \{[^}]*user-select: all/);
	assert.match(css, /\.copy-value \{[^}]*flex-wrap: wrap/);
	assert.match(css, /\.otel-org \{[^}]*flex-wrap: wrap/);
	assert.doesNotMatch(copyValue, /console\./);
});

test("the Organizations panel has the same control for every organization id", () => {
	assert.match(orgsPanel, /import \{ CopyValue \} from "\.\/CopyValue\.tsx"/);
	assert.match(orgsPanel, /<th>ID<\/th>/);
	assert.match(orgsPanel, /<CopyValue value=\{org\.id\} label=\{`id of \$\{org\.name\}`\} \/>/);
});

test("Send content: checked for a new configuration, the stored value otherwise", () => {
	// The form starts from what the API reports: true with no saved row (step 2), the stored 0/1 otherwise.
	assert.match(panel, /sendContent: config\.sendContent,/);
	assert.doesNotMatch(panel, /sendContent: false/);
	assert.match(panel, /<input type="checkbox" checked=\{draft\.sendContent\} onChange=\{\(event\) => patch\(\{ sendContent: event\.target\.checked \}\)\} \/>/);
	// A stored false reaches the draft untouched, and a changed box makes the form dirty.
	assert.match(panel, /d\.sendContent !== c\.sendContent/);
	assert.match(panel, /sendContent: d\.sendContent,/);
	// The server side of the default: no stored row reports true.
	assert.match(read("../server.mjs"), /sendContent: true, \/\/ default for an organization that never saved a config/);
});

test("Send content explains what it adds and what is never sent, right next to the checkbox", () => {
	const at = panel.indexOf("checked={draft.sendContent}");
	const block = panel.slice(at, panel.indexOf("{formError ?", at)).replace(/\s+/g, " ");
	assert.match(block, /Send content \(workflow and organization names\)/);
	assert.match(block, /When checked, exports also include the workflow name and the organization name/);
	assert.match(block, /Whoever operates the destination will be able to read them/);
	assert.match(block, /Unchecking it removes the names from future exports; data already exported is not changed/);
	assert.match(block, /Never sent, whatever you choose: step descriptions or prompts, acceptance criteria, error messages \(only the error kind is sent\) and conversation content/);
	assert.doesNotMatch(panel, new RegExp(["step text", "errors"].join(", ")));
	assert.doesNotMatch(panel, /off by default/);
});
