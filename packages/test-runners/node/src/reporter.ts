// A reporter for `node --test` (`--test-reporter=<this file>`) that writes one JSON document: every test and suite
// that ended, with the titles of the suites and tests around it. Node.js loads it in the process that runs the test
// files, so it imports nothing and uses only syntax Node.js can strip types from.

/** What the reporter writes; `run.ts` reads it. */
export interface NodeTestReport {
  /** Tests and suites in the order they ended. */
  tests: {
    /**
     * The test file whose run the test belongs to (absolute, as Node.js reports it), or null: the file of its top-level
     * test, also for a subtest a helper in another file registers (`t.test` called in an imported function).
     */
    file: string | null;
    /** The titles of the suites and tests it is nested in, outermost first. */
    ancestors: string[];
    name: string;
    /** `suite` for `describe`/`suite`, `test` for a test or subtest. */
    type: 'suite' | 'test';
    status: 'passed' | 'failed' | 'skipped' | 'todo';
    /** Node's `failureType` of a failure (`testCodeFailure`, `subtestsFailed`, `hookFailed`, ...). */
    failureType: string | null;
    message: string | null;
    /**
     * The event may be the one Node.js makes for a test file as a whole (a file that ran no test it could report,
     * or failed outside its tests): it comes from the runner, not from the file's own process, so it has no
     * `entryFile`, and it sits at the start of the file (line 1, column 1). A test the file registers has an
     * `entryFile` (Node.js 24 and later) or the position of its call.
     */
    fileLevel: boolean;
  }[];
  /** Whether Node.js reported the whole run as successful, or null without its summary. */
  success: boolean | null;
}

interface EventData {
  name?: string;
  nesting?: number;
  file?: string;
  line?: number;
  column?: number;
  entryFile?: string;
  skip?: unknown;
  todo?: unknown;
  success?: boolean;
  /** What a test file wrote, for `test:stderr`. */
  message?: unknown;
  details?: { type?: string; error?: { failureType?: string; message?: string; cause?: unknown } };
}

/**
 * What Node.js says of a file's process that failed outside its tests (`cause` of the file's own event): the
 * exception is not in the event, only in what the process wrote to stderr.
 */
const GENERIC_FILE_FAILURE = 'test failed';

/** The first line of an uncaught exception as Node.js prints it (`Error: boom`, `Error [ERR_X]: …`, `SyntaxError: …`). */
const EXCEPTION_LINE = /^(?:[A-Za-z_$][\w$]*)?(?:Error|Exception)(?: \[[A-Z0-9_]+\])?: \S/;

/** At most this many characters of an exception line are kept. */
const MAX_EXCEPTION = 500;

function errorMessage(error: NonNullable<EventData['details']>['error']): string | null {
  if (!error) return null;
  const cause = error.cause as { message?: unknown } | string | undefined;

  if (typeof cause === 'string') return cause;

  if (cause && typeof cause.message === 'string') return cause.message;

  return typeof error.message === 'string' ? error.message : null;
}

/** The event's error message, or for a file that failed as a whole with only Node's generic one, its exception. */
function failureMessage(
  error: NonNullable<EventData['details']>['error'],
  exception: string | undefined,
): string | null {
  const message = errorMessage(error);

  if (exception === undefined || (message !== null && message !== GENERIC_FILE_FAILURE)) return message;

  return `${exception} (${message ?? GENERIC_FILE_FAILURE})`;
}

function where(data: EventData): string {
  return [data.file ?? '', data.line ?? '', data.column ?? '', data.nesting ?? 0, data.name ?? ''].join('\0');
}

export default async function* nodeTestReporter(
  source: AsyncIterable<{ type: string; data?: EventData }>,
): AsyncGenerator<string> {
  const report: NodeTestReport = { tests: [], success: null };
  // Node.js reports the tests of one file after another, each in the order they ran, so the titles started last at
  // each nesting level are the ancestors of what starts next, whatever file registered it. A test ends after its
  // subtests, so what it started under is kept per start (in order, as a helper may register the same subtest under
  // two parents) and taken back at its end.
  const stack: string[] = [];
  let root: string | null = null;
  const started = new Map<string, { ancestors: string[]; file: string | null }[]>();
  // The first exception line each test file's process wrote to stderr, by the file (absolute): what a file that
  // failed outside its tests threw, which its own event does not carry.
  const exceptions = new Map<string, string>();

  for await (const event of source) {
    const data = event.data ?? {};
    const nesting = data.nesting ?? 0;

    if (event.type === 'test:stderr') {
      const file = data.entryFile ?? data.file;
      const text = data.message;

      if (file === undefined || exceptions.has(file) || typeof text !== 'string') continue;
      const line = text.split('\n').find((candidate) => EXCEPTION_LINE.test(candidate));

      if (line !== undefined) exceptions.set(file, line.trim().slice(0, MAX_EXCEPTION));
    } else if (event.type === 'test:start') {
      if (nesting === 0) root = data.file ?? null;
      stack.length = Math.min(stack.length, nesting);
      const queue = started.get(where(data)) ?? [];
      queue.push({ ancestors: Array.from({ length: nesting }, (_, i) => stack[i] ?? ''), file: root });
      started.set(where(data), queue);
      stack[nesting] = data.name ?? '';
    } else if (event.type === 'test:pass' || event.type === 'test:fail') {
      const start = started.get(where(data))?.shift();
      const ancestors = start?.ancestors ?? stack.slice(0, nesting);
      const file = start?.file ?? (nesting === 0 ? (data.file ?? null) : (root ?? data.file ?? null));
      const failed = event.type === 'test:fail';
      const error = data.details?.error;
      const fileLevel =
        nesting === 0 && data.entryFile === undefined && (data.line ?? 1) === 1 && (data.column ?? 1) === 1;
      // Before Node.js 24 the stderr events name the file relative to the working directory only.
      const exception =
        fileLevel && failed && data.file !== undefined
          ? (exceptions.get(data.file) ??
            [...exceptions].find(([written]) =>
              [`/${written}`, `\\${written}`].some((tail) => data.file?.endsWith(tail)),
            )?.[1])
          : undefined;

      report.tests.push({
        file,
        ancestors,
        name: data.name ?? '',
        type: data.details?.type === 'suite' ? 'suite' : 'test',
        // A todo test may fail without failing the run; a skipped one never runs.
        status:
          data.todo !== undefined && data.todo !== false
            ? 'todo'
            : data.skip !== undefined && data.skip !== false
              ? 'skipped'
              : failed
                ? 'failed'
                : 'passed',
        failureType: failed ? (error?.failureType ?? null) : null,
        message: failed ? failureMessage(error, exception) : null,
        fileLevel,
      });
    } else if (event.type === 'test:summary' && data.file === undefined) {
      // The summary of the whole run comes last; one per file comes before it.
      report.success = data.success ?? null;
    }
  }

  yield `${JSON.stringify(report)}\n`;
}
