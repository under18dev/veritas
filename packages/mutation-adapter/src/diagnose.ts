import path from 'node:path';

/** Terminal color and cursor sequences, which Vite and oxc print even into a pipe. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
/** A stack frame line. */
const STACK_FRAME = /^\s+at /;
/** Lines that usually say what went wrong, kept first when an output has to be shortened. */
const INFORMATIVE =
  /\[[A-Z][A-Z_]*\]|\b\w*Error\b|^\s*(Plugin|File):|\bin \S+\.[cm]?[jt]sx? at \d|^tests fail without mutants/;
/** `MUTATOR 123: /abs/a.test.ts: message`, what NODE_DEBUG=mutator prints for a test file that failed to load. */
const DEBUG_LINE = /^MUTATOR \d+: (.+?\.[cm]?[jt]sx?): (.*)$/;
/** Lines that continue the error message of a debug line, before its stack trace. */
const DEBUG_DETAIL = /^(\s|$|\[[A-Z][A-Z_]*\]|\S*Error\b|Plugin:|File:|-\s)/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * A bounded excerpt of an error output for a message: without colors, stack frames, blank and repeated lines.
 * When it is too long, the first line and the informative lines (`[PARSE_ERROR] …`, `Error: …`, `File: …`) are
 * kept, in their order, and the text is cut at the end: the head of an error says what it is.
 */
export function errorExcerpt(text: string, maxLines = 15, maxChars = 2000): string {
  const seen = new Set<string>();
  const lines = stripAnsi(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => {
      if (line.trim() === '' || STACK_FRAME.test(line) || seen.has(line)) return false;
      seen.add(line);

      return true;
    });
  let kept = lines;

  if (lines.length > maxLines) {
    const picked = new Set<number>([0]);

    for (let i = 0; i < lines.length && picked.size < maxLines; i++)
      if (INFORMATIVE.test(lines[i] as string)) picked.add(i);

    for (let i = 0; i < lines.length && picked.size < maxLines; i++) picked.add(i);
    kept = [...picked].sort((a, b) => a - b).map((i) => lines[i] as string);
  }
  const excerpt = kept.length > 0 ? kept.join('\n') : stripAnsi(text).trim();

  return excerpt.length > maxChars ? `${excerpt.slice(0, maxChars)}…` : excerpt;
}

interface DebugBlock {
  file: string;
  message: string;
  /** The lines after the debug line up to its stack trace. */
  detail: string[];
}

/** Split stderr into mutator's own output and the debug blocks NODE_DEBUG=mutator interleaves with it. */
function splitDebug(stderr: string): { own: string; blocks: DebugBlock[] } {
  const own: string[] = [];
  const blocks: DebugBlock[] = [];
  let block: DebugBlock | null = null;
  let sawStack = false;

  for (const line of stripAnsi(stderr).split('\n')) {
    const debug = DEBUG_LINE.exec(line);

    if (debug || /^MUTATOR \d+: /.test(line)) {
      block = { file: debug?.[1] ?? '', message: debug?.[2] ?? line, detail: [] };
      blocks.push(block);
      sawStack = false;
      continue;
    }

    if (block) {
      if (STACK_FRAME.test(line)) {
        sawStack = true;
        continue;
      }

      if (!sawStack && DEBUG_DETAIL.test(line)) {
        block.detail.push(line);
        continue;
      }
      block = null;
    }
    own.push(line);
  }

  return { own: own.join('\n'), blocks };
}

/** mutator's own output, without the debug lines and the error messages and stack traces that follow them. */
export function withoutDebug(stderr: string): string {
  return splitDebug(stderr).own;
}

/**
 * What a failed baseline says: mutator's summary (which tests fail), then the first reason a test file failed to
 * load, which mutator prints only on its debug channel and which is usually the cause (`Cannot find module …`,
 * or a transform error with the file and position it names).
 */
export function baselineFailure(stderr: string, root: string): string {
  const { own, blocks } = splitDebug(stderr);
  const summary = errorExcerpt(own);
  const first = blocks.find((b) => b.file !== '');

  if (!first) return summary;
  // Project-relative with `/`, as the other paths in the detail.
  const file = (path.isAbsolute(first.file) ? path.relative(root, first.file) : first.file)
    .split(path.sep)
    .join('/');
  const message = first.message.length > 300 ? `${first.message.slice(0, 300)}…` : first.message;
  const detail = errorExcerpt(
    first.detail.filter((line) => line.trim() !== `Error: ${first.message}`.trim()).join('\n'),
    6,
    600,
  );

  return `${summary}\nfirst error: ${file}: ${message}${detail === '' ? '' : `\n${detail.replace(/^[ \t]*/gm, '  ')}`}`;
}
