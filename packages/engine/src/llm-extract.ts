import { stableId } from '@veritas/core';
import type { LlmClient } from '@veritas/llm';
import type { DiscoveryResult } from '@veritas/spec-discovery';
import { z } from 'zod';

const Extraction = z.object({
  statements: z.array(
    z.object({
      id: z.string(),
      threshold: z
        .object({
          quantity: z.string(),
          operator: z.enum(['<', '<=', '>', '>=']),
          value: z.string().regex(/^-?\d+$/),
          consequence: z.string(),
        })
        .nullable(),
    }),
  ),
});

const INSTRUCTIONS = [
  'For each document, decide whether it states a numeric threshold rule explicitly (for example "at least 18", "no more than 5 items").',
  "If it does, return the quantity, the comparison operator, the integer value and the consequence in the document's own words.",
  'If it does not state one explicitly, return threshold: null. Return one entry per document id.',
].join(' ');

/**
 * Ask the LLM to read free-text statements the rule-based extractor could not interpret. Results are added as new
 * statements flagged `llm_extracted`; they become experimental, proposed properties and are never accepted.
 */
export async function extractWithLlm(
  client: LlmClient,
  discovery: DiscoveryResult,
  signal?: AbortSignal,
): Promise<{ added: DiscoveryResult['statements']; tokens: number; messages: string[] }> {
  const candidates = discovery.statements
    .filter((s) => s.relation.kind === 'free_text' && /\d/.test(s.quote))
    .slice(0, 50);
  if (candidates.length === 0)
    return { added: [], tokens: 0, messages: ['llm: no free-text statement with numbers to examine'] };
  const before = client.tokensUsed;
  const result = await client.complete({
    instructions: INSTRUCTIONS,
    documents: candidates.map((s) => ({ id: s.id, text: s.quote })),
    schema: Extraction,
    maxOutputTokens: 4000,
    ...(signal ? { signal } : {}),
  });
  const tokens = client.tokensUsed - before;
  if (result.status !== 'ok' || !result.data) {
    return {
      added: [],
      tokens,
      messages: [`llm: ${result.status}${result.error ? ` (${result.error})` : ''}; rule-based results only`],
    };
  }
  const byId = new Map(candidates.map((s) => [s.id, s]));
  const added: DiscoveryResult['statements'] = [];
  for (const item of result.data.statements) {
    const source = byId.get(item.id);
    if (!source || !item.threshold) continue;
    // Keep only values that literally appear in the quoted text: the model may not invent numbers.
    if (!source.quote.replace(/,/g, '').includes(item.threshold.value.replace(/^-/, ''))) continue;
    added.push({
      ...source,
      id: stableId('stmt', { llm: source.id, threshold: item.threshold }),
      relation: { kind: 'threshold', ...item.threshold },
      flags: [...source.flags, 'llm_extracted'],
    });
  }
  return {
    added,
    tokens,
    messages: [
      `llm ${result.provider}/${result.model}: ${added.length} threshold(s) from ${candidates.length} statement(s); input ${result.inputHash.slice(0, 12)} (not reproducible)`,
    ],
  };
}
