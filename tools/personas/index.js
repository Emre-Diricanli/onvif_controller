/**
 * Registry for MOCK_PERSONA (GOVERNOR.md, Part 2). One module per probed
 * device; each documents what was observed on the hardware and implements
 * only that. A persona may declare `defaults` (env-mode values applied when
 * the matching MOCK_* variable is unset) and a `create(ctx)` returning hooks:
 *
 *   onRequest(req, res)                  raw HTTP, before built-in dispatch
 *   onSoap({ req, res, body, op, service })  per parsed SOAP request
 *
 * A hook answers by returning true. Unknown names fail loudly — a typo must
 * not silently run the wrong device.
 *
 * Personas are discovered from this directory (ADAPTERS.md §8): every module
 * exporting `persona` is registered under `persona.name`, so adding one never
 * means editing this file.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function discover() {
  const found = {};
  for (const file of readdirSync(HERE).sort()) {
    if (!file.endsWith('.js') || file === 'index.js') continue;
    const mod = await import(pathToFileURL(path.join(HERE, file)).href);
    if (!mod.persona?.name) continue;
    if (found[mod.persona.name]) throw new Error(`Duplicate persona name "${mod.persona.name}" in ${file}`);
    found[mod.persona.name] = mod.persona;
  }
  return found;
}

const PERSONAS = await discover();

export function listPersonas() {
  return { ...PERSONAS };
}

export function loadPersona(name) {
  const persona = PERSONAS[name];
  if (!persona) {
    console.error(`Unknown MOCK_PERSONA "${name}". Known personas: ${Object.keys(PERSONAS).join(', ')}`);
    process.exit(1);
  }
  return persona;
}
