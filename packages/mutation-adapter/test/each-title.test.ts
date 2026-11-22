import { stableId } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { compileTitleTemplate, matchesTitleTemplate, mutatorTestId, TestNameIndex } from '../src/index.js';

const matches = (template: string, name: string): boolean => {
  const compiled = compileTitleTemplate(template);

  if (compiled === undefined) throw new Error(`no placeholder in ${template}`);

  return matchesTitleTemplate(compiled, name);
};

describe('title templates of table-driven tests', () => {
  it('matches printf-style placeholders to the text they format', () => {
    expect(matches('Should throw for invalid IPv4: %s', 'Should throw for invalid IPv4: 01.2.3.4')).toBe(
      true,
    );
    expect(matches('%d + %i = %f', '1 + 2 = 3.5')).toBe(true);
    expect(matches('parses %j and %o and %O', 'parses {"a":1} and { a: 1 } and {"b":2}')).toBe(true);
    expect(matches('pretty %p', 'pretty "x"')).toBe(true);
    expect(matches('Should throw for invalid IPv4: %s', 'Should throw for invalid IPv6: 1::2::3')).toBe(
      false,
    );
    expect(matches('Should throw for invalid IPv4: %s', 'Should throw for invalid IPv4: ')).toBe(false);
  });

  it('matches the row index of %# and %$, and reads %% as a literal percent', () => {
    expect(matches('case %#', 'case 0')).toBe(true);
    expect(matches('case %$: %s', 'case 1: a')).toBe(true);
    expect(matches('100%% of %s', '100% of x')).toBe(true);
    expect(matches('100%% of %s', '100%% of x')).toBe(false);
    expect(compileTitleTemplate('100%% sure')).toBeUndefined();
    expect(compileTitleTemplate('50% off, 10%')).toBeUndefined();
  });

  it('lets %c print nothing', () => {
    expect(matches('%cstyled %s', 'styled a')).toBe(true);
  });

  it('matches $variable, $a.b, $0 and $# interpolation', () => {
    expect(
      matches('convertIPv4ToString($input) === $expected', 'convertIPv4ToString(0.0.0.1) === 0.0.0.1'),
    ).toBe(true);
    expect(matches('reads $user.name', 'reads Ada')).toBe(true);
    expect(matches('first is $0', 'first is 1')).toBe(true);
    expect(matches('row $#', 'row 2')).toBe(true);
    expect(
      matches('convertIPv4ToString($input) === $expected', 'convertIPv4ToString(0.0.0.1) == 0.0.0.1'),
    ).toBe(false);
    expect(compileTitleTemplate('costs 5$')).toBeUndefined();
  });

  it('treats regular expression characters literally', () => {
    expect(matches('a.b (%s) [x]* ^$', 'a.b (1) [x]* ^$')).toBe(true);
    expect(matches('a.b (%s)', 'aXb (1)')).toBe(false);
  });

  it('lets a placeholder stand for its own text, which the runner keeps when it has no value', () => {
    expect(matches('%s and %s', '1 and %s')).toBe(true);
    expect(matches('with $missing', 'with $missing')).toBe(true);
  });

  it('needs a character for each of two adjacent placeholders', () => {
    expect(matches('%s%s!', 'ab!')).toBe(true);
    expect(matches('%s%s!', 'a!')).toBe(false);
  });

  it('places literals leftmost, so a value that contains the next literal still matches', () => {
    expect(matches('%s, then %s, end', 'a, then b, then c, end')).toBe(true);
    expect(matches('%s, then %s', 'x, then ')).toBe(false);
  });

  it('matches long names without catastrophic backtracking', () => {
    const template = compileTitleTemplate(`${'%s a'.repeat(30)}!`);
    // A regular expression of 30 `(.+) a` groups would backtrack through every split of this name.
    const name = `${'x a'.repeat(28)}${'x'.repeat(5000)} a!`;
    const started = performance.now();

    expect(template && matchesTitleTemplate(template, name)).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('resolving mutator names of table-driven tests to inventoried tests', () => {
  const FILE = 'src/utils/ipaddr.test.ts';
  const entry = (suitePath: string[], name: string, modifiers: string[] = ['each']) => ({
    id: stableId('T', { file: FILE, suitePath, name }),
    file: FILE,
    suitePath,
    name,
    modifiers,
  });

  it('credits each row of it.each and of a template table to the test that registers it (Vitest)', () => {
    const v4 = entry(['convertIPv4ToBinary'], 'Should throw for invalid IPv4: %s');
    const v6 = entry(['convertIPv6ToBinary'], 'Should throw for invalid IPv6: %s');
    const table = entry(['convertIPv4ToString'], 'convertIPv4ToString($input) === $expected');
    const index = new TestNameIndex([v4, v6, table], ' > ');

    expect(
      mutatorTestId(
        `${FILE}#[main] convertIPv4ToBinary > Should throw for invalid IPv4: 01.2.3.4`,
        ' > ',
        index,
      ),
    ).toBe(v4.id);
    expect(
      mutatorTestId(`${FILE}#convertIPv6ToBinary > Should throw for invalid IPv6: fe80::1%`, ' > ', index),
    ).toBe(v6.id);
    expect(
      mutatorTestId(`${FILE}#convertIPv4ToString > convertIPv4ToString(0.0.0.1) === 0.0.0.1`, ' > ', index),
    ).toBe(table.id);
    expect(index.ambiguous.size).toBe(0);
  });

  it('expands describe.each titles in the suite path, nested', () => {
    const nested = entry(['parse %s', 'with $mode'], 'returns %d');
    const index = new TestNameIndex([nested], ' > ');

    expect(mutatorTestId(`${FILE}#parse json > with strict > returns 1`, ' > ', index)).toBe(nested.id);
    expect(mutatorTestId(`${FILE}#parse json > returns 1`, ' > ', index)).not.toBe(nested.id);
  });

  it('matches only tests of the same file, and only tests that are table-driven', () => {
    const plain = entry(['suite'], 'handles %s', []);
    const index = new TestNameIndex([plain], ' > ');

    expect(mutatorTestId(`${FILE}#suite > handles x`, ' > ', index)).not.toBe(plain.id);
    expect(mutatorTestId(`${FILE}#suite > handles %s`, ' > ', index)).toBe(plain.id);

    const each = entry(['suite'], 'handles %s');
    expect(
      mutatorTestId(`other.test.ts#suite > handles x`, ' > ', new TestNameIndex([each], ' > ')),
    ).not.toBe(each.id);
  });

  it('resolves Jest names joined with a space', () => {
    const row = entry(['shippingFee', 'at %s'], 'costs $fee');
    const index = new TestNameIndex([row], ' ');

    expect(mutatorTestId(`${FILE}#shippingFee at the threshold costs 0`, ' ', index, false)).toBe(row.id);
  });

  it('prefers an exact name over a template', () => {
    const literal = entry(['suite'], 'handles null', []);
    const template = entry(['suite'], 'handles %s');
    const index = new TestNameIndex([template, literal], ' > ');

    expect(mutatorTestId(`${FILE}#suite > handles null`, ' > ', index)).toBe(literal.id);
    expect(mutatorTestId(`${FILE}#suite > handles 1`, ' > ', index)).toBe(template.id);
  });

  it('credits no test when a name matches the templates of two tests, and says which name', () => {
    const a = entry(['suite'], '%s works');
    const b = entry(['suite'], 'it %s');
    const index = new TestNameIndex([a, b], ' > ');
    const id = mutatorTestId(`${FILE}#suite > it works`, ' > ', index);

    expect([a.id, b.id]).not.toContain(id);
    expect([...index.ambiguous]).toEqual([`${FILE}#suite > it works`]);
    expect(mutatorTestId(`${FILE}#suite > x works`, ' > ', index)).toBe(a.id);
  });
});
