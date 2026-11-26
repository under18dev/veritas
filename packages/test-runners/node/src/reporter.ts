// A reporter for `node --test` (`--test-reporter=<this file>`) that writes one JSON document: every test and suite
// that ended, with the titles of the suites and tests around it. Node.js loads it in the process that runs the test
// files, so it imports nothing and uses only syntax Node.js can strip types from.

/** What the reporter writes; `run.ts` reads it. */
export interface NodeTestReport {
  /** Tests and suites in the order they ended. */
  tests: {
    /** The file the test is in, as Node.js reports it (absolute), or null. */
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
  skip?: unknown;
  todo?: unknown;
  success?: boolean;
  details?: { type?: string; error?: { failureType?: string; message?: string; cause?: unknown } };
}

function errorMessage(error: NonNullable<EventData['details']>['error']): string | null {
  if (!error) return null;
  const cause = error.cause as { message?: unknown } | string | undefined;

  if (typeof cause === 'string') return cause;

  if (cause && typeof cause.message === 'string') return cause.message;

  return typeof error.message === 'string' ? error.message : null;
}

function where(data: EventData): string {
  return [data.file ?? '', data.line ?? '', data.column ?? '', data.nesting ?? 0, data.name ?? ''].join('\0');
}

export default async function* nodeTestReporter(
  source: AsyncIterable<{ type: string; data?: EventData }>,
): AsyncGenerator<string> {
  const report: NodeTestReport = { tests: [], success: null };
  // Per file, the titles of the tests started last at each nesting level; and the ancestors of each test as they
  // were when it started (its own end comes after its subtests').
  const stacks = new Map<string, string[]>();
  const ancestry = new Map<string, string[]>();

  for await (const event of source) {
    const data = event.data ?? {};
    const nesting = data.nesting ?? 0;

    if (event.type === 'test:start') {
      const stack = stacks.get(data.file ?? '') ?? [];
      stack.length = nesting;
      ancestry.set(where(data), stack.slice());
      stack.push(data.name ?? '');
      stacks.set(data.file ?? '', stack);
    } else if (event.type === 'test:pass' || event.type === 'test:fail') {
      const ancestors = ancestry.get(where(data)) ?? (stacks.get(data.file ?? '') ?? []).slice(0, nesting);
      const failed = event.type === 'test:fail';
      const error = data.details?.error;

      report.tests.push({
        file: data.file ?? null,
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
        message: failed ? errorMessage(error) : null,
      });
    } else if (event.type === 'test:summary' && data.file === undefined) {
      // The summary of the whole run comes last; one per file comes before it.
      report.success = data.success ?? null;
    }
  }

  yield `${JSON.stringify(report)}\n`;
}
