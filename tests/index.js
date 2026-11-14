// Node 26 treats `node --test tests/` as a module path and resolves the directory to this file,
// so this loads every *.test.mjs here. `node --test 'tests/*.test.mjs'` runs the same set.
// import() rather than require(): some test files use top-level await.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  for (const f of readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort()) await import(pathToFileURL(join(__dirname, f)).href);
})();
