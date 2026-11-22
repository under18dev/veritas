import { stableId } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { compileTitleTemplate, matchesTitleTemplate, mutatorTestId, TestNameIndex } from '../src/index.js';

const matches = (template: string, name: string): boolean =>
  matchesTitleTemplate(compileTitleTemplate(template), name);

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
    expect(matches('pretty %p', 'pretty ')).toBe(false);
  });

  it('lets %s and $key print an empty string, and the other conversions at least one character', () => {
    expect(matches('Should throw for invalid IPv4: %s', 'Should throw for invalid IPv4: ')).toBe(true);
    expect(matches('rejects <%s>', 'rejects <>')).toBe(true);
    expect(matches('name <$name>', 'name <>')).toBe(true);
    expect(matches('%s%s!', '!')).toBe(true);
    expect(matches('%s', '')).toBe(true);
    for (const conversion of ['%d', '%i', '%f', '%j', '%o', '%O', '%p'])
      expect(matches(`<${conversion}>`, '<>'), conversion).toBe(false);
  });

  it('matches the row index of %# and %$, and reads %% as a literal percent', () => {
    expect(matches('case %#', 'case 0')).toBe(true);
    expect(matches('case %#', 'case 12')).toBe(true);
    expect(matches('case %$: %s', 'case 1: a')).toBe(true);
    // The row index is digits only.
    expect(matches('case %#', 'case missing')).toBe(false);
    expect(matches('case %$', 'case ')).toBe(false);
    expect(matches('case %#', 'case -1')).toBe(false);
    expect(matches('100%% of %s', '100% of x')).toBe(true);
    expect(matches('100%% of %s', '100%% of x')).toBe(false);
    // A title with escapes only is reported with them resolved.
    expect(compileTitleTemplate('100%% sure').placeholders).toBe(0);
    expect(matches('100%% sure', '100% sure')).toBe(true);
    expect(matches('100%% sure', '100%% sure')).toBe(false);
    expect(compileTitleTemplate('50% off, 10%').placeholders).toBe(0);
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
    expect(compileTitleTemplate('costs 5$').placeholders).toBe(0);
  });

  it('reads interpolated keys with Unicode identifier characters, as Vitest does', () => {
    expect(matches('価格は$金額です', '価格は500です')).toBe(true);
    expect(matches('$número items', '3 items')).toBe(true);
    expect(matches('$a𝑥 done', '1 done')).toBe(true);
    expect(matches('$número items', '3 número items')).toBe(true);
    expect(matches('$número items', '3 items!')).toBe(false);
  });

  it('treats regular expression characters literally', () => {
    expect(matches('a.b (%s) [x]* ^$', 'a.b (1) [x]* ^$')).toBe(true);
    expect(matches('a.b (%s)', 'aXb (1)')).toBe(false);
  });

  it('lets a placeholder stand for its own text, which the runner keeps when it has no value', () => {
    expect(matches('%s and %s', '1 and %s')).toBe(true);
    expect(matches('with $missing', 'with $missing')).toBe(true);
  });

  it('needs a character for each adjacent placeholder that always prints one', () => {
    expect(matches('%d%d!', '12!')).toBe(true);
    expect(matches('%d%d!', '1!')).toBe(false);
    expect(matches('%d%s!', '1!')).toBe(true);
  });

  it('places literals leftmost, so a value that contains the next literal still matches', () => {
    expect(matches('%s, then %s, end', 'a, then b, then c, end')).toBe(true);
    expect(matches('%d, then %d', 'x, then ')).toBe(false);
  });

  it('matches long names without catastrophic backtracking', () => {
    const template = compileTitleTemplate(`${'%s a'.repeat(30)}!`);
    // A regular expression of 30 `(.+) a` groups would backtrack through every split of this name.
    const name = `${'x a'.repeat(28)}${'x'.repeat(5000)} a!`;
    const started = performance.now();

    expect(template && matchesTitleTemplate(template, name)).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('resolves many names against many templates of one file in seconds', () => {
    const file = 'test/big.test.ts';
    const tests = Array.from({ length: 2000 }, (_, i) => ({
      id: `T-${i}`,
      file,
      // Half differ in their literal prefix, half share it and differ in their literal suffix.
      suitePath: i % 2 === 0 ? [`suite ${i}`] : ['suite'],
      name: i % 2 === 0 ? 'case %s' : `%s case ${i}`,
      modifiers: ['each'],
      tableTitles: [1],
    }));
    const index = new TestNameIndex(tests, ' > ');
    const started = performance.now();
    let credited = 0;

    for (let j = 0; j < 20000; j++) {
      const i = j % 2000;
      const full = i % 2 === 0 ? `suite ${i} > case row ${j}` : `suite > row ${j} case ${i}`;

      if (mutatorTestId(`${file}#${full}`, ' > ', index) === `T-${i}`) credited++;
    }

    expect(credited).toBe(20000);
    // About half a second on a laptop; the bound only catches a return to checking every template.
    expect(performance.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it('resolves names against many templates that share their prefix and suffix, by an inner literal', () => {
    const file = 'test/big.test.ts';
    const tests = Array.from({ length: 2000 }, (_, i) => ({
      id: `T-${i}`,
      file,
      suitePath: ['suite %s'],
      name: `case ${i} %s with %s and %s`,
      modifiers: ['each'],
      tableTitles: [0, 1],
    }));
    const index = new TestNameIndex(tests, ' > ');
    const started = performance.now();
    let credited = 0;

    for (let j = 0; j < 20000; j++) {
      const i = j % 2000;

      if (mutatorTestId(`${file}#suite x${j} > case ${i} a with b and c`, ' > ', index) === `T-${i}`)
        credited++;
    }

    expect(credited).toBe(20000);
    // A few seconds even under load; checking every template took minutes.
    expect(performance.now() - started).toBeLessThan(60_000);
  }, 120_000);
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
    expect(index.withheld.size).toBe(0);
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

  it("credits no test when a name is one test's title and fits the template of another", () => {
    const literal = entry([], 'case 1', []);
    const template = entry([], 'case %s');
    const index = new TestNameIndex([template, literal], ' > ');
    const id = mutatorTestId(`${FILE}#case 1`, ' > ', index);

    expect([literal.id, template.id]).not.toContain(id);
    expect([...index.withheld]).toEqual([[`${FILE}#case 1`, { kind: 'exact_and_template' }]]);
    expect(mutatorTestId(`${FILE}#case 2`, ' > ', index)).toBe(template.id);
  });

  it('credits an exact name next to a broad template whose placeholders would have to span titles (Vitest)', () => {
    const broad = entry([], '$name');
    const bare = entry([], '%s');
    const literal = entry(['threshold'], 'is free at 5000', []);
    const index = new TestNameIndex([broad, bare, literal], ' > ');
    index.observe([`${FILE}#small order`, `${FILE}#threshold > is free at 5000`]);

    expect(mutatorTestId(`${FILE}#[main] threshold > is free at 5000`, ' > ', index)).toBe(literal.id);
    expect(index.withheld.size).toBe(0);
  });

  it('credits no test with an exact name a broad template may share', () => {
    const broad = entry([], '$name');
    const literal = entry(['threshold'], 'is free at 5000', []);
    const name = `${FILE}#threshold > is free at 5000`;

    // mutator reported the name twice.
    const twice = new TestNameIndex([broad, literal], ' > ');
    twice.observe([name, `${name}#2`]);
    expect(mutatorTestId(name, ' > ', twice)).not.toBe(literal.id);
    expect(twice.withheld.get(name)).toEqual({ kind: 'exact_and_template' });

    // The exact test may not have run.
    const conditional = new TestNameIndex([broad, { ...literal, conditional: true as const }], ' > ');
    expect([literal.id, broad.id]).not.toContain(mutatorTestId(name, ' > ', conditional));
    // A skipped exact test did not run, so the name is the template's.
    const skipped = new TestNameIndex([broad, { ...literal, modifiers: ['skip'] }], ' > ');
    expect(mutatorTestId(name, ' > ', skipped)).toBe(broad.id);
    const only = new TestNameIndex([broad, literal, entry([], 'focused', ['only'])], ' > ');
    expect(mutatorTestId(name, ' > ', only)).not.toBe(literal.id);

    // Jest joins titles with a space, so a placeholder may stand for any of them.
    const jest = new TestNameIndex([broad, literal], ' ');
    expect(mutatorTestId(`${FILE}#threshold is free at 5000`, ' ', jest, false)).not.toBe(literal.id);
    expect(jest.withheld.get(`${FILE}#threshold is free at 5000`)).toEqual({ kind: 'exact_and_template' });
  });

  it('matches no template in a file that calls a function which may register tests', () => {
    const each = entry([], '$name');
    const index = new TestNameIndex([each], ' > ', [{ path: FILE, inexactNames: 'open_collection' }]);

    expect(mutatorTestId(`${FILE}#is free at 5000`, ' > ', index)).not.toBe(each.id);
    expect(index.withheld.get(`${FILE}#is free at 5000`)).toEqual({
      kind: 'inexact_file',
      because: 'open_collection',
    });
  });

  it("credits an exact name when no other test's template fits it", () => {
    const literal = entry(['suite'], 'handles null', []);
    const template = entry(['other'], 'handles %s');
    const index = new TestNameIndex([template, literal], ' > ');

    expect(mutatorTestId(`${FILE}#suite > handles null`, ' > ', index)).toBe(literal.id);
    expect(mutatorTestId(`${FILE}#other > handles %s`, ' > ', index)).toBe(template.id);
    expect(index.withheld.size).toBe(0);
  });

  it("resolves mutator's numbered copies of a shared name through that name", () => {
    const template = entry([], 'case %s');
    const literal = entry([], 'case 1', []);
    const rows = new TestNameIndex([template], ' > ');
    rows.observe([`${FILE}#case 1`, `${FILE}#case 1#2`]);

    // Two rows of one template may format to the same name.
    expect(mutatorTestId(`${FILE}#case 1#2`, ' > ', rows)).toBe(template.id);

    const both = new TestNameIndex([template, literal], ' > ');
    both.observe([`${FILE}#case 1`, `${FILE}#case 1#2`]);
    expect([template.id, literal.id]).not.toContain(mutatorTestId(`${FILE}#case 1#2`, ' > ', both));
    expect(both.withheld.get(`${FILE}#case 1#2`)).toEqual({ kind: 'exact_and_template' });

    // A title that really ends in #2 is still found exactly.
    const issue = entry([], 'fixes #2', []);
    expect(mutatorTestId(`${FILE}#fixes #2`, ' > ', new TestNameIndex([issue], ' > '))).toBe(issue.id);
  });

  it('credits no test with a shared name in a file where some full name was not read', () => {
    const literal = entry([], 'fee for 5000', []);
    const loop = { ...entry([], '<dynamic test>', []), granularity: 'suite' as const };
    const index = new TestNameIndex([literal, loop], ' > ');
    index.observe([`${FILE}#fee for 5000`, `${FILE}#fee for 5000#2`, `${FILE}#fee for 4999`]);

    for (const name of ['fee for 5000', 'fee for 5000#2']) {
      expect(mutatorTestId(`${FILE}#${name}`, ' > ', index)).not.toBe(literal.id);
      expect(index.withheld.get(`${FILE}#${name}`)).toEqual({
        kind: 'inexact_file',
        because: 'dynamic_title',
      });
    }
    // A name only one test has is still credited when a test has it exactly.
    const alone = new TestNameIndex([literal, loop], ' > ');
    alone.observe([`${FILE}#fee for 5000`, `${FILE}#fee for 4999`]);
    expect(mutatorTestId(`${FILE}#fee for 5000`, ' > ', alone)).toBe(literal.id);
  });

  it('takes no template of a skipped or todo registration as a candidate', () => {
    const plain = entry([], 'case 1', []);

    for (const modifiers of [
      ['each', 'skip'],
      ['each', 'todo'],
    ]) {
      const index = new TestNameIndex([entry([], 'case %s', modifiers), plain], ' > ');
      expect(mutatorTestId(`${FILE}#case 1`, ' > ', index), modifiers.join()).toBe(plain.id);
      expect(index.withheld.size).toBe(0);
    }
    // In a describe.skip, the inherited skip counts too.
    const inSkipped = { ...entry(['rows %s'], 'case 1', ['each', 'skip']), tableTitles: [0] };
    const literal = entry(['rows a'], 'case 1', []);
    expect(
      mutatorTestId(`${FILE}#rows a > case 1`, ' > ', new TestNameIndex([inSkipped, literal], ' > ')),
    ).toBe(literal.id);
    // A name only a skipped test has, with no running template to fit, came from a test not seen.
    for (const modifiers of [['skip'], ['todo']]) {
      const lone = new TestNameIndex([entry([], 'case 1', modifiers)], ' > ');
      expect(mutatorTestId(`${FILE}#case 1`, ' > ', lone)).not.toBe(entry([], 'case 1').id);
      expect(lone.withheld.get(`${FILE}#case 1`)).toEqual({ kind: 'skipped_exact' });
    }
    // skipIf and runIf may have run: the template stays a candidate.
    const conditional = { ...entry([], 'case %s'), conditional: true as const };
    const index = new TestNameIndex([conditional, plain], ' > ');
    expect([conditional.id, plain.id]).not.toContain(mutatorTestId(`${FILE}#case 1`, ' > ', index));
  });

  it('takes no template of an unfocused test as a candidate next to a focused test that surely runs', () => {
    const focused = entry([], 'case 1', ['only']);
    const rows = entry([], 'case %s');
    const index = new TestNameIndex([focused, rows], ' > ');

    expect(mutatorTestId(`${FILE}#case 1`, ' > ', index)).toBe(focused.id);
    expect(index.withheld.size).toBe(0);
    // A focused test registered on a condition may not run, and then the others run: the template stays.
    const conditional = new TestNameIndex([{ ...focused, conditional: true as const }, rows], ' > ');
    expect([focused.id, rows.id]).not.toContain(mutatorTestId(`${FILE}#case 1`, ' > ', conditional));
    // A test whose options cannot be read may be focused: no test of its file counts as unfocused.
    const unknownOptions = {
      ...entry([], 'handles empty', []),
      conditional: true as const,
      optionsUnknown: true as const,
    };
    const focusedHandles = entry([], 'handles %s', ['each', 'only']);
    const withUnknown = new TestNameIndex([unknownOptions, focusedHandles], ' > ');
    expect([unknownOptions.id, focusedHandles.id]).not.toContain(
      mutatorTestId(`${FILE}#handles empty`, ' > ', withUnknown),
    );
    // A focused template next to an unfocused test is credited too.
    const focusedRows = entry([], 'case %s', ['each', 'only']);
    const plain = entry([], 'case 2', []);
    expect(mutatorTestId(`${FILE}#case 2`, ' > ', new TestNameIndex([focusedRows, plain], ' > '))).toBe(
      focusedRows.id,
    );
  });

  it('lets an unfocused conditional test not stop a focused test from focusing its file', () => {
    // `const cases = [1]; it.only('case 1'); it.each(cases)('case %s')`: the table cannot focus the file.
    const focused = entry([], 'case 1', ['only']);
    const rows = { ...entry([], 'case %s'), conditional: true as const };
    const index = new TestNameIndex([focused, rows], ' > ');

    expect(mutatorTestId(`${FILE}#case 1`, ' > ', index)).toBe(focused.id);
    expect(index.withheld.size).toBe(0);
  });

  it('keeps a skipped table out of the candidates even when its table may be empty', () => {
    // `it.skip.each(cases)('case %s')`: conditional because of the table, and skipped all the same.
    const rows = { ...entry([], 'case %s', ['each', 'skip']), conditional: true as const };
    const plain = entry([], 'case 1', []);

    expect(mutatorTestId(`${FILE}#case 1`, ' > ', new TestNameIndex([rows, plain], ' > '))).toBe(plain.id);
  });

  it('takes a skipped test whose options could not be read as one that may run', () => {
    // `it.skip('case 1', opts, fn)` with `opts = { only: true }` runs: `only` beats `skip`.
    const rows = entry([], 'case %s');
    const maybeFocused = {
      ...entry([], 'case 1', ['skip']),
      conditional: true as const,
      optionsUnknown: true as const,
    };
    const index = new TestNameIndex([rows, maybeFocused], ' > ');

    expect([rows.id, maybeFocused.id]).not.toContain(mutatorTestId(`${FILE}#case 1`, ' > ', index));
  });

  it('takes a test that is both focused and skipped as one that may run', () => {
    // Vitest gives `only` precedence: `it('case 1', { skip: true, only: true })` runs, and focuses the file.
    const rows = entry([], 'case %s');
    const both = entry([], 'case 1', ['skip', 'only']);
    const index = new TestNameIndex([rows, both], ' > ');

    expect([rows.id, both.id]).not.toContain(mutatorTestId(`${FILE}#case 1`, ' > ', index));
    expect(mutatorTestId(`${FILE}#case 2`, ' > ', index)).not.toBe(both.id);
    // `todo` with `only` too; and such a test establishes no focus over the plain test next to it.
    const todoOnly = entry([], 'later', ['todo', 'only']);
    const works = entry([], 'works', []);
    expect(mutatorTestId(`${FILE}#works`, ' > ', new TestNameIndex([todoOnly, works], ' > '))).toBe(works.id);
  });

  it('takes a focused table that may be empty as no guarantee of focus', () => {
    // `it.only.each([])('row %s')` registers nothing: the inventory records it as conditional.
    const emptyRows = { ...entry([], 'row %s', ['each', 'only']), conditional: true as const };
    const works = entry([], 'works', []);

    expect(mutatorTestId(`${FILE}#works`, ' > ', new TestNameIndex([emptyRows, works], ' > '))).toBe(
      works.id,
    );
  });

  it('takes a .only registered inside a function as no guarantee of focus', () => {
    const inFunction = { ...entry([], 'never', ['only']), inexactName: 'registered_in_function' as const };
    const works = entry([], 'works', []);

    expect(mutatorTestId(`${FILE}#works`, ' > ', new TestNameIndex([inFunction, works], ' > '))).toBe(
      works.id,
    );
  });

  it('reads backslashes in the file part of reported names as mutatorTestId does', () => {
    const rows = entry([], 'case %s');
    const literal = entry([], 'case 1', []);
    const index = new TestNameIndex([rows, literal], ' > ');
    const windows = FILE.replaceAll('/', '\\');
    index.observe([`${windows}#case 1`, `${windows}#case 1#2`]);

    expect([rows.id, literal.id]).not.toContain(mutatorTestId(`${windows}#case 1#2`, ' > ', index));
    expect(index.withheld.get(`${FILE}#case 1#2`)).toEqual({ kind: 'exact_and_template' });
  });

  it('credits an empty row value to its template', () => {
    const empty = entry([], 'rejects <%s>');
    const index = new TestNameIndex([empty], ' > ');

    expect(mutatorTestId(`${FILE}#rejects <>`, ' > ', index)).toBe(empty.id);
  });

  it('reads placeholders only in the titles the runner formats', () => {
    // Two plain suites, one titled with a literal `%s`, each with an it.each.
    const literal = { ...entry(['parse %s'], 'value %d'), tableTitles: [1] };
    const json = { ...entry(['parse json'], 'value %d'), tableTitles: [1] };
    const index = new TestNameIndex([literal, json], ' > ');

    expect(mutatorTestId(`${FILE}#parse json > value 1`, ' > ', index)).toBe(json.id);
    expect(mutatorTestId(`${FILE}#parse %s > value 1`, ' > ', index)).toBe(literal.id);
    expect(index.withheld.size).toBe(0);

    // A describe.each title is formatted too.
    const nested = { ...entry(['parse %s'], 'value 1'), tableTitles: [0] };
    expect(mutatorTestId(`${FILE}#parse xml > value 1`, ' > ', new TestNameIndex([nested], ' > '))).toBe(
      nested.id,
    );
  });

  it('resolves a table-driven title with escapes only, and credits no other template with it', () => {
    const sure = entry([], '100%% sure');
    const index = new TestNameIndex([sure], ' > ');
    expect(mutatorTestId(`${FILE}#100% sure`, ' > ', index)).toBe(sure.id);

    const broad = entry([], '100%% %s');
    const both = new TestNameIndex([sure, broad], ' > ');
    expect([sure.id, broad.id]).not.toContain(mutatorTestId(`${FILE}#100% sure`, ' > ', both));
    expect(both.withheld.get(`${FILE}#100% sure`)).toEqual({ kind: 'templates' });
  });

  it('reads a #2 suffix as part of the title when no second run of the name is possible', () => {
    const suffixed = entry([], 'case %s#2');
    const literal = entry([], 'case x', []);
    const index = new TestNameIndex([suffixed, literal], ' > ');
    index.observe([`${FILE}#case x`, `${FILE}#case x#2`]);

    expect(mutatorTestId(`${FILE}#case x#2`, ' > ', index)).toBe(suffixed.id);
    expect(mutatorTestId(`${FILE}#case x`, ' > ', index)).toBe(literal.id);
    expect(index.withheld.size).toBe(0);

    // Without the unnumbered name in the report, the suffix is not mutator's.
    const alone = new TestNameIndex([entry([], 'case %s')], ' > ');
    alone.observe([`${FILE}#case x#2`]);
    expect(mutatorTestId(`${FILE}#case x#2`, ' > ', alone)).toBe(entry([], 'case %s').id);
  });

  it('credits no test with a title ending in #2 when a second run of the shorter name is possible', () => {
    const rows = { ...entry(['suite %s'], 'works'), tableTitles: [0] };
    const literal = { ...entry(['suite 1'], 'works#2', []), conditional: true as const };
    const index = new TestNameIndex([rows, literal], ' > ');
    index.observe([`${FILE}#suite 1 > works`, `${FILE}#suite 1 > works#2`]);

    expect([rows.id, literal.id]).not.toContain(mutatorTestId(`${FILE}#suite 1 > works#2`, ' > ', index));
    expect(index.withheld.get(`${FILE}#suite 1 > works#2`)).toEqual({ kind: 'exact_and_template' });

    // With no second run of `suite 1 > works` possible, the title is the test's.
    const once = new TestNameIndex([entry(['suite 1'], 'works', []), literal], ' > ');
    once.observe([`${FILE}#suite 1 > works`, `${FILE}#suite 1 > works#2`]);
    expect(mutatorTestId(`${FILE}#suite 1 > works#2`, ' > ', once)).toBe(literal.id);
  });

  it('does not take a plain name for a row index', () => {
    const indexed = entry([], 'case %#');
    const plain = entry([], 'case missing', []);
    const index = new TestNameIndex([indexed, plain], ' > ');

    expect(mutatorTestId(`${FILE}#case missing`, ' > ', index)).toBe(plain.id);
    expect(mutatorTestId(`${FILE}#case 0`, ' > ', index)).toBe(indexed.id);
  });

  it('matches no template in a file with a test whose title is not a literal', () => {
    const each = entry([], 'fee for %s');
    const loop = { ...entry([], '<dynamic test>', []), granularity: 'suite' as const };
    const index = new TestNameIndex([each, loop], ' > ');

    for (const name of ['fee for 5000', 'fee for 4999']) {
      expect(mutatorTestId(`${FILE}#${name}`, ' > ', index)).not.toBe(each.id);
      expect(index.withheld.get(`${FILE}#${name}`)).toEqual({
        kind: 'inexact_file',
        because: 'dynamic_title',
      });
    }
    // A name no template fits is left as it was, with no warning.
    expect(mutatorTestId(`${FILE}#other`, ' > ', index)).not.toBe(each.id);
    expect(index.withheld.has(`${FILE}#other`)).toBe(false);
  });

  it('matches no template in a file with a describe whose title is not a literal', () => {
    const each = entry(['%s'], 'works');
    const dynamic = { ...entry([], 'works', []), inexactName: 'dynamic_suite' as const };
    const index = new TestNameIndex([each, dynamic], ' > ');

    expect([each.id, dynamic.id]).not.toContain(mutatorTestId(`${FILE}#dyn 1 > works`, ' > ', index));
    expect(index.withheld.get(`${FILE}#dyn 1 > works`)).toEqual({
      kind: 'inexact_file',
      because: 'dynamic_suite',
    });
  });

  it('matches no template in a file with a test registered inside a function', () => {
    const each = entry([], '%s');
    const shared = { ...entry([], 'works', []), inexactName: 'registered_in_function' as const };
    const index = new TestNameIndex([each, shared], ' ');

    expect([each.id, shared.id]).not.toContain(mutatorTestId(`${FILE}#suite works`, ' ', index, false));
    // Templates of other files still match.
    const elsewhere = { ...entry([], 'fee for %s'), file: 'other.test.ts', id: 'T-other' };
    const other = new TestNameIndex([elsewhere, shared], ' ');
    expect(mutatorTestId('other.test.ts#fee for 1', ' ', other, false)).toBe('T-other');
  });

  it('credits no test when a name matches the templates of two tests, and says which name', () => {
    const a = entry(['suite'], '%s works');
    const b = entry(['suite'], 'it %s');
    const index = new TestNameIndex([a, b], ' > ');
    const id = mutatorTestId(`${FILE}#suite > it works`, ' > ', index);

    expect([a.id, b.id]).not.toContain(id);
    expect([...index.withheld]).toEqual([[`${FILE}#suite > it works`, { kind: 'templates' }]]);
    expect(mutatorTestId(`${FILE}#suite > x works`, ' > ', index)).toBe(a.id);
  });
});
