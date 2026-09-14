#!/usr/bin/env node
/**
 * Fail fast when Node is too old for target-server (needs node:sqlite, Node ≥ 24).
 */
const MIN_MAJOR = 24;
const { node: version } = process.versions;
const major = Number.parseInt(version.split(".")[0] ?? "", 10);

if (Number.isFinite(major) && major >= MIN_MAJOR) {
	process.exit(0);
}

const msg = `
target-server requires Node.js >= ${MIN_MAJOR} (you have v${version}).

This project uses the built-in \`node:sqlite\` module, which is not available on
Node 18 or 20. Vite 7 (dashboard build) also needs Node 20.19+ or 22.12+.

Upgrade, then re-run:

  # with nvm (recommended — .nvmrc is set to 24):
  nvm install 24
  nvm use 24
  node --version    # should print v24.x.x
  npm run start

  # with fnm:
  fnm install 24 && fnm use 24

See README.md § Requirements for details.
`.trim();

console.error(msg);
process.exit(1);
