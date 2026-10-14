/**
 * Test runner (ADAPTERS.md §8).
 *
 *   node tools/run-tests.mjs            smoke suite + every tools/tests/*.mjs
 *   node tools/run-tests.mjs hikvision  only tests whose file name contains "hikvision"
 *   SKIP_SMOKE=1 node tools/run-tests.mjs
 *
 * Each test is its own process, so one stream's test cannot leak state into
 * another's. Files starting with "_" are helpers and are skipped.
 */
import { spawn } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filter = process.argv[2] ?? null;

const files = [];
if (!filter && !process.env.SKIP_SMOKE) files.push('tools/smoke.mjs');
const testsDir = path.join(ROOT, 'tools/tests');
if (existsSync(testsDir)) {
  for (const f of readdirSync(testsDir).sort()) {
    if (!f.endsWith('.mjs') || f.startsWith('_')) continue;
    if (filter && !f.includes(filter)) continue;
    files.push(`tools/tests/${f}`);
  }
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code, signal) => resolve(code === 0 && !signal));
  });
}

// The MCP server is its own package; its tests need `npm install --prefix mcp`.
const mcpReady = existsSync(path.join(ROOT, 'mcp/node_modules/@modelcontextprotocol/sdk'));

const failed = [];
for (const file of files) {
  if (!mcpReady && path.basename(file).startsWith('mcp-')) {
    console.log(`\n=== ${file}\n  skipped: run \`npm install --prefix mcp\` to test the MCP server`);
    continue;
  }
  console.log(`\n=== ${file}`);
  if (!(await run(file))) failed.push(file);
}
console.log(`\n=== ${files.length - failed.length}/${files.length} test files passed`);
if (failed.length) {
  console.log(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
