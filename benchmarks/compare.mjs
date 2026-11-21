// Compares two benchmark results (base and head) and prints a Markdown report, as the benchmark workflow posts it.
// The results may come from a pull request's own run, so they are read as data only: names are restricted to a safe
// character set, numbers must be finite, and no free text from them reaches the report.
// Usage: node benchmarks/compare.mjs --base <fixtures.json> --head <fixtures.json>
//          [--real-base <real.json> --real-head <real.json>] [--base-ref <name>] [--head-ref <name>]
import { readFileSync } from 'node:fs';

const option = (name) => {
  const at = process.argv.indexOf(name);

  return at >= 0 ? process.argv[at + 1] : undefined;
};
const read = (file) => (file ? JSON.parse(readFileSync(file, 'utf8')) : null);
const base = read(option('--base'));
const head = read(option('--head'));

if (!base || !head) {
  console.error(
    'usage: node benchmarks/compare.mjs --base <file> --head <file> [--real-base <file> --real-head <file>]',
  );
  process.exit(2);
}
const realBase = read(option('--real-base'));
const realHead = read(option('--real-head'));
// Shared runners vary by about this much between two runs of the same code.
const NOISE = 0.15;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const name = (v) => (typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : 'unnamed');
const seconds = (ms) => (num(ms) === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);
const memory = (mb) => (num(mb) === null ? 'n/a' : `${Math.round(mb)} MB`);
const count = (v) => (num(v) === null ? 'n/a' : String(Math.round(v)));
const ref = (v) => (typeof v === 'string' && /^[A-Za-z0-9._/@ -]{1,80}$/.test(v) ? v : '');
const list = (r) => (Array.isArray(r?.results) ? r.results : []);
function change(before, after) {
  if (num(before) === null || num(after) === null || before === 0) return 'n/a';
  const ratio = after / before - 1;
  const text = `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(0)}%`;

  return Math.abs(ratio) > NOISE ? `**${text}**` : text;
}
const exit = (r) =>
  r && r.exitCode !== undefined && ![0, 1, 4].includes(r.exitCode) ? ` (exit ${count(r.exitCode)})` : '';

const lines = [
  '<!-- veritas-benchmark -->',
  '## Benchmark',
  '',
  `Base \`${ref(option('--base-ref')) || 'base'}\` and head \`${ref(option('--head-ref')) || 'head'}\`, measured one after the other on the same runner (${name(head.platform)}, Node.js ${name(head.node)}, ${count(head.cpus)} CPUs). Changes larger than ${NOISE * 100}% are in bold; smaller ones are within the usual variation between runs.`,
  '',
  '### Fixtures (`run --offline --include-proposed`)',
  '',
  '| Fixture | Profile | Base | Head | Change | Peak memory (base → head) |',
  '| --- | --- | ---: | ---: | ---: | --- |',
];

for (const h of list(head)) {
  const b = list(base).find((r) => r.fixture === h.fixture && r.profile === h.profile);
  lines.push(
    `| ${name(h.fixture)} | ${name(h.profile)} | ${seconds(b?.wallMs)}${exit(b)} | ${seconds(h.wallMs)}${exit(h)} | ${change(b?.wallMs, h.wallMs)} | ${memory(b?.peakRssMb)} → ${memory(h.peakRssMb)} |`,
  );
}

if (realHead) {
  lines.push(
    '',
    '### Open-source projects (`run --profile quick --offline`)',
    '',
    '| Project | Tests | Base | Head | Change | Peak memory (base → head) | Not checking project behaviour (base → head) |',
    '| --- | ---: | ---: | ---: | ---: | --- | --- |',
  );

  for (const h of list(realHead)) {
    const b = list(realBase).find((r) => r.project === h.project);

    if (h.error || b?.error) {
      lines.push(`| ${name(h.project)} | | | | | | skipped (see the workflow log) |`);
      continue;
    }
    const disconnected = (r) => count(r?.outcomes?.tautological_or_disconnected ?? 0);
    lines.push(
      `| ${name(h.project)} | ${count(h.tests)} | ${seconds(b?.wallMs)}${exit(b)} | ${seconds(h.wallMs)}${exit(h)} | ${change(b?.wallMs, h.wallMs)} | ${memory(b?.peakRssMb)} → ${memory(h.peakRssMb)} | ${disconnected(b)} → ${disconnected(h)} |`,
    );
  }
}
lines.push('', 'Raw results are attached to the workflow run as the `benchmark` artifact.');
console.log(lines.join('\n'));
