// Lander track: the standalone page builds from the modules (tools/build-lander.mjs) and the branches are sound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundle } from '../tools/build.mjs';
import { buildLander, fillMark, LANDER_MARKS } from '../tools/build-lander.mjs';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { planMission } from '../demo/src/lander/mission.js';
import { buildBranches } from '../demo/src/lander/branches.js';

const demo = new URL('../demo/', import.meta.url).pathname;

test('build: every lander module follows the bundler conventions and the entry bundles', () => {
  const js = bundle(join(demo, 'src', 'lander', 'main.js'));
  assert.ok(js.includes("__m['main.js']"));
  for (const m of ['mission.js', 'descent.js', 'branches.js', 'view-surface.js', '../relay.js']) assert.ok(js.includes(`__m['${m}']`), m);
});

test('build: the page has every marker and the build fills them in a copy (the checked-in page is not touched)', () => {
  const page = readFileSync(join(demo, 'lander.html'), 'utf8');
  for (const m of LANDER_MARKS) {
    assert.ok(page.includes(`<!--LANDER:${m}-->`) && page.includes(`<!--/LANDER:${m}-->`), m);
  }
  assert.ok(page.includes('<script src="vendor/three.classic.js"></script>'));
  const dir = mkdtempSync(join(tmpdir(), 'lander-build-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    cpSync(join(demo, 'src'), join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'data'));
    for (const f of ['ephemeris.json', 'sites.json', 'terrain.json']) cpSync(join(demo, 'data', f), join(dir, 'data', f));
    cpSync(join(demo, 'lander.html'), join(dir, 'lander.html'));
    buildLander(dir, { log: () => {} });
    const out = readFileSync(join(dir, 'lander.html'), 'utf8');
    assert.ok(out.includes('id="data-ephemeris"') && out.includes('id="data-sites"') && out.includes('id="data-terrain"'));
    assert.ok(out.includes('window.__lsnStore'));
    assert.ok(!/<\/script/i.test(out.split('<!--LANDER:JS-->')[1].split('<!--/LANDER:JS-->')[0].replace(/<script>|<\/script>\s*$/g, '').slice(0, -10)));
    assert.throws(() => fillMark('<p></p>', 'JS', 'x'), /missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('branches: every event has a decision; at least two are drawn; the abort and the divert behave', () => {
  const eph = createEphemeris(JSON.parse(readFileSync(join(demo, 'data', 'ephemeris.json'), 'utf8')));
  const sites = JSON.parse(readFileSync(join(demo, 'data', 'sites.json'), 'utf8'));
  const site = sites.find((s) => s.id === 'shackleton');
  const plan = planMission({ eph, site, landingMs: Date.parse('2027-01-10T02:00:00Z') });
  const branches = buildBranches(plan, { sites, skyOk: () => true });
  assert.ok(branches.length >= 6);
  for (const b of branches) {
    assert.ok(b.decision && typeof b.decision.action === 'string' && b.decision.reason.length > 10, b.id);
    assert.ok(b.tMs >= plan.times.launchMs && b.tMs <= plan.times.endMs, b.id);
  }
  assert.ok(branches.filter((b) => b.moonTrack?.length || b.surfaceSamples?.length).length >= 2);
  const abort = branches.find((b) => b.id === 'engine-abort');
  assert.equal(abort.decision.action, 'abort-to-orbit');
  const rMax = Math.max(...abort.moonTrack.map((p) => Math.hypot(...p)));
  assert.ok(rMax - 1737.4 > 15, 'the abort climbs back above 15 km');
  const low = branches.find((b) => b.id === 'engine-low');
  assert.equal(low.decision.action, 'continue');
  const div = branches.find((b) => b.id === 'hazard-divert');
  assert.equal(div.decision.action, 'divert');
  assert.ok(div.surfaceSamples.length > 100);
  assert.ok(['wave-off', 'hold'].includes(branches.find((b) => b.id === 'wave-off').decision.action));
});
