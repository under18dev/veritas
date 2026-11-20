import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type ArtifactMeta,
  hashValue,
  readEnvelope,
  redactDeep,
  resolveInsideRoot,
  SCHEMA_VERSION,
  TOOL_VERSION,
  VeritasError,
} from '@under18dev/veritas-core';
import type { z } from 'zod';
import { PlanDocument } from './schema.js';

export const IMPROVEMENTS_DIR = path.join('.veritas', 'improvements');
export const PLAN_ID = /^IP-[0-9a-f]{12}$/;

export function assertPlanId(planId: string): void {
  if (!PLAN_ID.test(planId)) {
    throw new VeritasError('user', 'PLAN_ID_INVALID', `invalid plan id: ${JSON.stringify(planId)}`);
  }
}

/** Absolute directory of a plan, confined to the project root. */
export function planDir(root: string, planId: string): string {
  assertPlanId(planId);

  return resolveInsideRoot(root, path.join(IMPROVEMENTS_DIR, planId));
}

export interface StoreContext {
  runId: string;
  configHash: string;
  sourceHash: string;
  gitCommit: string | null;
}

/** Validate, redact and write an artifact envelope atomically under the plan directory. */
export function writePlanArtifact<S extends z.ZodType>(
  root: string,
  planId: string,
  name: string,
  schema: S,
  data: z.input<S>,
  context: StoreContext,
  /** Fail with EEXIST instead of replacing an existing file (used to claim attempt numbers). */
  options: { exclusive?: boolean } = {},
): string {
  const parsed = schema.safeParse(data);

  if (!parsed.success) {
    throw new VeritasError(
      'tool',
      'ARTIFACT_INVALID',
      `improvement artifact ${name} does not match its schema`,
      undefined,
      parsed.error.issues,
    );
  }
  assertPlanId(planId);

  if (!/^[a-z0-9-]+\.json$/.test(name)) {
    throw new VeritasError('tool', 'ARTIFACT_NAME_INVALID', `invalid improvement artifact name: ${name}`);
  }
  const file = resolveInsideRoot(root, path.join(IMPROVEMENTS_DIR, planId, name));
  const meta: ArtifactMeta = {
    schemaVersion: SCHEMA_VERSION,
    runId: context.runId,
    createdAt: new Date().toISOString(),
    toolVersion: TOOL_VERSION,
    gitCommit: context.gitCommit,
    configHash: context.configHash,
    sourceHash: context.sourceHash,
  };
  mkdirSync(path.dirname(file), { recursive: true });
  // A unique temporary name: concurrent writers in one process or several never share it.
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ meta, data: redactDeep(parsed.data) }, null, 2)}\n`);

  if (options.exclusive) {
    // link fails atomically when the name is taken, so two writers can never both claim it.
    try {
      linkSync(tmp, file);
    } finally {
      unlinkSync(tmp);
    }
  } else renameSync(tmp, file);

  return path.relative(root, file).split(path.sep).join('/');
}

export function readPlan(root: string, planId: string): PlanDocument {
  const file = path.join(planDir(root, planId), 'plan.json');

  if (!existsSync(file)) {
    throw new VeritasError(
      'user',
      'PLAN_MISSING',
      `no plan ${planId} in ${IMPROVEMENTS_DIR}`,
      'run `veritas improve --dry-run` first',
    );
  }

  return readEnvelope(file, PlanDocument).data;
}

/**
 * The approval token: sha256 of the canonical plan content. Timestamps are left out so the same plan always
 * has the same token; any change to tests, files, expected values or budgets changes it.
 */
export function approvalTokenFor(doc: PlanDocument): string {
  const { plan, ...rest } = doc;

  // hashValue hashes canonical JSON (sorted keys, undefined dropped).
  return hashValue({ ...rest, plan: plan ? { ...plan, createdAt: undefined } : null });
}

export function attemptCount(root: string, planId: string): number {
  const dir = planDir(root, planId);

  if (!existsSync(dir)) return 0;

  return readdirSync(dir).filter((f) => /^attempt-\d+\.json$/.test(f)).length;
}
