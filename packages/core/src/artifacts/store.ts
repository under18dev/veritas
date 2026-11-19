import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { VeritasError } from '../exit-codes.js';
import { hashValue, sha256 } from '../hash.js';
import { resolveInsideRoot } from '../paths.js';
import { DEFAULT_ENV_ALLOWLIST } from '../process.js';
import { redact, redactDeep } from '../redact.js';
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

/**
 * Content-addressed cache. The key must include every input that can change the result
 * (sources, dependency versions, config, model, scope); callers pass them all in `keyParts`.
 */
export class ContentCache {
  private readonly dir: string;

  constructor(root: string) {
    this.dir = resolveInsideRoot(root, CACHE_DIR);
  }

  key(keyParts: Record<string, unknown>): string {
    return hashValue({ toolVersion: TOOL_VERSION, schemaVersion: SCHEMA_VERSION, ...keyParts });
  }

  /** The entry for `key`, or undefined when there is none or it does not match `schema` (a miss, never an error). */
  get<S extends z.ZodType>(namespace: string, key: string, schema: S): z.output<S> | undefined {
    try {
      const parsed = schema.safeParse(JSON.parse(readFileSync(this.file(namespace, key), 'utf8')));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  set(namespace: string, key: string, value: unknown): void {
    writeAtomic(this.file(namespace, key), JSON.stringify(redactDeep(value)));
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
): { cache: ContentCache | null; message: string | null } {
  if (!config.cache.enabled) return { cache: null, message: 'cache: disabled by configuration' };
  if (gitOutput(root, ['ls-files', '--', CACHE_DIR.split(path.sep).join('/')])?.trim()) {
    return {
      cache: null,
      message: 'cache: ignored because .veritas/cache is tracked by git (committed entries are not trusted)',
    };
  }
  return { cache: new ContentCache(root), message: null };
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
