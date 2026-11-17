import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage, createUsageCollector } from '../lib/meter/providers.js';

test('Perplexity search counts read documented invocation objects and remain separate from other tools', () => {
  const result = extractUsage('perplexity', { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, tool_calls_details: { web_search: { invocation: 2 }, finance_search: { invocation: 1 }, fetch_url: { invocation: 4 } }, cost: { total_cost: 0.001 } } });
  assert.equal(result.usage.search_queries, 3);
  assert.equal(result.cost.amount, 0.001);
});

test('a large Responses completed frame retains its final provider usage', () => {
  const collector = createUsageCollector('openai');
  collector.text('data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ text: 'x'.repeat(1024 * 1024) }], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } }) + '\n\n');
  assert.equal(collector.finish().usage.total_tokens, 120);
});

test('an oversized SSE frame is discarded without losing a later valid usage frame', () => {
  const collector = createUsageCollector('openai');
  const oversize = 'data: ' + JSON.stringify({ text: 'x'.repeat(9 * 1024 * 1024) }) + '\n\n';
  for (let i = 0; i < oversize.length; i += 262144) collector.text(oversize.slice(i, i + 262144));
  collector.text('data: ' + JSON.stringify({ usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } }) + '\n\ndata: [DONE]\n\n');
  assert.equal(collector.finish().usage.total_tokens, 40);
});
