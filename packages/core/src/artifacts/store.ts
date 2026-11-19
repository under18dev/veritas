import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { VeritasError } from '../exit-codes.js';
import { hashValue, sha256 } from '../hash.js';
import { resolveInsideRoot } from '../paths.js';
import { redactDeep } from '../redact.js';
import { type ArtifactMeta, SCHEMA_VERSION } from '../schema/common.js';
import { TOOL_VERSION } from '../version.js';

export const RUNS_DIR = path.join('.veritas', 'runs');
export const CACHE_DIR = path.join('.veritas', 'cache');

export interface Envelope<T> {
  meta: ArtifactMeta;
  data: T;
}

export function gitCommit(root: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
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

  /** Raw text artifacts such as solver input/output or logs; secrets are redacted by the caller's choice. */
  writeText(name: string, content: string): string {
    const file = this.pathFor(name);
    writeAtomic(file, content);
    return path.relative(this.dir, file).split(path.sep).join('/');
  }

  read<S extends z.ZodType>(name: string, schema: S): Envelope<z.output<S>> {
    return readEnvelope(this.pathFor(name), schema);
  }

  pathFor(name: string): string {
    return resolveInsideRoot(this.dir, name);
  }
}

export function readEnvelope<S extends z.ZodType>(file: string, schema: S): Envelope<z.output<S>> {
  let raw: { meta?: unknown; data?: unknown };
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new VeritasError(
      'tool',
      'ARTIFACT_UNREADABLE',
      `cannot read artifact ${file}: ${(error as Error).message}`,
    );
  }
  const meta = raw.meta as ArtifactMeta | undefined;
  if (!meta || meta.schemaVersion !== SCHEMA_VERSION) {
    throw new VeritasError(
      'user',
      'ARTIFACT_SCHEMA_VERSION',
      `artifact ${file} has schema version ${meta?.schemaVersion ?? 'none'}, expected ${SCHEMA_VERSION}`,
      'rerun the stage that produced it',
    );
  }
  const parsed = schema.safeParse(raw.data);
  if (!parsed.success) {
    throw new VeritasError(
      'tool',
      'ARTIFACT_INVALID',
      `artifact ${file} does not match its schema`,
      undefined,
      parsed.error.issues,
    );
  }
  return { meta, data: parsed.data };
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

  get<T>(namespace: string, key: string): T | undefined {
    try {
      return JSON.parse(readFileSync(this.file(namespace, key), 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  set(namespace: string, key: string, value: unknown): void {
    writeAtomic(this.file(namespace, key), JSON.stringify(value));
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

export function hashFiles(files: { path: string; content: string | Uint8Array }[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return hashValue(sorted.map((f) => [f.path, sha256(f.content)]));
}
