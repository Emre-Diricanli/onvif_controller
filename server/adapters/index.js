/**
 * Adapter registry (ADAPTERS.md §9).
 *
 * Adapters are discovered from server/adapters/<id>/index.js, so adding one
 * never means editing this file. Probes run one at a time per host and are
 * cached briefly, so connecting never storms a recorder with every vendor's
 * probe at once.
 */
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_CACHE_MS = 60_000;

let loaded = null;
const probeCache = new Map();

export async function loadAdapters() {
  if (loaded) return loaded;
  const modules = [];
  for (const entry of readdirSync(HERE, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(HERE, entry.name, 'index.js');
    if (!existsSync(file)) continue;
    const mod = await import(pathToFileURL(file).href);
    if (mod.id !== entry.name || typeof mod.probe !== 'function' || typeof mod.connect !== 'function') {
      // A malformed adapter is a programming error; refuse loudly rather than skip silently.
      throw new Error(`server/adapters/${entry.name}/index.js does not honour ADAPTERS.md §5`);
    }
    modules.push(mod);
  }
  modules.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50) || a.id.localeCompare(b.id));
  loaded = modules;
  return loaded;
}

export async function listAdapters() {
  return loadAdapters();
}

export async function getAdapter(id) {
  return (await loadAdapters()).find((a) => a.id === id) ?? null;
}

/**
 * Probe adapters serially against one device. Never throws: a probe failure
 * is a non-match. `only` restricts to a list of adapter ids.
 */
export async function probeAll(config, { only = null, useCache = true } = {}) {
  const key = `${config.host}:${config.port ?? ''}|${only ? only.join(',') : '*'}`;
  const hit = probeCache.get(key);
  if (useCache && hit && Date.now() - hit.at < PROBE_CACHE_MS) return hit.results;
  const results = [];
  for (const adapter of await loadAdapters()) {
    if (only && !only.includes(adapter.id)) continue;
    let result = { match: false, confidence: 0 };
    try {
      result = (await adapter.probe(config)) ?? result;
    } catch {
      result = { match: false, confidence: 0 };
    }
    results.push({ id: adapter.id, ...result });
  }
  probeCache.set(key, { at: Date.now(), results });
  return results;
}

export function clearProbeCache() {
  probeCache.clear();
}
