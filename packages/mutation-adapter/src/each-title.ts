/**
 * Titles of table-driven tests (`it.each`, `test.for`, `describe.each`). The test inventory records a title as written
 * (`returns %s for $input`), while the runner reports each row under the title it formats from that template
 * (`returns 1 for 2`). A template is compiled into literal parts with placeholders between them, and a reported name
 * matches when its text fits: the literal parts in order, each placeholder taking at least one character.
 *
 * Placeholders, as Vitest and Jest format them: printf-style `%s %d %i %f %j %o %O %p %#` and `%$` (`%%` is a literal
 * `%`; `%c` prints nothing), and the object and template-table interpolation `$name`, `$name.path`, `$0` and `$#`.
 * Every placeholder may also stand for its own text, which the runners leave in place when there is no value for it.
 */

/** A compiled title template: `literals[0]`, then for each `k` a placeholder of at least `mins[k]` characters followed by `literals[k + 1]`. */
export interface TitleTemplate {
  readonly literals: readonly string[];
  readonly mins: readonly number[];
}

/** printf conversions that print their value (at least one character for anything they format). */
const PRINTF = new Set(['s', 'd', 'i', 'f', 'j', 'o', 'O', 'p', '#', '$']);
/**
 * Characters of an interpolated key after `$` (`$name.path`, `$0`, `$$x`, `$número`), as Vitest reads them
 * (`/\$([$\p{ID_Continue}.]+)/u`). Jest reads keys differently in places: a key with other characters (`$a-b`) or a
 * value that formats to nothing makes a name this reading does not match. That only leaves a kill uncredited; it
 * never credits a test the runner did not name.
 */
const KEY = /^[$\p{ID_Continue}.]$/u;

/** The length in UTF-16 units of the key character at `at`, or 0 when there is none. */
function keyChar(template: string, at: number): number {
  const code = template.codePointAt(at);

  if (code === undefined) return 0;
  const char = String.fromCodePoint(code);

  return KEY.test(char) ? char.length : 0;
}

/**
 * Compile a title template; undefined when it has no placeholder, so that only an exact name can match it. Runs in
 * one pass over the template and builds no regular expression.
 */
export function compileTitleTemplate(template: string): TitleTemplate | undefined {
  const literals: string[] = [];
  const mins: number[] = [];
  let literal = '';
  let open: number | undefined;
  const placeholder = (min: number) => {
    if (open !== undefined && literal === '') {
      mins[mins.length - 1] = (mins.at(-1) ?? 0) + min;
    } else {
      literals.push(literal);
      mins.push(min);
    }
    literal = '';
    open = mins.length;
  };

  for (let i = 0; i < template.length; ) {
    const char = template[i] as string;
    const next = template[i + 1];

    if (char === '%' && next !== undefined) {
      if (next === '%') {
        literal += '%';
        i += 2;
        continue;
      }

      if (PRINTF.has(next) || next === 'c') {
        placeholder(next === 'c' ? 0 : 1);
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
      placeholder(1);
      i = end;
      continue;
    }
    literal += char;
    i++;
  }

  if (mins.length === 0) return undefined;
  literals.push(literal);

  return { literals, mins };
}

/**
 * Whether `name` is a title `template` formats to. Each literal part is taken at the leftmost place it fits after the
 * placeholder before it, which decides a match of this shape (literals and placeholders of a minimum length, no other
 * constraint) in time linear in the name for each literal, with no backtracking.
 */
export function matchesTitleTemplate(template: TitleTemplate, name: string): boolean {
  const { literals, mins } = template;
  const first = literals[0] ?? '';
  const last = literals.at(-1) ?? '';

  if (!name.startsWith(first)) return false;
  const end = name.length - last.length;

  if (end < first.length || !name.endsWith(last)) return false;
  let at = first.length;

  for (let k = 0; k < mins.length - 1; k++) {
    at += mins[k] ?? 0;
    const part = literals[k + 1] ?? '';
    const found = name.indexOf(part, at);

    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }

  return end - at >= (mins.at(-1) ?? 0);
}
