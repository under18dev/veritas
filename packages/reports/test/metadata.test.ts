import { describe, expect, it } from 'vitest';
import { renderHtml, renderJson, renderMarkdown, renderSarif, renderText } from '../src/index.js';
import { fixture } from './fixtures.js';

describe('report metadata', () => {
  const meta = fixture().meta;

  it('carries the run metadata in every format', () => {
    const json = JSON.parse(renderJson(fixture())) as { meta: unknown };
    expect(json.meta).toEqual(meta);
    const sarif = renderSarif(fixture()).runs[0];
    expect(sarif?.properties).toEqual({ veritas: meta });
    expect(sarif?.tool.driver.version).toBe(meta.toolVersion);
    for (const output of [renderText(fixture()), renderMarkdown(fixture()), renderHtml(fixture())]) {
      for (const value of [meta.gitCommit, meta.toolVersion, meta.configHash, meta.sourceHash])
        expect(output).toContain(value);
    }
  });

  it('shows the commit of the run, not the --since reference, as the git commit', () => {
    const input = fixture();
    input.run.scope.since = 'origin/main';
    const text = renderText(input);
    expect(text).toContain(`git commit ${meta.gitCommit}`);
    expect(text).toContain('changes since origin/main');
    expect(text).not.toContain('git commit origin/main');
  });
});
