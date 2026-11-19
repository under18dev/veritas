/**
 * Redact secrets before anything is written to an artifact, report or log.
 * Patterns cover common token formats plus values of environment variables that look secret.
 */
const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"']{6,}/gi,
];

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;

export const REDACTED = '[REDACTED]';

function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_ENV.test(name)) values.push(value);
  }
  return values;
}

function redactWith(text: string, secrets: string[]): string {
  let out = text;
  for (const value of secrets) if (out.includes(value)) out = out.split(value).join(REDACTED);
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return redactWith(text, secretValues(env));
}

/** Redact every string inside a JSON-like value. Secret environment values are collected once per call. */
export function redactDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  const secrets = secretValues(env);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactWith(v, secrets);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
