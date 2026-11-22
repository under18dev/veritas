/**
 * Titles of table-driven tests (`it.each`, `test.for`, `describe.each`). The test inventory records a title as written
 * (`returns %s for $input`), while the runner reports each row under the title it formats from that template
 * (`returns 1 for 2`). A template is compiled into a sequence of literal characters and placeholders, and a reported
 * name matches when its text fits.
 *
 * Placeholders, as Vitest and Jest format them: printf-style `%s %d %i %f %j %o %O %p %c` and the row numbers `%#`
 * and `%$` (`%%` is a literal `%`), and the object and template-table interpolation `$name`, `$name.path`, `$0` and
 * `$#`. What each can print:
 * - `%s` and `$name` print a string as it is, so they may print nothing (`''`); `%c` always prints nothing;
 * - `%#` and `%$` print the row index (from 0 and from 1): digits only;
 * - every other conversion prints at least one character (`NaN`, `''` in quotes, `undefined`).
 * A placeholder other than `%#`, `%$` and `%c` may also stand for its own text, which the runners leave in place when
 * there is no value for it.
 */

/** One step of a compiled title: a literal character, or text a placeholder prints. */
type Token =
  | { readonly kind: 'char'; readonly char: string }
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
}

/** printf conversions that print at least one character for any value. */
const PRINTF = new Set(['d', 'i', 'f', 'j', 'o', 'O', 'p']);
/**
 * Characters of an interpolated key after `$` (`$name.path`, `$0`, `$$x`, `$número`), as Vitest reads them
 * (`/\$([$\p{ID_Continue}.]+)/u`). Jest reads keys differently in places: a key with other characters (`$a-b`) makes
 * a name this reading does not match. That only leaves a kill uncredited; it never credits a test the runner did not
 * name.
 */
const KEY = /^[$\p{ID_Continue}.]$/u;

/** The length in UTF-16 units of the key character at `at`, or 0 when there is none. */
function keyChar(template: string, at: number): number {
  const code = template.codePointAt(at);

  if (code === undefined) return 0;
  const char = String.fromCodePoint(code);

  return KEY.test(char) ? char.length : 0;
}

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
export function compileTitleTemplate(template: string): TitleTemplate {
  const tokens: Token[] = [];
  let placeholders = 0;

  for (let i = 0; i < template.length; ) {
    const char = template[i] as string;
    const next = template[i + 1];

    if (char === '%' && next !== undefined) {
      if (next === '%') {
        tokens.push({ kind: 'char', char: '%' });
        i += 2;
        continue;
      }

      if (next === 's' || next === 'c' || next === '#' || next === '$' || PRINTF.has(next)) {
        if (next === '#' || next === '$') tokens.push(DIGIT, DIGITS);
        else if (next === 's') tokens.push(ANY);
        else if (next !== 'c') tokens.push(ONE, ANY);
        placeholders++;
        i += 2;
        continue;
      }
    }

    if (char === '$' && next !== undefined && (next === '#' || keyChar(template, i + 1) > 0)) {
      let end = i + 2;

      if (next !== '#') {
        end = i + 1;

        for (let step = keyChar(template, end); step > 0; step = keyChar(template, end)) end += step;
      }
      // `$#` is Jest's row index, and literal text in Vitest; a key may print an empty string.
      tokens.push(...(next === '#' ? [ONE, ANY] : [ANY]));
      placeholders++;
      i = end;
      continue;
    }
    tokens.push({ kind: 'char', char });
    i++;
  }

  return { tokens, placeholders };
}

/** Titles joined into one full name with the runner's separator between them. */
export function joinTitles(titles: readonly TitleTemplate[], separator: string): TitleTemplate {
  const tokens: Token[] = [];

  titles.forEach((title, k) => {
    if (k > 0) tokens.push(...chars(separator));
    tokens.push(...title.tokens);
  });

  return { tokens, placeholders: titles.reduce((sum, title) => sum + title.placeholders, 0) };
}

const isDigit = (char: string) => char >= '0' && char <= '9';

/**
 * Whether `name` is a title `template` formats to. The template is run as a nondeterministic automaton over the
 * name, all of its states at once, so the time is the name's length times the template's, with no backtracking.
 */
export function matchesTitleTemplate(template: TitleTemplate, name: string): boolean {
  const { tokens } = template;
  const size = tokens.length;
  let states = new Uint8Array(size + 1);
  const close = (set: Uint8Array) => {
    // A token that may match nothing (`any`, `digits`) lets the state after it start where it starts.
    for (let k = 0; k < size; k++)
      if (set[k] && (tokens[k]?.kind === 'any' || tokens[k]?.kind === 'digits')) set[k + 1] = 1;
  };
  states[0] = 1;
  close(states);

  for (let at = 0; at < name.length; at++) {
    const char = name[at] as string;
    const next = new Uint8Array(size + 1);
    let alive = false;

    for (let k = 0; k < size; k++) {
      if (!states[k]) continue;
      const token = tokens[k] as Token;

      switch (token.kind) {
        case 'char':
          if (token.char === char) next[k + 1] = 1;
          break;
        case 'one':
          next[k + 1] = 1;
          break;
        case 'any':
          next[k] = 1;
          break;
        case 'digit':
          if (isDigit(char)) next[k + 1] = 1;
          break;
        case 'digits':
          if (isDigit(char)) next[k] = 1;
          break;
      }
    }
    close(next);

    for (let k = 0; k <= size && !alive; k++) alive = next[k] === 1;

    if (!alive) return false;
    states = next;
  }

  return states[size] === 1;
}
