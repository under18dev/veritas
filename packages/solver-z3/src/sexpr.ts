export type SExpr = string | SExpr[];

/** Minimal S-expression reader for solver output (atoms, lists, quoted symbols and strings). */
export function parseSExprs(text: string): SExpr[] {
  const tokens = text.match(/\(|\)|"(?:[^"]|"")*"|\|[^|]*\||[^\s()"|]+/g) ?? [];
  let i = 0;
  const read = (): SExpr => {
    const token = tokens[i++];
    if (token === undefined) throw new Error('unexpected end of solver output');
    if (token === ')') throw new Error('unexpected ) in solver output');
    if (token !== '(') return token;
    const list: SExpr[] = [];
    while (tokens[i] !== ')') {
      if (i >= tokens.length) throw new Error('unbalanced ( in solver output');
      list.push(read());
    }
    i++;
    return list;
  };
  const out: SExpr[] = [];
  while (i < tokens.length) out.push(read());
  return out;
}

const unquote = (s: string) => (s.startsWith('|') && s.endsWith('|') ? s.slice(1, -1) : s);

/** Convert a model value (`5`, `(- 5)`, `true`) to a decimal string or boolean. */
export function modelValue(value: SExpr): string | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] === '-' &&
    typeof value[1] === 'string' &&
    /^\d+$/.test(value[1])
  ) {
    return `-${value[1]}`;
  }
  throw new Error(`unsupported model value: ${JSON.stringify(value)}`);
}

export function parseGetValue(list: SExpr): Record<string, string | boolean> {
  if (!Array.isArray(list)) throw new Error('get-value output is not a list');
  const out: Record<string, string | boolean> = {};
  for (const pair of list) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string')
      throw new Error('malformed get-value pair');
    out[unquote(pair[0])] = modelValue(pair[1] as SExpr);
  }
  return out;
}
