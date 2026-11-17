import test from 'node:test';
import assert from 'node:assert/strict';
import {extractUsage,createUsageCollector,PROVIDER_CONFIG} from '../lib/meter/providers.js';

test('Claude cache is part of normalized input; streamed output replaces its cumulative counter',()=>{
 const collector=createUsageCollector('anthropic');
 collector.text('data: '+JSON.stringify({type:'message_start',message:{model:'claude-sonnet',usage:{input_tokens:10,cache_read_input_tokens:80,cache_creation_input_tokens:20,output_tokens:1}}})+'\n\n');
 collector.text('data: '+JSON.stringify({type:'message_delta',usage:{output_tokens:9}})+'\n\n');
 const result=collector.finish();assert.equal(result.usage.input_tokens,110);assert.equal(result.usage.output_tokens,9);assert.equal(result.usage.total_tokens,119);assert.equal(result.cost,null);
});
test('Gemini cache is a subset; thoughts are output; exact total retained',()=>{
 const x=extractUsage('google',{usageMetadata:{promptTokenCount:100,cachedContentTokenCount:80,candidatesTokenCount:10,thoughtsTokenCount:20,totalTokenCount:130}});
 assert.equal(x.usage.input_tokens,100);assert.equal(x.usage.output_tokens,30);assert.equal(x.usage.total_tokens,130);
});
test('xAI reported total preserves reasoning semantics and exact USD ticks',()=>{
 const x=extractUsage('xai',{usage:{prompt_tokens:32,completion_tokens:9,completion_tokens_details:{reasoning_tokens:94},total_tokens:135,cost_in_usd_ticks:12345678}});
 assert.equal(x.usage.total_tokens,135);assert.equal(x.usage.output_tokens,9);assert.equal(x.cost.amount,.0012345678);
});
test('Perplexity Agent usage and search counts are retained without price estimates',()=>{
 const x=extractUsage('perplexity',{response:{usage:{input_tokens:100,output_tokens:30,total_tokens:130,input_tokens_details:{cache_read_input_tokens:20},tool_calls_details:{web_search:2,fetch_url:3},cost:{total_cost:.01}}}});
 assert.equal(x.usage.cached_input_tokens,20);assert.equal(x.usage.search_queries,2);assert.equal(x.cost.amount,.01);
});
test('SSE chunk splitting and repeated totals do not double count',()=>{
 const x=createUsageCollector('openai');const data='data: '+JSON.stringify({usage:{prompt_tokens:20,completion_tokens:2,total_tokens:22}})+'\r\n\r\n';
 x.text(data.slice(0,12));x.text(data.slice(12)+data+'data: [DONE]\n\n');assert.equal(x.finish().usage.total_tokens,22);
});
test('Provider routes are fixed and reject traversal, arbitrary URLs and admin routes',()=>{
 for(const config of Object.values(PROVIDER_CONFIG))for(const route of ['https://evil.invalid/v1/messages','v1/../organization/costs','v1/messages?key=secret','v1/files','v1/organization/costs'])assert.equal(config.routes.test(route),false);
});
