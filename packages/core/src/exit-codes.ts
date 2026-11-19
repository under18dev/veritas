/** Exit codes shared by the CLI, the GitHub Action and documentation. */
export const ExitCode = {
  Success: 0,
  PolicyFailure: 1,
  UserError: 2,
  ToolError: 3,
  Inconclusive: 4,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrorCategory = 'user' | 'tool' | 'policy' | 'inconclusive';

/** An error carrying the exit code category, a machine-readable code and an actionable hint. */
export class VeritasError extends Error {
  constructor(
    readonly category: ErrorCategory,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'VeritasError';
  }

  get exitCode(): ExitCode {
    return CATEGORY_EXIT[this.category];
  }
}

const CATEGORY_EXIT: Record<ErrorCategory, ExitCode> = {
  user: ExitCode.UserError,
  policy: ExitCode.PolicyFailure,
  inconclusive: ExitCode.Inconclusive,
  tool: ExitCode.ToolError,
};

export function exitCodeFor(error: unknown): ExitCode {
  return error instanceof VeritasError ? error.exitCode : ExitCode.ToolError;
}
