import { lookup as dnsLookup } from 'node:dns/promises';
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
} from '@under18dev/veritas-core';
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
  /** Release the statement belongs to, from the nearest preceding version heading (`## 2.1.0`, `## [v2.1]`). */
  version: z.string().optional(),
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
    re: /(?:of|is|at|=|:|に)\s*(\d[\d,]*)\s*(?:or more|or above|or greater|or older|or later|or higher|at least|no less than|minimum of|以上)/i,
    operator: '>=',
  },
  { re: /(?:at least|no less than|minimum of)\s*(\d[\d,]*)/i, operator: '>=' },
  {
    re: /(?:of|is|at|=|:|に)\s*(\d[\d,]*)\s*(?:or less|or fewer|or younger|or lower|or earlier|at most|up to|以下)/i,
    operator: '<=',
  },
  { re: /(?:at most|up to|no more than|maximum of)\s*(\d[\d,]*)/i, operator: '<=' },
  { re: /(?:more than|over|above|greater than|exceeds|超|より大きい)\s*(\d[\d,]*)/i, operator: '>' },
  { re: /(?:less than|fewer than|below|under|未満)\s*(\d[\d,]*)/i, operator: '<' },
  { re: /(\d[\d,]*)\s*(?:超|より大きい)/i, operator: '>' },
  { re: /(\d[\d,]*)\s*未満/i, operator: '<' },
  {
    re: /(\d[\d,]*)\s*(?:or more|or above|or greater|or older|or later|or higher|at least|以上)/i,
    operator: '>=',
  },
  {
    re: /(\d[\d,]*)\s*(?:or less|or fewer|or younger|or lower|or earlier|at most|up to|以下)/i,
    operator: '<=',
  },
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
/**
 * The release each offset belongs to: the nearest preceding version heading (`## 2.1.0`, `## [v2.1] - date`),
 * until a heading of the same or a higher level that names no version ends that section.
 */
function versionAt(text: string): (offset: number) => string | undefined {
  // Only headings that are a version (optionally "Version"/"Release", then a date or note), not `## 2.5 kg parcels`.
  const version = /^(?:(?:version|release)[ \t]+)?\[?v?(\d+\.\d+(?:\.\d+)?)\]?(?=[ \t]*(?:$|[-–—(]))/i;
  const headings = [...text.matchAll(/^(#{1,6})[ \t]+(.*)$/gm)].map((m) => ({
    at: m.index ?? 0,
    level: m[1]?.length ?? 1,
    version: version.exec((m[2] ?? '').trim())?.[1],
  }));
  return (offset) => {
    let current: { level: number; version: string } | undefined;
    for (const h of headings) {
      if (h.at > offset) break;
      if (h.version) current = { level: h.level, version: h.version };
      else if (current && h.level <= current.level) current = undefined;
    }
    return current?.version;
  };
}
function extract(text: string, sourceId: string, stale: boolean): NormativeStatement[] {
  const output: NormativeStatement[] = [];
  const releaseOf = versionAt(text);
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
    if (
      relation.kind === 'free_text' &&
      modality(raw) === 'descriptive' &&
      flags.length === 0 &&
      !/\d/.test(raw)
    )
      continue;
    const start = match.index ?? 0;
    const range = lineRange(text, start, start + match[0].length);
    const version = releaseOf(start);
    output.push({
      id: stableId('stmt', { sourceId, range, quote, relation }),
      sourceId,
      range,
      quote,
      modality: modality(raw),
      subjects: subjects(raw),
      relation,
      flags,
      ...(version ? { version } : {}),
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
  // The same matcher as code analysis, so `src/**/*.{ts,tsx}` selects the same files in both.
  return patterns.some((pattern) => path.posix.matchesGlob(rel, pattern));
}
function exportedDocs(text: string): string {
  const output = Array.from({ length: text.split('\n').length }, () => '');
  for (const match of text.matchAll(
    /\/\*\*[\s\S]*?\*\/\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\b/g,
  )) {
    const block = match[0];
    if (!/\*\/\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\b/.test(block)) continue;
    const startLine = text.slice(0, match.index ?? 0).split('\n').length - 1;
    for (const [offset, line] of block.split('\n').entries()) {
      if (output[startLine + offset] !== undefined) output[startLine + offset] = line;
    }
  }
  return output.join('\n');
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
    const code =
      matchesInclude(file, root, config.analysis.include) &&
      !matchesInclude(file, root, config.analysis.exclude) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base) &&
      /\.[cm]?[jt]sx?$/.test(base);
    if (!readme && !docs && !schema && !code) continue;
    let text: string;
    try {
      text = readFileSync(resolveInsideRoot(root, rel), 'utf8');
    } catch {
      skipped.push({ source: rel, reason: 'read failed' });
      continue;
    }
    const sourceText = code ? exportedDocs(text) : text;
    if (code && !sourceText.trim()) continue;
    inputs.push({
      kind: schema ? 'standard' : code ? 'code' : readme ? 'readme' : 'docs',
      locator: rel,
      text: sourceText,
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
  const re = /["']?(exclusiveMinimum|exclusiveMaximum|minimum|maximum)["']?\s*:\s*(true|false|-?\d[\d,]*)/gi;
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
/** Resolves a hostname to every address it maps to; injectable so tests never touch DNS. */
export type HostLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const defaultLookup: HostLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function unsafeIPv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 || // "this" network, includes 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast, reserved, broadcast
  );
}
/** Parses inet_aton-style IPv4 forms (decimal, octal, hex, 1-4 parts). */
function parseLegacyIPv4(host: string): number[] | null {
  if (!/^(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+)){0,3}\.?$/i.test(host)) return null;
  const parts = host.replace(/\.$/, '').split('.');
  const values: number[] = [];
  for (const part of parts) {
    const value = /^0x/i.test(part)
      ? Number.parseInt(part.slice(2) || '0', 16)
      : /^0\d/.test(part)
        ? /^[0-7]+$/.test(part)
          ? Number.parseInt(part, 8)
          : Number.NaN
        : Number(part);
    if (!Number.isFinite(value)) return null;
    values.push(value);
  }
  const last = values.pop() ?? 0;
  if (values.some((v) => v > 255) || last >= 256 ** (4 - values.length)) return null;
  const octets = [...values];
  for (let i = 3 - values.length; i >= 0; i--) octets.push(Math.floor(last / 256 ** i) % 256);
  return octets;
}
function parseIPv6(host: string): number[] | null {
  let text = host;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  let tail: number[] = [];
  if (v4?.[1]) {
    const octets = v4[1].split('.').map(Number);
    if (octets.some((o) => o > 255)) return null;
    tail = [((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)];
    text = text.slice(0, -v4[1].length);
    if (!text.endsWith('::') && text.endsWith(':')) text = text.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(':').map((g) => Number.parseInt(g, 16)) : []);
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const fill = 8 - tail.length - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest, ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}
function unsafeIPv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // ::, ::1, IPv4-compatible (::a.b.c.d) and IPv4-mapped (::ffff:a.b.c.d): all refused.
    if (g5 === 0 || g5 === 0xffff) return true;
  }
  if (g0 === 0x64 && g1 === 0xff9b) return unsafeIPv4(embedded); // NAT64
  if (g0 === 0x2002) return unsafeIPv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]); // 6to4
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local
    (g0 & 0xffc0) === 0xfe80 || // link-local
    (g0 & 0xffc0) === 0xfec0 || // site-local (deprecated)
    (g0 & 0xff00) === 0xff00 // multicast
  );
}
/**
 * True when a host (as written in a URL, with or without IPv6 brackets) is a loopback, private,
 * link-local, unique-local, unspecified, multicast or otherwise reserved address, in any literal
 * spelling, or a `localhost` name. Unparsable numeric hosts are treated as unsafe.
 */
export function isUnsafeHost(host: string): boolean {
  const normalized = host
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/%.*$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === 'localhost.')
    return true;
  if (normalized.includes(':')) {
    const groups = parseIPv6(normalized);
    return groups === null || unsafeIPv6(groups);
  }
  if (/^(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+))*\.?$/i.test(normalized)) {
    const octets = parseLegacyIPv4(normalized);
    return octets === null || unsafeIPv4(octets);
  }
  return false;
}
/** Resolves `host` and returns a refusal reason, or null when every address is public. */
async function refuseByDns(host: string, lookup: HostLookup): Promise<string | null> {
  if (isUnsafeHost(host)) return 'URL refused by protocol, SSRF, or allowlist policy';
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  if (isIP(bare)) return null;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(bare);
  } catch {
    return 'DNS lookup failed';
  }
  if (addresses.length === 0) return 'DNS lookup failed';
  if (addresses.some((entry) => isUnsafeHost(entry.address)))
    return 'URL refused: host resolves to a private, loopback, or reserved address';
  return null;
}
async function collectWeb(
  inputs: SourceInput[],
  config: VeritasConfig,
  offline: boolean,
  fetcher: typeof fetch,
  lookup: HostLookup,
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
    for (const m of input.text.matchAll(/\b(?:https?|ftp|file):\/\/[^\s)>'"`]+/gi))
      queue.push({ url: m[0].replace(/[.,;]+$/, ''), depth: 0 });
  const seen = new Set<string>();
  let requests = 0;
  let chars = 0;
  const deadline = Date.now() + config.sources.web.maxDurationMs;
  let outOfTime = false;
  while (queue.length && requests < config.sources.web.maxPages && chars < config.sources.web.maxChars) {
    if (Date.now() >= deadline) {
      outOfTime = true;
      break;
    }
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
      isUnsafeHost(url.hostname) ||
      !hostAllowed(url.hostname, config.sources.web.allowDomains)
    ) {
      skipped.push({ source: next.url, reason: 'URL refused by protocol, SSRF, or allowlist policy' });
      continue;
    }
    // DNS counts against the crawl deadline too: a resolver that never answers must not stall discovery.
    const dnsRefusal = await withDeadline(
      refuseByDns(url.hostname, lookup),
      deadline,
      'DNS lookup timed out',
    );
    if (dnsRefusal) {
      skipped.push({ source: next.url, reason: dnsRefusal });
      continue;
    }
    requests++;
    // The per-page timeout (capped by the crawl deadline) covers the whole response, body included.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(config.sources.web.timeoutMs, deadline - Date.now())),
    );
    try {
      const response = await fetcher(url, { signal: controller.signal, redirect: 'manual' });
      const destination = response.url ? new URL(response.url) : url;
      if (
        (response.status >= 300 && response.status < 400) ||
        !['http:', 'https:'].includes(destination.protocol) ||
        !hostAllowed(destination.hostname, config.sources.web.allowDomains) ||
        (destination.hostname !== url.hostname &&
          (await withDeadline(
            refuseByDns(destination.hostname, lookup),
            deadline,
            'DNS lookup timed out',
          )) !== null)
      ) {
        skipped.push({ source: next.url, reason: 'redirect refused by allowlist or SSRF policy' });
        continue;
      }
      // Read at most what the character budget can still use (4 bytes per character covers UTF-8).
      const html = await readLimited(response, Math.max(4096, (config.sources.web.maxChars - chars) * 4));
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
    } finally {
      clearTimeout(timer);
    }
  }
  if (outOfTime) skipped.push({ source: 'web', reason: 'time budget exhausted' });
  if (queue.length && requests >= config.sources.web.maxPages)
    skipped.push({ source: 'web', reason: 'page budget exhausted' });
  if (chars >= config.sources.web.maxChars)
    skipped.push({ source: 'web', reason: 'character budget exhausted' });
  return requests;
}
/** The result of `refusal`, or `reason` when the crawl deadline passes before it settles. */
function withDeadline(
  refusal: Promise<string | null>,
  deadline: number,
  reason: string,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(reason), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([refusal, timeout]).finally(() => clearTimeout(timer));
}

/** Upper bound for one GitHub issues response (50 issues with long bodies). */
const GITHUB_MAX_BYTES = 5_000_000;

/** The response body as text, reading no more than `maxBytes`; the rest is discarded unread. */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value.subarray(0, maxBytes - total));
      total += Math.min(value.length, maxBytes - total);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Provenance beyond whole-document duplicates: a source that repeats a statement of an earlier source word for
 * word is `derived_from` it (a copy is not independent evidence), and a source that calls another one outdated
 * or superseded (`README is outdated`, `supersedes docs/limits.md`) `supersedes` it.
 */
function derivedAndSuperseded(
  sources: EvidenceSource[],
  statements: NormativeStatement[],
  inputs: SourceInput[],
  sourceByInput: Map<SourceInput, EvidenceSource>,
): DiscoveryResult['provenance'] {
  const edges = new Map<string, DiscoveryResult['provenance'][number]>();
  const add = (edge: DiscoveryResult['provenance'][number]) => {
    if (edge.from !== edge.to) edges.set(`${edge.from}>${edge.to}>${edge.relation}`, edge);
  };
  const firstQuote = new Map<string, string>();
  for (const st of statements) {
    const key = st.quote.replace(/\s+/g, ' ').trim().toLowerCase();
    if (key.length < 30) continue;
    const earlier = firstQuote.get(key);
    if (earlier === undefined) firstQuote.set(key, st.sourceId);
    else if (earlier !== st.sourceId) add({ from: st.sourceId, to: earlier, relation: 'derived_from' });
  }
  for (const input of inputs) {
    const source = sourceByInput.get(input);
    if (!source) continue;
    for (const other of sources) {
      if (other.id === source.id) continue;
      const name = escapeRegExp(path.posix.basename(other.locator).replace(/\.(md|markdown|txt)$/i, ''));
      if (name.length < 3) continue;
      const mentions = new RegExp(
        `\\b${name}(?:\\.\\w+)?\\b[^.\\n]{0,40}\\b(?:is|are)\\s+(?:outdated|obsolete|superseded)\\b|\\b(?:supersedes|replaces)\\s+(?:the\\s+)?\\S*${name}\\b`,
        'i',
      );
      if (mentions.test(input.text)) add({ from: source.id, to: other.id, relation: 'supersedes' });
    }
  }
  return [...edges.values()];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function discoverEvidence(options: {
  root: string;
  config: VeritasConfig;
  sources?: ('local' | 'github' | 'web')[];
  offline?: boolean;
  fetch?: typeof fetch;
  /** DNS resolver used to refuse hosts resolving to private addresses; default `dns.promises.lookup`. */
  lookup?: HostLookup;
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
        // Counted before the call so failed and timed-out requests are included.
        networkRequests++;
        const response = await (options.fetch ?? globalThis.fetch)(
          `https://api.github.com/repos/${repo}/issues?state=all&per_page=50`,
          {
            headers: {
              accept: 'application/vnd.github+json',
              ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
            },
            redirect: 'error',
            signal: AbortSignal.timeout(options.config.sources.web.timeoutMs),
          },
        );
        if (!response.ok) skipped.push({ source: 'github', reason: `fetch failed (${response.status})` });
        else
          for (const item of JSON.parse(await readLimited(response, GITHUB_MAX_BYTES)) as Array<
            Record<string, unknown>
          >)
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
      options.lookup ?? defaultLookup,
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
  provenance.push(...derivedAndSuperseded(sources, statements, inputs, sourceByInput));
  for (const edge of provenance)
    if (edge.relation === 'derived_from') {
      const from = sources.find((s) => s.id === edge.from);
      if (from && !from.derivedFrom.includes(edge.to)) from.derivedFrom.push(edge.to);
    }
  return DiscoveryResult.parse({ sources, statements, provenance, skipped, networkRequests });
}
