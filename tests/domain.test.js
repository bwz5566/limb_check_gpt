import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { angle, analyzeFrame, aggregate, emptyChecks, finding, arbitrate, makeReport, defaultEvidenceIndices } from '../web/src/domain.js';
import { Workflow } from '../web/src/workflow.js';
const rules = JSON.parse(readFileSync(new URL('../config/rules.json', import.meta.url)));

test('default review evidence includes palms and backs rather than only body steps', () => {
  const evidence = ['正面站立','双臂平举','下蹲','掌心朝前','手背朝前','再次张开'].map(label => ({label}));
  assert.deepEqual(defaultEvidenceIndices(evidence), [4,3,0]);
});

test('missing targets are uncertain, optional appearance stays unassessed', () => {
  const result = analyzeFrame({ poses: [], hands: [], brightness: 128 }, rules);
  assert.equal(result.checks.limbs.status, 'uncertain');
  assert.equal(result.checks.fingers.status, 'uncertain');
  assert.equal(result.checks.nails.status, 'not_assessed');
  assert.equal(result.checks.tattoo.status, 'not_assessed');
});
test('invalid lighting cannot produce a clear assessment', () => {
  const result = analyzeFrame({ poses: [], hands: [], brightness: 0 }, rules, { nails: true });
  assert.equal(result.checks.nails.status, 'uncertain');
});
test('zero length geometry does not produce NaN', () => {
  assert.equal(angle({x:0,y:0}, {x:0,y:0}, {x:0,y:0}), 0);
});
test('one clear frame cannot hide nine unobservable frames', () => {
  const frames = Array.from({ length: 10 }, (_, i) => ({ checks: { ...emptyChecks(), fingers: finding(i ? 'uncertain' : 'clear', 'test') } }));
  assert.equal(aggregate(frames).fingers.status, 'uncertain');
});
test('flagged evidence is retained across otherwise clear frames', () => {
  const frames = ['clear','flag','clear'].map(status => ({ checks: { ...emptyChecks(), fingers: finding(status, 'test') } }));
  assert.equal(aggregate(frames).fingers.status, 'flag');
});
test('model disagreement and insufficient evidence require review', () => {
  const local = { ...emptyChecks(), fingers: finding('flag', 'test') };
  const remote = { checks: { fingers: finding('clear', 'test'), tattoo: finding('flag', 'test') } };
  const result = arbitrate(local, remote);
  assert.equal(result.fingers.status, 'uncertain');
  assert.equal(result.tattoo.source, 'vlm');
  assert.equal(local.fingers.status, 'flag');
});
test('reports have explicit empty state, rules snapshot and unique run IDs', () => {
  const options = { source:'synthetic', name:'test', engine:'test', rules };
  const a = makeReport([], options), b = makeReport([], options);
  assert.equal(a.checks.fingers.status, 'not_assessed'); assert.equal(a.synthetic, true);
  assert.notEqual(a.run_id, b.run_id); assert.notEqual(a.rules, rules);
});
test('workflow missing hands times out, never completes successfully', () => {
  const flow = new Workflow('hands', rules, 0);
  const frame = { poses: [], hands: [], detail: { brightness: 128, hands: [] } };
  assert.equal(flow.update(frame, 500).completed, undefined);
  assert.equal(flow.update(frame, rules.stepTimeoutMs + 1).completed.status, 'timeout');
  assert.equal(flow.results[0].id, 'palms');
});
test('workflow hold resets when observation stops matching', () => {
  const flow = new Workflow('hands', rules, 0);
  let matches = true; flow.check = () => matches ? null : 'not yet';
  assert.equal(flow.update({}, 10).progress, 0);
  matches = false; assert.equal(flow.update({}, 500).progress, 0);
  matches = true; assert.equal(flow.update({}, 900).progress, 0);
  // Completing palms needs a valid frame; verify hold is not erroneously completed early.
  assert.equal(flow.update({}, 1200).completed, undefined);
});
