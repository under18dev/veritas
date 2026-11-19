import { readdirSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import {
  EvidenceSource,
  redact,
  resolveInsideRoot,
  runCommand,
  type SourceRange,
  sha256,
  stableId,
  type VeritasConfig,
} from '@veritas/core';
import { z } from 'zod';

const ThresholdRelation = z.object({
  kind: z.literal('threshold'),
  quantity: z.string(),
  operator: z.enum(['<', '<=', '>', '>=', '==']),
  value: z.string().regex(/^-?\d+$/),
  consequence: z.string(),
});
const FreeTextRelation = z.object({ kind: z.literal('free_text') });
export const NormativeStatement = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  range: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }),
  quote: z.string().max(300),
  modality: z.enum(['must', 'should', 'may', 'descriptive']),
  subjects: z.array(z.string()),
  relation: z.union([ThresholdRelation, FreeTextRelation]),
  flags: z.array(z.string()),
});
export type NormativeStatement = z.infer<typeof NormativeStatement>;
const Provenance = z.object({
  from: z.string(),
  to: z.string(),
  relation: z.enum(['duplicate_of', 'derived_from', 'supersedes']),
});
export const DiscoveryResult = z.object({
  sources: z.array(EvidenceSource),
  statements: z.array(NormativeStatement),
  provenance: z.array(Provenance),
  skipped: z.array(z.object({ source: z.string(), reason: z.string() })),
  networkRequests: z.number().int().nonnegative(),
});
export type DiscoveryResult = z.infer<typeof DiscoveryResult>;

type SourceInput = {
  kind: z.infer<typeof EvidenceSource>['kind'];
  locator: string;
  text: string;
  revision?: string;
  range?: SourceRange;
};
const thresholdPatterns: Array<{ re: RegExp; operator: '<' | '<=' | '>' | '>=' }> = [
  {
    re: /(?:of|is|at|=|:|に)\s*(\d[\d,]*)\s*(?:or more|or above|or greater|at least|no less than|minimum of|以上)/i,
    operator: '>=',
  },
  { re: /(?:at least|no less than|minimum of)\s*(\d[\d,]*)/i, operator: '>=' },
  { re: /(?:of|is|at|=|:|に)\s*(\d[\d,]*)\s*(?:or less|at most|up to|以下)/i, operator: '<=' },
  { re: /(?:at most|up to|no more than|maximum of)\s*(\d[\d,]*)/i, operator: '<=' },
  { re: /(?:more than|over|above|greater than|exceeds|超|より大きい)\s*(\d[\d,]*)/i, operator: '>' },
  { re: /(?:less than|fewer than|below|under|未満)\s*(\d[\d,]*)/i, operator: '<' },
  { re: /(\d[\d,]*)\s*(?:or more|or above|at least|以上)/i, operator: '>=' },
  { re: /(\d[\d,]*)\s*(?:or less|at most|up to|以下)/i, operator: '<=' },
];
function lineRange(text: string, start: number, end: number): SourceRange {
  const line = (n: number) => text.slice(0, n).split('\n').length;
  return { start: line(start), end: line(end) };
}
function cleanQuote(text: string): string {
  return redact(text.replace(/\s+/g, ' ').trim()).slice(0, 300);
}
function subjects(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/`([^`]+)`|\b[A-Za-z_$][\w$.-]*\b/g)) {
    const value = match[1] ?? match[0];
    if (
      !/^(?:must|shall|should|may|or|more|less|than|above|below|at|least|the|and|for|with|return)$/i.test(
        value,
      )
    )
      found.add(value);
  }
  return [...found].sort();
}
function modality(text: string): NormativeStatement['modality'] {
  if (/\b(?:must|shall|required to)\b|必ず|しなければならない/i.test(text)) return 'must';
  if (/\bshould\b|すべき/i.test(text)) return 'should';
  if (/\bmay\b|してもよい/i.test(text)) return 'may';
  return 'descriptive';
}
function extract(text: string, sourceId: string, stale: boolean): NormativeStatement[] {
  const output: NormativeStatement[] = [];
  for (const match of text.matchAll(/[^。.!?\n]+(?:[。.!?]+|$)/g)) {
    const raw = match[0].trim();
    if (!raw) continue;
    const quote = cleanQuote(raw);
    const flags: string[] = [];
    if (
      /ignore (?:all )?previous|system instruction|run\s+`|upload|set policy|write to|エージェント|指示/i.test(
        raw,
      )
    )
      flags.push('instruction_like');
    if (stale || /\bdeprecated\b|\bold version\b|旧版/i.test(raw)) flags.push('stale');
    let relation: NormativeStatement['relation'] = { kind: 'free_text' };
    for (const pattern of thresholdPatterns) {
      const hit = raw.match(pattern.re);
      if (!hit) continue;
      const value = hit[1]?.replaceAll(',', '');
      if (!value) continue;
      const before = raw.slice(0, hit.index ?? 0);
      const q = before.match(/([A-Za-z_$][\w$.-]*|[A-Za-z][A-Za-z -]{1,40}?)(?:\s+of)?\s*$/);
      const quantity = q?.[1]?.trim().split(/\s+/).at(-1) ?? 'value';
      relation = { kind: 'threshold', quantity, operator: pattern.operator, value, consequence: quote };
      break;
    }
    if (relation.kind === 'free_text' && modality(raw) === 'descriptive' && flags.length === 0) continue;
    const start = match.index ?? 0;
    const range = lineRange(text, start, start + match[0].length);
    output.push({
      id: stableId('stmt', { sourceId, range, quote, relation }),
      sourceId,
      range,
      quote,
      modality: modality(raw),
      subjects: subjects(raw),
      relation,
      flags,
    });
  }
  return output;
}
function walk(root: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) result.push(full);
    }
  };
  visit(root);
  return result;
}
function matchesInclude(file: string, root: string, patterns: string[]): boolean {
  const rel = path.relative(root, file).split(path.sep).join('/');
  return patterns.some((pattern) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\{([^}]+)\}/g, '($1)');
    return new RegExp(`^${escaped}$`).test(rel);
  });
}
function sourceFrom(input: SourceInput, capturedAt: string): EvidenceSource {
  const contentHash = sha256(input.text);
  const id = stableId('src', {
    kind: input.kind,
    locator: input.locator,
    revision: input.revision ?? null,
    contentHash,
  });
  return EvidenceSource.parse({
    id,
    kind: input.kind,
    locator: input.locator,
    revision: input.revision,
    range: input.range,
    capturedAt,
    contentHash,
    derivedFrom: [],
    summary: redact(cleanQuote(input.text)),
    trust: 'untrusted_data',
  });
}
async function collectLocal(
  root: string,
  config: VeritasConfig,
  skipped: DiscoveryResult['skipped'],
): Promise<SourceInput[]> {
  const files = walk(root);
  const inputs: SourceInput[] = [];
  const rev = await runCommand('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    timeoutMs: 5000,
    maxOutputBytes: 10000,
  });
  const revision = rev.exitCode === 0 ? rev.stdout.trim() || undefined : undefined;
  if (!revision) skipped.push({ source: 'git', reason: 'not a git repository or git unavailable' });
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const base = path.basename(file);
    const readme = /^README(?:\.|$)/i.test(base);
    const docs = (rel.startsWith('docs/') && /\.md$/i.test(base)) || /^CHANGELOG|^RELEASE/i.test(base);
    const schema =
      /(?:\.openapi|\.schema)\.(?:json|ya?ml)$/i.test(base) || /^openapi\.(?:json|ya?ml)$/i.test(base);
    const code = matchesInclude(file, root, config.analysis.include) && /\.[cm]?[jt]sx?$/.test(base);
    if (!readme && !docs && !schema && !code) continue;
    let text: string;
    try {
      text = readFileSync(resolveInsideRoot(root, rel), 'utf8');
    } catch {
      skipped.push({ source: rel, reason: 'read failed' });
      continue;
    }
    inputs.push({
      kind: schema ? 'standard' : code ? 'code' : readme ? 'readme' : 'docs',
      locator: rel,
      text,
      revision,
      range: { start: 1, end: Math.max(1, text.split('\n').length) },
    });
  }
  for (const file of files.filter(
    (f) => /\.json$/i.test(f) && f.includes(`${path.sep}.veritas-sources${path.sep}`),
  )) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const kind = rel.includes('/issues/') ? 'issue' : rel.includes('/pulls/') ? 'pr' : null;
    if (!kind) continue;
    try {
      const item = JSON.parse(readFileSync(resolveInsideRoot(root, rel), 'utf8')) as Record<string, unknown>;
      inputs.push({
        kind,
        locator: typeof item.html_url === 'string' ? item.html_url : rel,
        revision: typeof item.state === 'string' ? item.state : undefined,
        text: [item.title, item.body, item.state]
          .filter((x): x is string => typeof x === 'string')
          .join('\n'),
      });
    } catch {
      skipped.push({ source: rel, reason: 'invalid exported issue or pull request JSON' });
    }
  }
  if (revision) {
    const log = await runCommand('git', ['log', '-50', '--format=%H%n%s%n%b%n---'], {
      cwd: root,
      timeoutMs: 5000,
      maxOutputBytes: 1_000_000,
    });
    if (log.exitCode === 0 && log.stdout.trim())
      inputs.push({ kind: 'git', locator: 'git log', revision, text: log.stdout });
    else skipped.push({ source: 'git log', reason: 'git log unavailable' });
  }
  return inputs;
}
function schemaStatements(text: string, sourceId: string): NormativeStatement[] {
  const out: NormativeStatement[] = [];
  const re = /["']?(minimum|maximum|exclusiveMinimum|exclusiveMaximum)["']?\s*:\s*(true|false|-?\d[\d,]*)/gi;
  for (const match of text.matchAll(re)) {
    const key = match[1]?.toLowerCase();
    const value = match[2];
    if (!key || !value || value === 'true' || value === 'false') continue;
    const operator: '<' | '<=' | '>' | '>=' =
      key === 'minimum' ? '>=' : key === 'maximum' ? '<=' : key === 'exclusiveminimum' ? '>' : '<';
    const quote = cleanQuote(match[0]);
    const range = lineRange(text, match.index ?? 0, (match.index ?? 0) + match[0].length);
    const relation = {
      kind: 'threshold' as const,
      quantity: 'value',
      operator,
      value: value.replaceAll(',', ''),
      consequence: quote,
    };
    out.push({
      id: stableId('stmt', { sourceId, range, quote, relation }),
      sourceId,
      range,
      quote,
      modality: 'must',
      subjects: ['value'],
      relation,
      flags: [],
    });
  }
  return out;
}
function hostAllowed(host: string, domains: string[]): boolean {
  const lower = host.toLowerCase();
  return domains.some((d) => lower === d.toLowerCase() || lower.endsWith(`.${d.toLowerCase()}`));
}
function unsafeHost(host: string): boolean {
  if (!isIP(host)) return false;
  const normalized = host.toLowerCase();
  if (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized.startsWith('10.') ||
    normalized.startsWith('192.168.') ||
    normalized.startsWith('169.254.') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  )
    return true;
  const p = host.split('.').map(Number);
  return p.length === 4 && p[0] === 172 && (p[1] ?? 0) >= 16 && (p[1] ?? 0) <= 31;
}
async function collectWeb(
  inputs: SourceInput[],
  config: VeritasConfig,
  offline: boolean,
  fetcher: typeof fetch,
  skipped: DiscoveryResult['skipped'],
): Promise<number> {
  if (!config.sources.web.enabled) {
    skipped.push({ source: 'web', reason: 'web disabled' });
    return 0;
  }
  if (offline) {
    skipped.push({ source: 'web', reason: 'offline' });
    return 0;
  }
  const queue: Array<{ url: string; depth: number }> = [];
  for (const input of inputs)
    for (const m of input.text.matchAll(/https?:\/\/[^\s)>'"`]+/g))
      queue.push({ url: m[0].replace(/[.,;]+$/, ''), depth: 0 });
  const seen = new Set<string>();
  let requests = 0;
  let chars = 0;
  while (queue.length && requests < config.sources.web.maxPages && chars < config.sources.web.maxChars) {
    const next = queue.shift();
    if (!next || seen.has(next.url)) continue;
    seen.add(next.url);
    let url: URL;
    try {
      url = new URL(next.url);
    } catch {
      skipped.push({ source: next.url, reason: 'invalid URL' });
      continue;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      unsafeHost(url.hostname) ||
      !hostAllowed(url.hostname, config.sources.web.allowDomains)
    ) {
      skipped.push({ source: next.url, reason: 'URL refused by protocol, SSRF, or allowlist policy' });
      continue;
    }
    requests++;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.sources.web.timeoutMs);
      const response = await fetcher(url, { signal: controller.signal, redirect: 'manual' });
      clearTimeout(timer);
      const destination = response.url ? new URL(response.url) : url;
      if (
        (response.status >= 300 && response.status < 400) ||
        !hostAllowed(destination.hostname, config.sources.web.allowDomains) ||
        unsafeHost(destination.hostname)
      ) {
        skipped.push({ source: next.url, reason: 'redirect refused by allowlist or SSRF policy' });
        continue;
      }
      const html = await response.text();
      const text = redact(
        html
          .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      );
      const clipped = text.slice(0, Math.max(0, config.sources.web.maxChars - chars));
      chars += clipped.length;
      if (clipped) inputs.push({ kind: 'web', locator: url.href, text: clipped });
      if (next.depth < config.sources.web.maxDepth && chars < config.sources.web.maxChars)
        for (const link of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
          try {
            const href = link[1];
            if (!href) continue;
            const child = new URL(href, url).href;
            if (!seen.has(child)) queue.push({ url: child, depth: next.depth + 1 });
          } catch {
            /* untrusted link */
          }
        }
    } catch (error) {
      skipped.push({
        source: next.url,
        reason: error instanceof Error && error.name === 'AbortError' ? 'fetch timeout' : 'fetch failed',
      });
    }
  }
  if (queue.length && requests >= config.sources.web.maxPages)
    skipped.push({ source: 'web', reason: 'page budget exhausted' });
  if (chars >= config.sources.web.maxChars)
    skipped.push({ source: 'web', reason: 'character budget exhausted' });
  return requests;
}
export async function discoverEvidence(options: {
  root: string;
  config: VeritasConfig;
  sources?: ('local' | 'github' | 'web')[];
  offline?: boolean;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<DiscoveryResult> {
  const capturedAt = (options.now ?? (() => new Date()))().toISOString();
  const selected = options.sources ?? [
    'local',
    ...(options.config.sources.github.enabled ? ['github' as const] : []),
    ...(options.config.sources.web.enabled ? ['web' as const] : []),
  ];
  const skipped: DiscoveryResult['skipped'] = [];
  const inputs: SourceInput[] = [];
  let networkRequests = 0;
  if (selected.includes('local') && options.config.sources.local)
    inputs.push(...(await collectLocal(options.root, options.config, skipped)));
  else if (selected.includes('local')) skipped.push({ source: 'local', reason: 'local disabled' });
  if (selected.includes('github')) {
    if (!options.config.sources.github.enabled) skipped.push({ source: 'github', reason: 'github disabled' });
    else if (options.offline) skipped.push({ source: 'github', reason: 'offline' });
    else if (!options.config.sources.github.repo)
      skipped.push({ source: 'github', reason: 'repository not configured' });
    else {
      const repo = options.config.sources.github.repo;
      try {
        const response = await (options.fetch ?? globalThis.fetch)(
          `https://api.github.com/repos/${repo}/issues?state=all&per_page=50`,
          {
            headers: {
              accept: 'application/vnd.github+json',
              ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
            },
          },
        );
        networkRequests++;
        if (!response.ok) skipped.push({ source: 'github', reason: `fetch failed (${response.status})` });
        else
          for (const item of (await response.json()) as Array<Record<string, unknown>>)
            inputs.push({
              kind: item.pull_request ? 'pr' : 'issue',
              locator: typeof item.html_url === 'string' ? item.html_url : `github:${repo}`,
              revision: typeof item.state === 'string' ? item.state : undefined,
              text: [item.title, item.body].filter((x): x is string => typeof x === 'string').join('\n'),
            });
      } catch {
        skipped.push({ source: 'github', reason: 'fetch failed' });
      }
    }
  }
  if (selected.includes('web'))
    networkRequests += await collectWeb(
      inputs,
      options.config,
      options.offline === true,
      options.fetch ?? globalThis.fetch,
      skipped,
    );
  const sources: EvidenceSource[] = [];
  const sourceByInput = new Map<SourceInput, EvidenceSource>();
  for (const input of inputs) {
    const source = sourceFrom(input, capturedAt);
    sources.push(source);
    sourceByInput.set(input, source);
  }
  const provenance: DiscoveryResult['provenance'] = [];
  const seenText = new Map<string, string>();
  const statements: NormativeStatement[] = [];
  for (const input of inputs) {
    const source = sourceByInput.get(input);
    if (!source) continue;
    const normalized = input.text.replace(/\s+/g, ' ').trim().toLowerCase();
    const previous = seenText.get(normalized);
    if (previous) {
      provenance.push({ from: source.id, to: previous, relation: 'duplicate_of' });
      continue;
    }
    seenText.set(normalized, source.id);
    const stale = /(?:^|\/)v1(?:\/|$)|deprecated|(?:^|\/)old(?:\/|$)/i.test(input.locator);
    statements.push(
      ...(input.kind === 'standard'
        ? schemaStatements(input.text, source.id)
        : extract(input.text, source.id, stale)),
    );
  }
  return DiscoveryResult.parse({ sources, statements, provenance, skipped, networkRequests });
}
