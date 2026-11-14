// Phase 3 evidence (task book §6 wave 2 H, §7 items 4 and 8): validation.json keeps its phase 2 keys
// and adds `phase3`; the Evidence and Brief views carry the phase 3 limits and data sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderEvidence } from '../demo/src/ui/evidence.js';
import { renderBrief } from '../demo/src/ui/brief.js';

// A minimal DOM, enough for ui/dom.js (which only touches `document` and `Node` when called; no top-level
// await here because tests/index.js loads every test file with require()): elements, text nodes, attributes and textContent.
class FakeNode {
  constructor(tag, text = '') { this.tag = tag; this.children = []; this.attrs = {}; this.text = text; }
  append(...c) { this.children.push(...c); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  get firstChild() { return this.children[0] ?? null; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.text = v; this.children = []; }
  findAll(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) c.findAll(pred, out); return out; }
}
// Installed only while a render runs: other test files (loaded into the same process by tests/index.js)
// set their own globalThis.Node.
function render(fn) {
  const saved = [globalThis.Node, globalThis.document];
  globalThis.Node = FakeNode;
  globalThis.document = { createElement: (t) => new FakeNode(t), createTextNode: (s) => new FakeNode('#text', s) };
  try { const el = new FakeNode('main'); fn(el); return el; } finally { [globalThis.Node, globalThis.document] = saved; }
}

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const validation = load('../demo/data/validation.json');
const sites = load('../demo/data/sites.json');
const meta = load('../demo/data/ephemeris.json').meta;

test('validation.json keeps the phase 2 keys and adds phase3 with the §7 item 4 hard checks passing', () => {
  for (const k of ['generatedAt', 'comparisons', 'toleranceDeg', 'maxElDiffDeg', 'maxAzDiffDeg', 'perSite', 'samples', 'terrain']) assert.ok(k in validation, k);
  assert.equal(validation.comparisons, 968);
  assert.ok(validation.terrain.checks.every((c) => c.pass !== false));
  const p = validation.phase3;
  assert.ok(p, 'phase3 key');
  const hard = p.shadow.points;
  assert.equal(hard.length, 10, 'four floors and the ridge on two grids');
  for (const c of hard) assert.equal(c.pass, true, c.name);
  for (const c of hard.filter((x) => x.name.includes('floor'))) assert.equal(c.shadowKm, 0, c.name);
  for (const c of hard.filter((x) => x.name.includes('ridge'))) assert.ok(c.shadowKm > 0, c.name);
  // Everything else is shown only: no pass mark.
  for (const c of [...p.slope, ...p.shadow.shares, p.consistency, ...p.suitability]) assert.equal(c.pass, null, c.name);
  for (const c of p.slope) assert.ok(c.shackletonWallRingDeg > c.shackletonFloorDeg, c.name);
  assert.ok(p.consistency.sites.some((s) => s.siteId === 'shackleton'));
  for (const s of p.suitability) for (const f of s.floors) assert.equal(f.sun, 0, `${s.grid} ${f.name}`);
});

test('Evidence lists the phase 3 checks, the new data source and every required limit', () => {
  const el = render((root) => renderEvidence(root, { validation, meta, sites }));
  const text = el.textContent;
  for (const phrase of [
    // phase 2 strings the smoke test looks for
    'Evidence and limits', 'Who uses this, and when?', 'What is not verified?', '968 comparisons', 'DE441', 'Terrain check', 'LDEM_75S_240M', 'under-estimated',
    // phase 3
    'LDEM_75S_120M', 'Slope, persistent shadow and the 1 km grid',
    'Heat cells are 2 km on the full map and 1 km when zoomed in.',
    'Slope is the mean over a 240 m grid within each cell. Real lander-scale slopes are steeper',
    // phase 4: the official PSR rule replaces the phase 3 skyline rule
    'more than half of it lies in an official permanently shadowed region',
    'a cell can be sunless in our heat map without being a permanently shadowed region',
    'Compared with NASA’s 18.6-year products', 'LDEM_80S_40M', 'LPSR_75S_120M',
    // phase 4 §6: the workflow cards' limits
    'relative power model', 'There are no watts.', 'two-body Kepler orbit',
    'measured on the 240 m grid', 'Rover speed, travel time and energy use are not modelled.',
    'measured on the polar stereographic plane. At 80°S this overstates distances by about 0.8%',
    'The score is a weighted mean of four parts', 'You set the weights.', 'is not a finding that a mission is feasible',
    'The Ask panel is a scripted demo and no model is connected.',
  ]) assert.ok(text.includes(phrase), phrase);
  assert.ok(!text.includes('!'), 'no exclamation marks');
  // The hard-check table: five rows, every cell a pass on both grids.
  const tables = el.findAll((n) => n.tag === 'table');
  const hardTable = tables.find((t) => t.textContent.includes('1 km grid') && t.textContent.includes('Faustini floor'));
  assert.ok(hardTable);
  assert.equal(hardTable.findAll((n) => n.tag === 'tr').length, 6);
  assert.equal((hardTable.textContent.match(/, pass/g) ?? []).length, 10);
  const siteTable = tables.find((t) => t.textContent.includes('1 km cell'));
  assert.equal(siteTable.findAll((n) => n.tag === 'tr').length, validation.phase3.consistency.sites.length + 1);
});

test('Evidence still renders without phase3 (older validation.json)', () => {
  const { phase3, ...old } = validation;
  const el = render((root) => renderEvidence(root, { validation: old, meta, sites }));
  assert.ok(el.textContent.includes('Terrain check'));
  assert.ok(!el.textContent.includes('Slope, persistent shadow and the 1 km grid'));
});

test('Brief keeps the smoke phrases and covers phase 3', () => {
  const el = render((root) => renderBrief(root, { challengeUrl: 'https://example.org/' }));
  const text = el.textContent;
  for (const phrase of ['Coverage of the official objectives', 'Power and communication assessment', 'Questions for the team', 'South pole map with five heat modes',
    'suitability map', '1 km cells when zoomed in', 'step-by-step tour', 'no model connected']) assert.ok(text.includes(phrase), phrase);
  assert.ok(!text.includes('!'), 'no exclamation marks');
});
