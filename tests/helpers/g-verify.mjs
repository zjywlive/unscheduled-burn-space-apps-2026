// Run Task G's required commands with all disposable test/browser files kept in this project.
// Full output is retained next to this helper; stdout shows the useful summary (and any failures).
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../../', import.meta.url);
const cmds = { test: ['--test', 'tests/'], build: ['tools/build.mjs'], smoke: ['tools/smoke.mjs'] };
for (const name of process.argv.slice(2)) {
  if (!cmds[name]) throw new Error(`unknown check ${name}`);
  const r = spawnSync(process.execPath, cmds[name], { cwd: fileURLToPath(root), env: { ...process.env, TMPDIR: fileURLToPath(new URL('tests/', root)) }, encoding: 'utf8', timeout: 600000, maxBuffer: 8e6 });
  const output = (r.stdout ?? '') + (r.stderr ?? '');
  writeFileSync(new URL(`g-${name}${process.env.SMOKE_ONLY ? '-targeted' : ''}.log`, import.meta.url), output);
  console.log(`$ node ${cmds[name].join(' ')}`);
  console.log(r.status === 0 ? output.split('\n').filter(l => /^(ℹ|Wrote|page:|all |# (tests|pass|fail|duration))/.test(l)).join('\n') : output);
  if (r.status !== 0) { console.error(r.error?.message ?? `exit ${r.status}`); process.exit(r.status || 1); }
}
