import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

export const localRoot = process.env.COMPUTE_FIXTURE_ROOT || 'D:/work/ohSorryRating';
export function createRealm(extra = {}) {
  const context = vm.createContext({ console, TextEncoder, TextDecoder, crypto: webcrypto,
    setTimeout, clearTimeout, queueMicrotask, structuredClone, ...extra });
  vm.runInContext('globalThis.self = globalThis; globalThis.window = globalThis;', context);
  // Native structuredClone creates objects in its own realm. Recreate receiving-realm
  // prototypes, as a real Worker message does, without JSON losing undefined/NaN.
  context.__hostClone = structuredClone;
  vm.runInContext(`globalThis.structuredClone = value => {
    const hydrate = v => {
      if (Array.isArray(v)) return Array.from(v, hydrate);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, hydrate(item)]));
      return v;
    };
    return hydrate(__hostClone(value));
  };`, context);
  const modules = new Map();
  const base = path.dirname(fileURLToPath(import.meta.url));
  function load(name, from = base) {
    let filename = path.resolve(from, name);
    if (!path.extname(filename)) filename += '.ts';
    if (modules.has(filename)) return modules.get(filename);
    const source = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.url', JSON.stringify(import.meta.url));
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {}; modules.set(filename, exports);
    vm.runInContext(`(function(exports, require) { ${compiled}\n})`, context, { filename })(exports,
      name => load(name, path.dirname(filename)));
    return exports;
  }
  const dto = value => { context.__dto = JSON.stringify(value); return vm.runInContext('JSON.parse(__dto)', context); };
  return { context, load, dto, eval: source => vm.runInContext(source, context) };
}
export function localFetch(url) {
  const u = new URL(url);
  const filename = decodeURIComponent(u.pathname.split('/').pop());
  const file = path.join(localRoot, u.pathname.includes('/lib/') ? 'modules' : 'dist', filename);
  const fallback = path.join(localRoot, filename);
  const resolved = fs.existsSync(file) ? file : fallback;
  // No rate-reference snapshot exists locally. Use an explicit, fixed test DTO.
  if (filename === 'rate-reference-slim.json' && !fs.existsSync(resolved)) {
    const text = JSON.stringify({ ec: { '10': { mean: 72, n: 100 } }, hc: { '10': { mean: 75, n: 100 } }, exh: { '10': { mean: 80, n: 100 } } });
    return Promise.resolve({ ok: true, status: 200, text: async () => text });
  }
  const text = fs.readFileSync(resolved, 'utf8');
  return Promise.resolve({ ok: true, status: 200, text: async () => text });
}
export function readData(filename) {
  return JSON.parse(fs.readFileSync(path.join(localRoot, 'dist', filename), 'utf8'));
}
