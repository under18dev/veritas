import { describe, expect, it } from 'vitest';
import { killedByNewTests, lostResults, requiredClaimIds } from '../src/apply.js';

describe('lostResults', () => {
  it('lists results that were decided before the patch and are undecided after it', () => {
    const before = {
      'C-a': 'proven_within_model',
      'C-b': 'counterexample_found',
      'C-c': 'unknown',
      'PBT-d': 'passed',
      'C-e': 'proven_within_model',
    };
    const after = {
      'C-a': 'timeout',
      'C-b': 'counterexample_found',
      'C-c': 'timeout',
      'PBT-d': 'error',
      // A claim that is not made again (for example about a mutant the new test kills) is not a loss.
    };
    expect(lostResults(before, after)).toEqual([
      'C-a: proven_within_model -> timeout',
      'PBT-d: passed -> error',
    ]);
  });

  it('requires conformance results to be produced again, but not results about mutants', () => {
    const before = { 'C-conf': 'proven_within_model', 'C-mutant': 'counterexample_found' };
    expect(lostResults(before, {}, new Set(['C-conf']))).toEqual([
      'C-conf: proven_within_model -> not produced',
    ]);
    expect(lostResults(before, { 'C-conf': 'proven_within_model' }, new Set(['C-conf']))).toEqual([]);
  });

  it('is empty when nothing decided became undecided', () => {
    expect(lostResults({ 'C-a': 'unknown' }, { 'C-a': 'unknown' })).toEqual([]);
    expect(lostResults({ 'C-a': 'timeout' }, { 'C-a': 'proven_within_model' })).toEqual([]);
  });

  it('requires claims about mutants that were already killed before the patch', () => {
    const claims = [{ id: 'C-m0', kind: 'property_detection', mutantId: 'M-0' }];
    // M-0 was killed before the patch, so it is not newly killed and its claim must be made again.
    const required = requiredClaimIds(claims, new Set(['M-1']));
    expect(lostResults({ 'C-m0': 'counterexample_found' }, {}, required)).toEqual([
      'C-m0: counterexample_found -> not produced',
    ]);
  });

  it('requires claims about mutants that are still not killed, but not about mutants the new tests kill', () => {
    const claims = [
      { id: 'C-conf', kind: 'conformance' },
      { id: 'C-m1', kind: 'bounded_equivalence', mutantId: 'M-1' },
      { id: 'C-m2', kind: 'distinguishability', mutantId: 'M-2' },
    ];
    const required = requiredClaimIds(claims, new Set(['M-1']));
    expect([...required].sort()).toEqual(['C-conf', 'C-m2']);
    const before = {
      'C-conf': 'proven_within_model',
      'C-m1': 'counterexample_found',
      'C-m2': 'proven_within_model',
    };
    // M-2 still survives, but its claim was not made again: lost.
    expect(lostResults(before, { 'C-conf': 'proven_within_model' }, required)).toEqual([
      'C-m2: proven_within_model -> not produced',
    ]);
  });

  it('counts a mutant as killed by the new tests only when a test unknown to the baseline kills it', () => {
    const m = (id: string, status: string, killedBy: string[], coveredBy: string[] = killedBy) => ({
      id,
      status,
      killedBy,
      coveredBy,
    });
    const before = [
      m('M-0', 'killed', ['T-old']),
      m('M-1', 'survived', [], ['T-old']),
      m('M-2', 'survived', [], ['T-old']),
    ];
    const after = [
      m('M-0', 'killed', ['T-old', 'T-new']),
      // An existing test happened to kill M-1 this time: not counted.
      m('M-1', 'killed', ['T-old']),
      m('M-2', 'killed', ['T-new']),
    ];
    expect([...killedByNewTests(before, after)]).toEqual(['M-2']);
  });
});
