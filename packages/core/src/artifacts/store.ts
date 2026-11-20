import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { VeritasError } from '../exit-codes.js';
import { canonicalJson, hashValue, sha256 } from '../hash.js';
import { resolveInsideRoot } from '../paths.js';
import { DEFAULT_ENV_ALLOWLIST } from '../process.js';
import { redact, redactDeep } from '../redact.js';
import { logEvent } from '../run-context.js';
import { ArtifactMeta, SCHEMA_VERSION } from '../schema/common.js';
import { TOOL_VERSION } from '../version.js';

export const RUNS_DIR = path.join('.veritas', 'runs');
/** Run-relative name of the index that gives raw (non-envelope) artifacts their metadata and content hash. */
export const ARTIFACT_INDEX_FILE = 'artifact-index.json';

/**
 * Raw artifacts (solver input/output, Lean sources, rendered reports, files written by external tools) cannot hold
 * an envelope themselves. Each is listed here with its SHA-256, and the index's envelope carries the run metadata.
 */
export const ArtifactIndex = z.array(
  z.object({
    path: z.string().min(1),
    kind: z.enum(['text', 'external']),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
    createdAt: z.iso.datetime({ offset: true }),
  }),
);
export type ArtifactIndex = z.infer<typeof ArtifactIndex>;
export const CACHE_DIR = path.join('.veritas', 'cache');

export interface Envelope<T> {
  meta: ArtifactMeta;
  data: T;
}

export function gitCommit(root: string): string | null {
  // Like every child process, git gets only the allowlisted environment, never tokens or other secrets.
  return gitOutput(root, ['rev-parse', 'HEAD'])?.trim() || null;
}

/** Write atomically (temp file + rename) so readers never see a half-written artifact. */
function writeAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/** Persists the artifacts of one run under `.veritas/runs/<run-id>/`, each wrapped with traceability metadata. */
export class RunStore {
  readonly dir: string;
  private readonly baseMeta: Omit<ArtifactMeta, 'createdAt'>;
  private readonly rawArtifacts = new Map<string, ArtifactIndex[number]>();

  constructor(
    readonly root: string,
    readonly runId: string,
    context: { configHash: string; sourceHash: string; gitCommit?: string | null },
  ) {
    this.dir = resolveInsideRoot(root, path.join(RUNS_DIR, runId));
    this.baseMeta = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      toolVersion: TOOL_VERSION,
      gitCommit: context.gitCommit === undefined ? gitCommit(root) : context.gitCommit,
      configHash: context.configHash,
      sourceHash: context.sourceHash,
    };
    mkdirSync(this.dir, { recursive: true });
  }

  meta(): ArtifactMeta {
    return { ...this.baseMeta, createdAt: new Date().toISOString() };
  }

  /** Validate against `schema`, redact secrets, wrap in an envelope and write. Returns the run-relative path. */
  write<S extends z.ZodType>(name: string, schema: S, data: z.input<S>): string {
    const parsed = schema.safeParse(data);

    if (!parsed.success) {
      throw new VeritasError(
        'tool',
        'ARTIFACT_INVALID',
        `artifact ${name} does not match its schema`,
        undefined,
        parsed.error.issues,
      );
    }
    const file = this.pathFor(name);
    const envelope: Envelope<unknown> = { meta: this.meta(), data: redactDeep(parsed.data) };
    writeAtomic(file, `${JSON.stringify(envelope, null, 2)}\n`);

    return path.relative(this.dir, file).split(path.sep).join('/');
  }

  /** Raw text artifacts such as solver input/output or logs. Secrets are always redacted. */
  writeText(name: string, content: string): string {
    const file = this.pathFor(name);
    const redacted = redact(content);
    writeAtomic(file, redacted);
    const relative = path.relative(this.dir, file).split(path.sep).join('/');
    this.index(relative, 'text', Buffer.from(redacted));

    return relative;
  }

  /**
   * Record files that an external tool wrote under `dir` (run-relative) in the artifact index, so they carry the
   * run metadata and a content hash like every other artifact. Returns the run-relative paths recorded.
   */
  recordExternal(dir: string): string[] {
    const base = this.pathFor(dir);
    const recorded: string[] = [];
    const walk = (current: string) => {
      let entries: import('node:fs').Dirent[];

      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const abs = path.join(current, entry.name);

        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile()) {
          const relative = path.relative(this.dir, abs).split(path.sep).join('/');
          this.rawArtifacts.set(relative, {
            path: relative,
            kind: 'external',
            sha256: sha256(readFileSync(abs)),
            bytes: statSync(abs).size,
            createdAt: new Date().toISOString(),
          });
          recorded.push(relative);
        }
      }
    };
    walk(base);

    if (recorded.length) this.writeIndex();

    return recorded.sort();
  }

  private index(relative: string, kind: 'text' | 'external', content: Buffer): void {
    this.rawArtifacts.set(relative, {
      path: relative,
      kind,
      sha256: sha256(content),
      bytes: content.length,
      createdAt: new Date().toISOString(),
    });
    this.writeIndex();
  }

  private writeIndex(): void {
    const entries = [...this.rawArtifacts.values()].sort((a, b) => a.path.localeCompare(b.path));
    this.write(ARTIFACT_INDEX_FILE, ArtifactIndex, entries);
  }

  read<S extends z.ZodType>(name: string, schema: S): Envelope<z.output<S>> {
    return readEnvelope(this.pathFor(name), schema);
  }

  pathFor(name: string): string {
    return resolveInsideRoot(this.dir, name);
  }
}

/** Upgrades an envelope written with an older schema version by exactly one version step. */
export interface Migration {
  from: string;
  to: string;
  migrate(envelope: { meta: Record<string, unknown>; data: unknown }): {
    meta: Record<string, unknown>;
    data: unknown;
  };
}

/** Registered migrations, oldest first. Empty while only one schema version exists. */
export const MIGRATIONS: Migration[] = [];

export function readEnvelope<S extends z.ZodType>(
  file: string,
  schema: S,
  migrations: Migration[] = MIGRATIONS,
): Envelope<z.output<S>> {
  let raw: { meta?: Record<string, unknown>; data?: unknown };

  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new VeritasError(
      'tool',
      'ARTIFACT_UNREADABLE',
      `cannot read artifact ${file}: ${(error as Error).message}`,
    );
  }
  let envelope = { meta: raw.meta ?? {}, data: raw.data };
  const seen = new Set<string>();

  while (envelope.meta.schemaVersion !== SCHEMA_VERSION) {
    const version = String(envelope.meta.schemaVersion ?? 'none');
    const step = migrations.find((m) => m.from === version);

    if (!step || seen.has(version)) {
      throw new VeritasError(
        'user',
        'ARTIFACT_SCHEMA_VERSION',
        `artifact ${file} has schema version ${version}, expected ${SCHEMA_VERSION}, and no migration is available`,
        'rerun the stage that produced it',
      );
    }
    seen.add(version);
    envelope = step.migrate(envelope);
    envelope.meta = { ...envelope.meta, schemaVersion: step.to };
  }
  const meta = ArtifactMeta.safeParse(envelope.meta);

  if (!meta.success) {
    throw new VeritasError(
      'tool',
      'ARTIFACT_META_INVALID',
      `artifact ${file} has incomplete metadata`,
      undefined,
      meta.error.issues,
    );
  }
  const parsed = schema.safeParse(envelope.data);

  if (!parsed.success) {
    throw new VeritasError(
      'tool',
      'ARTIFACT_INVALID',
      `artifact ${file} does not match its schema`,
      undefined,
      parsed.error.issues,
    );
  }

  return { meta: meta.data, data: parsed.data };
}

/** Run IDs under `.veritas/runs`, newest first. */
export function listRuns(root: string): string[] {
  try {
    return readdirSync(path.join(root, RUNS_DIR), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('run-'))
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function finished(runDir: string): boolean {
  try {
    const index = JSON.parse(readFileSync(path.join(runDir, ARTIFACT_INDEX_FILE), 'utf8')) as {
      data?: { path?: unknown }[];
    };

    return Array.isArray(index.data) && index.data.some((entry) => entry.path === 'trace.jsonl');
  } catch {
    return false;
  }
}

const RUN_ID = /^run-\d{8}T\d{9}Z-\d{3}-[0-9a-f]{6}$/;

/**
 * Remove run directories under `.veritas/runs` beyond the `keep` newest, never `current`. Only finished runs are
 * removed: real directories named like a run ID whose artifact index already lists `trace.jsonl`, which a run writes
 * last (after run.json and the reports; the index is replaced atomically after it), so a run still in progress in
 * another process is left alone. Links and anything else stay. Returns the removed run IDs.
 */
export function pruneRuns(root: string, keep: number, current: string): string[] {
  const dir = path.join(root, RUNS_DIR);
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        RUN_ID.test(entry.name) &&
        finished(path.join(dir, entry.name)),
    )
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const kept = new Set([current, ...runs.filter((id) => id !== current).slice(0, Math.max(0, keep - 1))]);
  const removed: string[] = [];
  for (const id of runs) {
    if (kept.has(id)) continue;
    rmSync(resolveInsideRoot(root, path.join(RUNS_DIR, id)), { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}

/**
 * Content-addressed cache. The key must include every input that can change the result
 * (sources, dependency versions, config, model, scope); callers pass them all in `keyParts`.
 */
export class ContentCache {
  private readonly dir: string;

  /**
   * `secret` authenticates entries (HMAC-SHA256 over namespace, key and value). It is kept outside the project
   * (see `openCache`), so an entry placed in `.veritas/cache` by anything else is a miss, not a result.
   */
  constructor(
    root: string,
    private readonly secret: Buffer,
  ) {
    this.dir = resolveInsideRoot(root, CACHE_DIR);
  }

  private mac(namespace: string, key: string, value: unknown): string {
    return createHmac('sha256', this.secret)
      .update(`${namespace}\0${key}\0${canonicalJson(value)}`)
      .digest('hex');
  }

  key(keyParts: Record<string, unknown>): string {
    return hashValue({ toolVersion: TOOL_VERSION, schemaVersion: SCHEMA_VERSION, ...keyParts });
  }

  /** The entry for `key`, or undefined when there is none or it does not match `schema` (a miss, never an error). */
  get<S extends z.ZodType>(namespace: string, key: string, schema: S): z.output<S> | undefined {
    const value = this.lookup(namespace, key, schema);
    logEvent('debug', `cache ${value === undefined ? 'miss' : 'hit'} ${namespace}/${key.slice(0, 12)}`, {
      event: 'cache',
      namespace,
      key,
      hit: value !== undefined,
    });

    return value;
  }

  private lookup<S extends z.ZodType>(namespace: string, key: string, schema: S): z.output<S> | undefined {
    try {
      const entry = JSON.parse(readFileSync(this.file(namespace, key), 'utf8')) as {
        mac?: unknown;
        value?: unknown;
      };

      if (typeof entry.mac !== 'string' || !/^[0-9a-f]{64}$/.test(entry.mac)) return undefined;
      const expected = Buffer.from(this.mac(namespace, key, entry.value), 'hex');

      if (!timingSafeEqual(Buffer.from(entry.mac, 'hex'), expected)) return undefined;
      const parsed = schema.safeParse(entry.value);

      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  set(namespace: string, key: string, value: unknown): void {
    const stored = JSON.parse(JSON.stringify(redactDeep(value))) as unknown;
    writeAtomic(
      this.file(namespace, key),
      JSON.stringify({ mac: this.mac(namespace, key, stored), value: stored }),
    );
  }

  private file(namespace: string, key: string): string {
    if (!/^[a-z0-9-]+$/.test(namespace) || !/^[0-9a-f]{64}$/.test(key)) {
      throw new VeritasError(
        'tool',
        'CACHE_KEY_INVALID',
        `invalid cache namespace or key: ${namespace}/${key}`,
      );
    }

    return path.join(this.dir, namespace, key.slice(0, 2), `${key}.json`);
  }
}

/**
 * The project's cache, or null with the reason when it must not be used: disabled by `cache.enabled`, or
 * `.veritas/cache` is tracked by git. Committed entries could come from anyone with write access to the
 * repository (a pull request, for example) and forge results, so a tracked cache is ignored entirely.
 */
export function openCache(
  root: string,
  config: { cache: { enabled: boolean } },
  env: NodeJS.ProcessEnv = process.env,
): { cache: ContentCache | null; message: string | null } {
  if (!config.cache.enabled) return { cache: null, message: 'cache: disabled by configuration' };

  if (gitOutput(root, ['ls-files', '--', CACHE_DIR.split(path.sep).join('/')])?.trim()) {
    return {
      cache: null,
      message: 'cache: ignored because .veritas/cache is tracked by git (committed entries are not trusted)',
    };
  }
  const secret = cacheSecret(env);

  if (!secret) return { cache: null, message: 'cache: disabled because no cache key could be created' };

  return { cache: new ContentCache(root, secret), message: null };
}

/**
 * Where the cache key lives: `VERITAS_CACHE_KEY_FILE`, else the user's cache directory (`$XDG_CACHE_HOME` or
 * `~/.cache` on POSIX, `%LOCALAPPDATA%` on Windows) under `veritas/cache-key`. Never inside a project.
 */
export function cacheKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VERITAS_CACHE_KEY_FILE) return path.resolve(env.VERITAS_CACHE_KEY_FILE);
  const base =
    process.platform === 'win32'
      ? env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
      : env.XDG_CACHE_HOME || path.join(env.HOME || homedir(), '.cache');

  return path.join(base, 'veritas', 'cache-key');
}

/** The 32-byte cache key, created (mode 0600) on first use; null when it can be neither read nor created. */
function cacheSecret(env: NodeJS.ProcessEnv): Buffer | null {
  const file = cacheKeyFile(env);

  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Exclusive create: when two processes race, both end up using the key that was written first.
    writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
  }

  try {
    // A key others can read could sign forged entries: tighten it to 0600, or do without a cache.
    if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);

    if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) return null;
    const secret = readFileSync(file);

    return secret.length === 32 ? secret : null;
  } catch {
    return null;
  }
}

/** Output of a git command run with the allowlisted environment, or null when git fails. */
export function gitOutput(root: string, args: string[]): string | null {
  try {
    const env = Object.fromEntries(
      DEFAULT_ENV_ALLOWLIST.flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
    );

    return execFileSync('git', args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch {
    return null;
  }
}

export function hashFiles(files: { path: string; content: string | Uint8Array }[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  return hashValue(sorted.map((f) => [f.path, sha256(f.content)]));
}
