/**
 * Titles of table-driven tests (`it.each`, `test.for`, `describe.each`). The test inventory records a title as written
 * (`returns %s for $input`), while the runner reports each row under the title it formats from that template
 * (`returns 1 for 2`). A template is compiled into a sequence of literal characters and placeholders, and a reported
 * name matches when its text fits.
 *
 * Placeholders, as Vitest and Jest format them: printf-style `%s %d %i %f %j %o %O %p %c` and the row numbers `%#`
 * and `%$` (`%%` is a literal `%`), and the object and template-table interpolation `$name`, `$name.path`, `$0`,
 * `$a-b` (Jest) and `$#`, read up to the next whitespace or `|`. What each can print:
 * - `%s` and `$name` print a string as it is, so they may print nothing (`''`);
 * - `%#` and `%$` print the row index (from 0 and from 1): digits only, the first of each; Jest replaces only the
 *   first, so a later one may stay as its own text;
 * - `%o` and `%O` may print nothing too (a value whose custom inspection returns `''`);
 * - every other conversion prints at least one character (`NaN`, `''` in quotes, `undefined`).
 * A placeholder may also stay as its own text: Jest leaves the placeholders after the row's last value in place
 * (`it.each([[1]])('case %s %c')` reports `case 1 %c`), so `%c` prints nothing or `%c`, and is read as any text.
 *
 * Jest interpolates `$key` with any key of a row object, spaces included (`$first name` for a key `first name`
 * reports `Ada`): with `'object_key'` keys (see `TitleKeys`), a key may take in the literal text after it, up to the
 * next placeholder, so that text is read as part of what the key prints. This holds as long as a key holds no regular
 * expression syntax (Jest builds a `RegExp` from it) and runs into no placeholder.
 */

/**
 * How the runner reads a `$key` in a title: `'identifier'` up to the next whitespace or `|` (Vitest), or
 * `'object_key'` as any key of the row object, spaces included (Jest).
 */
export type TitleKeys = 'identifier' | 'object_key';

/** One step of a compiled title: a literal character, or text a placeholder prints. */
type Token =
  | { readonly kind: 'char'; readonly char: string }
  /** A character, or nothing. */
  | { readonly kind: 'maybe'; readonly char: string }
  /** Any one character. */
  | { readonly kind: 'one' }
  /** Any text, possibly none. */
  | { readonly kind: 'any' }
  /** One decimal digit. */
  | { readonly kind: 'digit' }
  /** Decimal digits, possibly none. */
  | { readonly kind: 'digits' };

/** A compiled title: what a name must consist of, in order. `placeholders` counts its placeholders. */
export interface TitleTemplate {
  readonly tokens: readonly Token[];
  readonly placeholders: number;
  /** It has `%c`, which is read as any text (nothing, or `%c` left in place). */
  readonly styled?: boolean;
  /** It repeats `%#` or `%$`, which Jest formats only partly: what it reports is read less exactly. */
  readonly repeatedIndex?: boolean;
}

/** printf conversions besides `%s` and `%c`. */
const PRINTF = new Set(['d', 'i', 'f', 'j', 'o', 'O', 'p']);
/** printf conversions that print at least one character for any value. */
const NON_EMPTY = new Set(['d', 'i', 'f', 'j', 'p']);
/**
 * Whether a character may be part of an interpolated key, as either runner may read it: Vitest reads
 * `$[$\p{ID_Continue}.]+`, while Jest reads any key of the row's object (`$a-b` for a column `a-b`) and its `.path`.
 * Anything but whitespace and the `|` of a template table is taken, so that a key is never cut short: what follows
 * a shorter key is covered too, which only lets a name fit more widely.
 */
const keyCharacter = (char: string | undefined): boolean =>
  char !== undefined && !/\s/.test(char) && char !== '|';

const ANY: Token = { kind: 'any' };
const ONE: Token = { kind: 'one' };
const DIGIT: Token = { kind: 'digit' };
const DIGITS: Token = { kind: 'digits' };
/** Literal tokens for each UTF-16 unit of `text`, as names are read. */
const chars = (text: string): Token[] =>
  Array.from({ length: text.length }, (_, i) => ({ kind: 'char', char: text[i] as string }));

/** A title the runner reports as written: every character literal. */
export function literalTitle(text: string): TitleTemplate {
  return { tokens: chars(text), placeholders: 0 };
}

/**
 * Compile a title the runner formats for each row (the title of an `.each`/`.for` test or of a `describe.each`).
 * A title with only escapes (`100%% sure`) compiles to the literal text the runner reports (`100% sure`). Runs in one
 * pass over the template and builds no regular expression.
 */
export function compileTitleTemplate(
  template: string,
  keys: TitleKeys = 'object_key',
  /**
   * The rows come from a tagged template table. Jest formats such a title by its `$` keys only: `%%` stays `%%`, and
   * `%#` and `%$` stay as written. With `'object_key'` keys (Jest, or a runner not known), `%%` is then read as `%` or
   * `%%`, and `%#` and `%$` as their row number or their own text.
   */
  tagged = false,
): TitleTemplate {
  const jestTagged = tagged && keys === 'object_key';
  const tokens: Token[] = [];
  let placeholders = 0;
  // `%#` and `%$` met so far: Jest replaces only the first of each.
  const indexes = new Set<string>();
  // Whether the title interpolates `$` keys (see `keyCharacter`).
  const interpolates = [...template].some((char, k) => char === '$' && keyCharacter(template[k + 1]));
  // Whether the title has a placeholder Jest formats from an array row. Without one, Jest formats an object row by
  // its keys, which leaves `%$` in place.
  const printf = hasPrintfPlaceholder(template);
  let styled = false;
  let repeatedIndex = false;
  let appended = false;

  for (let i = 0; i < template.length; ) {
    const char = template[i] as string;
    const next = template[i + 1];

    if (char === '%' && next !== undefined) {
      if (next === '%') {
        tokens.push({ kind: 'char', char: '%' });

        if (jestTagged) tokens.push({ kind: 'maybe', char: '%' });
        i += 2;
        continue;
      }

      if (next === 's' || next === 'c' || next === '#' || next === '$' || PRINTF.has(next)) {
        if (next === '#' || next === '$') {
          const first = !indexes.has(next);
          indexes.add(next);
          // Jest formats a title with no printf placeholder from an object row, which leaves `%$` in place, with or
          // without `$` keys (`it.each([{ name: 'a' }])('case $name %$')` reports `case a %$`, and
          // `it.each([{ x: 1 }])('case %% %$')` reports `case % %$`); whether the rows are objects is not known.
          const literalToo = !first || jestTagged || (next === '$' && (interpolates || !printf));
          tokens.push(...(literalToo ? [ONE, ANY] : [DIGIT, DIGITS]));

          if (!first) repeatedIndex = true;

          // A second `%#` is not one of `util.format`'s placeholders, so Jest appends the row's values after the title.
          if (!first && next === '#') appended = true;
        } else if (next === 's' || next === 'c') {
          tokens.push(ANY);

          if (next === 'c') styled = true;
        } else if (NON_EMPTY.has(next)) tokens.push(ONE, ANY);
        // `%o` and `%O`: a custom inspection may print nothing.
        else tokens.push(ANY);
        placeholders++;
        i += 2;
        continue;
      }
    }

    if (char === '$' && keyCharacter(next)) {
      let end = i + 1;

      while (keyCharacter(template[end])) end++;

      // A Jest key may go on past whitespace (`$first name`): the literal text up to the next placeholder may be
      // part of it.
      if (keys === 'object_key')
        while (end < template.length && !placeholderAt(template, end))
          end += template.startsWith('%%', end) ? 2 : 1;
      // A key (or Jest's `$#`, literal text in Vitest) may print anything, an empty string included.
      tokens.push(ANY);
      placeholders++;
      i = end;
      continue;
    }
    tokens.push({ kind: 'char', char });
    i++;
  }

  // `each([[5]])('r %# %# end')` is reported `r 0 %# end 5`.
  if (appended) tokens.push(ANY);

  return { tokens, placeholders, styled, repeatedIndex };
}

/** Whether a placeholder (not `%%`) starts at `i`: a conversion, `%#`, `%$`, or a `$` key. */
function placeholderAt(template: string, i: number): boolean {
  const char = template[i];
  const next = template[i + 1];

  if (char === '$') return keyCharacter(next);

  return (
    char === '%' &&
    next !== undefined &&
    (next === 's' || next === 'c' || next === '#' || next === '$' || PRINTF.has(next))
  );
}

/** Whether a title has a placeholder Jest formats from an array row (`%s %d %i %f %j %o %O %p %#`). */
function hasPrintfPlaceholder(template: string): boolean {
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== '%') continue;
    const next = template[i + 1];

    if (next === '%') i++;
    else if (next !== undefined && (next === 's' || next === '#' || PRINTF.has(next))) return true;
  }

  return false;
}

/** Titles joined into one full name with the runner's separator between them. */
export function joinTitles(titles: readonly TitleTemplate[], separator: string): TitleTemplate {
  const tokens: Token[] = [];

  titles.forEach((title, k) => {
    if (k > 0) tokens.push(...chars(separator));
    tokens.push(...title.tokens);
  });

  return {
    tokens,
    placeholders: titles.reduce((sum, title) => sum + title.placeholders, 0),
    styled: titles.some((title) => title.styled),
    repeatedIndex: titles.some((title) => title.repeatedIndex),
  };
}

const isDigit = (char: string) => char >= '0' && char <= '9';

/** What a template's name must start and end with, and how long it must be at least. */
interface Shape {
  /** The literal characters before the first placeholder, and after the last. */
  prefix: string;
  suffix: string;
  /** Tokens between them, which the automaton runs. */
  middle: readonly Token[];
  /** The runs of literal characters inside the middle, in order: a name must contain each after the one before. */
  literals: readonly string[];
  min: number;
}

const shapes = new WeakMap<TitleTemplate, Shape>();

function literalRuns(tokens: readonly Token[]): string[] {
  const runs: string[] = [];
  let run = '';

  for (const token of tokens) {
    if (token.kind === 'char') run += token.char;
    else if (run) {
      runs.push(run);
      run = '';
    }
  }

  if (run) runs.push(run);

  return runs;
}

function shapeOf(template: TitleTemplate): Shape {
  let shape = shapes.get(template);

  if (shape) return shape;
  const { tokens } = template;
  let start = 0;
  let end = tokens.length;

  while (start < end && tokens[start]?.kind === 'char') start++;

  while (end > start && tokens[end - 1]?.kind === 'char') end--;
  const text = (from: number, to: number) =>
    tokens
      .slice(from, to)
      .map((token) => (token.kind === 'char' ? token.char : ''))
      .join('');
  shape = {
    prefix: text(0, start),
    suffix: text(end, tokens.length),
    middle: tokens.slice(start, end),
    literals: literalRuns(tokens.slice(start, end)),
    min: tokens.filter((token) => token.kind === 'char' || token.kind === 'one' || token.kind === 'digit')
      .length,
  };
  shapes.set(template, shape);

  return shape;
}

/** The automaton's state sets, reused from call to call (matching is synchronous). */
let current = new Uint8Array(64);
let following = new Uint8Array(64);

/**
 * Whether `name` is a title `template` formats to. A name shorter than the template allows, or without its literal
 * prefix and suffix, is rejected at once; what is between them is run as a nondeterministic automaton over the name,
 * all of its states at once, so the time is the name's length times the template's, with no backtracking.
 */
export function matchesTitleTemplate(template: TitleTemplate, name: string): boolean {
  const { prefix, suffix, middle, min, literals } = shapeOf(template);

  if (name.length < min || !name.startsWith(prefix) || !name.endsWith(suffix)) return false;
  const from = prefix.length;
  const to = name.length - suffix.length;

  if (to < from) return false;
  // A quick necessary test before the automaton: the literal runs in order (each placeholder may print nothing).
  let at = from;

  for (const literal of literals) {
    const found = name.indexOf(literal, at);

    if (found < 0 || found + literal.length > to) return false;
    at = found + literal.length;
  }
  const size = middle.length;

  if (current.length < size + 1) {
    current = new Uint8Array((size + 1) * 2);
    following = new Uint8Array((size + 1) * 2);
  }
  let states = current;
  let next = following;
  const close = (set: Uint8Array) => {
    // A token that may match nothing (`any`, `digits`) lets the state after it start where it starts.
    for (let k = 0; k < size; k++)
      if (
        set[k] &&
        (middle[k]?.kind === 'any' || middle[k]?.kind === 'digits' || middle[k]?.kind === 'maybe')
      )
        set[k + 1] = 1;
  };
  states.fill(0, 0, size + 1);
  states[0] = 1;
  close(states);

  for (let at = from; at < to; at++) {
    const char = name[at] as string;
    let alive = false;
    next.fill(0, 0, size + 1);

    for (let k = 0; k < size; k++) {
      if (!states[k]) continue;
      const token = middle[k] as Token;

      switch (token.kind) {
        case 'char':
          if (token.char === char) {
            next[k + 1] = 1;
            alive = true;
          }
          break;
        case 'maybe':
          if (token.char === char) {
            next[k + 1] = 1;
            alive = true;
          }
          break;
        case 'one':
          next[k + 1] = 1;
          alive = true;
          break;
        case 'any':
          next[k] = 1;
          alive = true;
          break;
        case 'digit':
          if (isDigit(char)) {
            next[k + 1] = 1;
            alive = true;
          }
          break;
        case 'digits':
          if (isDigit(char)) {
            next[k] = 1;
            alive = true;
          }
          break;
      }
    }

    if (!alive) return false;
    close(next);
    [states, next] = [next, states];
  }

  return states[size] === 1;
}

/** How many characters of a template's literal prefix and suffix `TemplateSet` indexes by. */
const TRIE_DEPTH = 32;

interface Trie<V> {
  readonly children: Map<string, Trie<V>>;
  readonly values: V[];
}

const trie = <V>(): Trie<V> => ({ children: new Map(), values: [] });

/** Add `value` under the first (or, `fromEnd`, the last) `TRIE_DEPTH` characters of `key`; return its node. */
function nodeFor<V>(root: Trie<V>, key: string, fromEnd: boolean): Trie<V> {
  let node = root;

  for (let k = 0; k < Math.min(key.length, TRIE_DEPTH); k++) {
    const char = key[fromEnd ? key.length - 1 - k : k] as string;
    let child = node.children.get(char);

    if (!child) {
      child = trie();
      node.children.set(char, child);
    }
    node = child;
  }

  return node;
}

/** Visit the nodes whose keys `text` starts (or, `fromEnd`, ends) with, shortest first. */
function* along<V>(root: Trie<V>, text: string, fromEnd: boolean): Generator<Trie<V>> {
  let node: Trie<V> | undefined = root;

  for (let k = 0; node; k++) {
    yield node;

    if (k >= Math.min(text.length, TRIE_DEPTH)) return;
    node = node.children.get(text[fromEnd ? text.length - 1 - k : k] as string);
  }
}

/**
 * Templates with a value each, indexed by their literal prefix and then their literal suffix, so that a name is
 * checked only against templates whose prefix it starts with and whose suffix it ends with (up to `TRIE_DEPTH`
 * characters of each, then fully by `matchesTitleTemplate`).
 */
export class TemplateSet<T> {
  private readonly root = trie<Trie<Bucket<T>>>();

  add(template: TitleTemplate, value: T): void {
    const { prefix, suffix, literals } = shapeOf(template);
    const byPrefix = nodeFor(this.root, prefix, false);
    let suffixes = byPrefix.values[0];

    if (!suffixes) {
      suffixes = trie();
      byPrefix.values.push(suffixes);
    }
    const node = nodeFor(suffixes, suffix, true);
    let bucket = node.values[0];

    if (!bucket) {
      bucket = { plain: [], byKey: new Map() };
      node.values.push(bucket);
    }
    const entry = { template, value };
    const first = literals[0];

    if (first === undefined) {
      bucket.plain.push(entry);
      return;
    }
    // Indexed by the start of the first literal inside the template, which the name must contain somewhere.
    const size = Math.min(first.length, KEY_LENGTH);
    const keys = bucket.byKey.get(size) ?? new Map<string, Entry<T>[]>();
    const key = first.slice(0, size);
    keys.set(key, [...(keys.get(key) ?? []), entry]);
    bucket.byKey.set(size, keys);
  }

  /** The values of the templates `name` fits. */
  matching(name: string): T[] {
    const found: T[] = [];

    for (const byPrefix of along(this.root, name, false))
      for (const suffixes of byPrefix.values)
        for (const bySuffix of along(suffixes, name, true))
          for (const bucket of bySuffix.values) {
            const entries = new Set(bucket.plain);

            for (const [size, keys] of bucket.byKey)
              for (let at = 0; at + size <= name.length; at++)
                for (const entry of keys.get(name.slice(at, at + size)) ?? []) entries.add(entry);

            for (const { template, value } of entries)
              if (matchesTitleTemplate(template, name)) found.push(value);
          }

    return found;
  }
}

/** How many characters of a template's first inner literal `TemplateSet` indexes by. */
const KEY_LENGTH = 64;

interface Entry<T> {
  template: TitleTemplate;
  value: T;
}

/** Templates with one literal prefix and suffix: those with an inner literal by its start, the others as they are. */
interface Bucket<T> {
  plain: Entry<T>[];
  byKey: Map<number, Map<string, Entry<T>[]>>;
}
