// Compares two benchmark results (base and head) and prints a Markdown report, as the benchmark workflow posts it.
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

const seconds = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : 'n/a');
const memory = (mb) => (typeof mb === 'number' ? `${mb} MB` : 'n/a');
function change(before, after) {
  if (typeof before !== 'number' || typeof after !== 'number' || before === 0) return 'n/a';
  const ratio = after / before - 1;
  const text = `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(0)}%`;

  return Math.abs(ratio) > NOISE ? `**${text}**` : text;
}
const exit = (r) =>
  r && r.exitCode !== undefined && ![0, 1, 4].includes(r.exitCode) ? ` (exit ${r.exitCode})` : '';

const lines = [
  '<!-- veritas-benchmark -->',
  '## Benchmark',
  '',
  `Base \`${option('--base-ref') ?? 'base'}\` and head \`${option('--head-ref') ?? 'head'}\`, measured one after the other on the same runner (${head.platform}, Node.js ${head.node}, ${head.cpus} CPUs). Changes larger than ${NOISE * 100}% are in bold; smaller ones are within the usual variation between runs.`,
  '',
  '### Fixtures (`run --offline --include-proposed`)',
  '',
  '| Fixture | Profile | Base | Head | Change | Peak memory (base → head) |',
  '| --- | --- | ---: | ---: | ---: | --- |',
];

for (const h of head.results) {
  const b = base.results.find((r) => r.fixture === h.fixture && r.profile === h.profile);
  lines.push(
    `| ${h.fixture} | ${h.profile} | ${seconds(b?.wallMs)}${exit(b)} | ${seconds(h.wallMs)}${exit(h)} | ${change(b?.wallMs, h.wallMs)} | ${memory(b?.peakRssMb)} → ${memory(h.peakRssMb)} |`,
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

  for (const h of realHead.results) {
    const b = realBase?.results.find((r) => r.project === h.project);

    if (h.error || b?.error) {
      lines.push(`| ${h.project} | | | | | | skipped: ${(h.error ?? b?.error ?? '').replaceAll('|', '/')} |`);
      continue;
    }
    const disconnected = (r) => r?.outcomes?.tautological_or_disconnected ?? 0;
    lines.push(
      `| ${h.project} | ${h.tests ?? 'n/a'} | ${seconds(b?.wallMs)}${exit(b)} | ${seconds(h.wallMs)}${exit(h)} | ${change(b?.wallMs, h.wallMs)} | ${memory(b?.peakRssMb)} → ${memory(h.peakRssMb)} | ${disconnected(b)} → ${disconnected(h)} |`,
    );
  }
}
lines.push('', 'Raw results are attached to the workflow run as the `benchmark` artifact.');
console.log(lines.join('\n'));
