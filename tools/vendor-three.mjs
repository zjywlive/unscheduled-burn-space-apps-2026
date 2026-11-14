// Converts three.js's ESM build (package/build/three.core.js + three.module.js, from `npm pack three@<v>`)
// into one classic script, demo/vendor/three.classic.js, that sets window.THREE. The page loads vendor
// libraries with a classic <script src> so it keeps working from file:// (see demo/vendor/VENDOR.md).
// The conversion is mechanical: each file keeps its own function scope, its import line becomes a
// destructuring of the core's exports, and its export lines become a returned object. Nothing else changes.
// Usage: node tools/vendor-three.mjs <path to package/build> <version>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, version] = process.argv.slice(2);
if (!dir || !version) { console.error('usage: node tools/vendor-three.mjs <package/build> <version>'); process.exit(1); }

// `{ a, b as c }` → [['a', 'a'], ['b', 'c']] (local name, exported name)
const names = (list) => list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
  const m = s.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
  if (!m) throw new Error(`cannot read export item "${s}"`);
  return [m[1], m[2] ?? m[1]];
});
const obj = (pairs) => `{ ${pairs.map(([local, name]) => (local === name ? local : `${name}: ${local}`)).join(', ')} }`;

function split(src, file) {
  const lines = src.split('\n');
  const imports = [], exports = [], reexports = [], body = [];
  for (const line of lines) {
    let m;
    if ((m = line.match(/^import\s*\{([^}]*)\}\s*from\s*['"]\.\/three\.core\.js['"];?\s*$/))) imports.push(...names(m[1]));
    else if ((m = line.match(/^export\s*\{([^}]*)\}\s*from\s*['"]\.\/three\.core\.js['"];?\s*$/))) reexports.push(...names(m[1]));
    else if ((m = line.match(/^export\s*\{([^}]*)\};?\s*$/))) exports.push(...names(m[1]));
    else if (/^\s*(import|export)\b/.test(line)) throw new Error(`${file}: unhandled module line: ${line.slice(0, 120)}`);
    else body.push(line);
  }
  return { imports, exports, reexports, body: body.join('\n') };
}

const core = split(readFileSync(join(dir, 'three.core.js'), 'utf8'), 'three.core.js');
const mod = split(readFileSync(join(dir, 'three.module.js'), 'utf8'), 'three.module.js');
if (core.imports.length || core.reexports.length) throw new Error('three.core.js is expected to have no imports');

const out = `/* three.js ${version} (MIT, Copyright 2010-2026 Three.js Authors), converted from build/three.core.js +
   build/three.module.js into one classic script that sets window.THREE (tools/vendor-three.mjs). */
(function () {
'use strict';
const __core = (function () {
${core.body}
return ${obj(core.exports)};
})();
const __module = (function (${obj(mod.imports.map(([local, name]) => [name, local]))}) {
${mod.body}
return ${obj(mod.exports)};
})(__core);
const __re = {}; for (const [local, name] of ${JSON.stringify(mod.reexports)}) __re[name] = __core[local];
window.THREE = Object.freeze(Object.assign({}, __re, __module));
})();
`;
writeFileSync(new URL('../demo/vendor/three.classic.js', import.meta.url), out);
console.log(`three.classic.js: ${out.length} bytes, ${Object.keys(core.exports).length} core exports, ${mod.exports.length} module exports, ${mod.reexports.length} re-exports`);
