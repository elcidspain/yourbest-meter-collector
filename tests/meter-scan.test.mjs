import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { generateKeyPairSync, createHash, verify } from 'node:crypto';
import { aggregateEvents, createCodexParser, createSnapshot, fetchOpenAiUsage, parseCommanderLine,
  parseGrokUsage, parseGrokUpdate, parseClaudeCodeRecord, parseCursorRecord, readCursorDatabase, publishSnapshot, canonicalJson } from '../cli/meter-scan.mjs';

const now = Date.parse('2026-11-17T12:00:00Z');
const day = 86400000;
const timestamp = days => new Date(now - days * day).toISOString();
const counts = (input, output = 10, cached = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached });
const context = { type: 'turn_context', timestamp: timestamp(29), payload: { turn_id: 'turn-a', model: 'observed-model' } };
const record = (days, response, input, cached = 0) => ({ type: 'token_usage_record', timestamp: timestamp(days),
  payload: { response_id: response, turn_id: 'turn-a', thread_id: 'private-thread', usage: counts(input, 10, cached) } });

test('deduplicates per-response telemetry and keeps nested windows distinct with cached input as a subset', () => {
  const parser = createCodexParser(); parser.consume(context);
  for (const event of [record(25, 'a', 300, 100), record(10, 'b', 200, 100), record(2, 'c', 100, 50), record(2, 'c', 100, 50)]) parser.consume(event);
  const result = aggregateEvents(parser.finish().events, now);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.items.map(item => [item.window_days, item.input_tokens, item.output_tokens, item.cached_tokens]),
    [[7, 100, 10, 50], [14, 300, 20, 150], [30, 600, 30, 250]]);
  assert.ok(result.items.every(item => item.model === 'observed-model'));
});

test('legacy counters count observed deltas once and do not import a pre-existing cumulative balance', () => {
  const parser = createCodexParser(); parser.consume(context);
  const legacy = (days, total, last) => ({ timestamp: timestamp(days), type: 'event_msg', payload: { type: 'token_count',
    info: { total_token_usage: total, last_token_usage: last } } });
  parser.consume(legacy(2, counts(1000, 100, 500), counts(100, 10, 50)));
  parser.consume(legacy(1, counts(1200, 120, 600), counts(200, 20, 100)));
  parser.consume(legacy(0.5, counts(1200, 120, 600), counts(200, 20, 100)));
  const row = aggregateEvents(parser.finish().events, now).items[0];
  assert.equal(row.input_tokens, 300); assert.equal(row.output_tokens, 30); assert.equal(row.cached_tokens, 150);
});

test('modern records and their mirrored legacy counters are not summed twice', () => {
  const parser = createCodexParser(); parser.consume(context); parser.consume(record(1, 'response', 200, 100));
  parser.consume({ timestamp: timestamp(1), type: 'event_msg', payload: { type: 'token_count',
    info: { total_token_usage: counts(200, 10, 100), last_token_usage: counts(200, 10, 100) } } });
  assert.equal(aggregateEvents(parser.finish().events, now).items[0].input_tokens, 200);
});

test('tool windows use event timestamps and exact boundaries, without invented model tokens', () => {
  const events = [7, 14, 30, 31].map((days, i) => parseCommanderLine(`${timestamp(days)} | read_file | arguments: secret-${i}`));
  const result = aggregateEvents(events, now);
  assert.deepEqual(result.items.map(item => item.amount), [1, 2, 3]);
  assert.ok(result.items.every(item => item.model === 'unknown' && !('input_tokens' in item)));
  assert.ok(!JSON.stringify(result.items).includes('secret'));
});

test('full scan reads compressed duplicates, ignores file mtime, exports aggregates and marks missing sources', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-test-'));
  try {
    fs.mkdirSync(path.join(home, '.codex/sessions/2026/11/17'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex/archived_sessions'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude-server-commander'), { recursive: true });
    const data = [context, record(2, 'same-response', 100, 50), { type: 'response_item', payload: { text: 'private prompt' } }].map(x => JSON.stringify(x)).join('\n');
    const file = path.join(home, '.codex/sessions/2026/11/17/live.jsonl');
    fs.writeFileSync(file, data); fs.utimesSync(file, new Date(0), new Date(0));
    fs.writeFileSync(path.join(home, '.codex/archived_sessions/copy.jsonl.zst'), zstdCompressSync(data));
    fs.writeFileSync(path.join(home, '.claude-server-commander/claude_tool_call.log'), `${timestamp(1)} | start_process | arguments: private-key\n`);
    const snapshot = await createSnapshot({ home, platform: 'win32', env: {}, now, fetchImpl: () => { throw Error('must not request an API'); } });
    const codex = snapshot.items.find(item => item.source === 'codex' && item.window_days === 7);
    assert.equal(codex.input_tokens, 100);
    assert.equal(snapshot.sources.find(source => source.source === 'codex').duplicates_removed, 1);
    assert.equal(snapshot.sources.find(source => source.source === 'claude_mcp').status, 'unavailable');
    assert.equal(snapshot.sources.find(source => source.source === 'openai').status, 'unavailable');
    const exported = JSON.stringify(snapshot);
    for (const sensitive of ['private prompt', 'private-key', 'private-thread', home, 'same-response']) assert.ok(!exported.includes(sensitive));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('OpenAI usage requests all pages with model grouping and records failures as unavailable evidence', async () => {
  const urls = [];
  const result = await fetchOpenAiUsage({ key: 'test-secret', now, fetchImpl: async url => {
    urls.push(url);
    const second = url.searchParams.get('page') === 'page-2';
    return { ok: true, json: async () => ({ has_more: !second, next_page: second ? null : 'page-2', data: [
      { results: [{ model: second ? 'model-b' : 'model-a', input_tokens: 100, output_tokens: 20, input_cached_tokens: 80 }] }
    ] }) };
  } });
  assert.equal(urls.length, 6); assert.equal(result.items.length, 6);
  assert.ok(urls.every(url => url.searchParams.get('group_by[]') === 'model' && url.searchParams.has('end_time')));
  assert.ok(result.items.every(item => item.input_tokens === 100 && item.cached_tokens === 80));
  const failure = await fetchOpenAiUsage({ key: 'test-secret', now, fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.deepEqual(failure.items, []); assert.equal(failure.source.status, 'partial');
  assert.ok(!JSON.stringify(failure).includes('test-secret'));
});

const grokUsage = (input, output, cached = 0, calls = 1) => ({
  inputTokens: input, outputTokens: output, cachedReadTokens: cached, cacheCreationTokens: 0,
  reasoningTokens: Math.floor(output / 2), totalTokens: input + output, modelCalls: calls, costUsdTicks: 10000000
});
const grokTurn = (days, turnNumber, input, output = 10, cached = 0) => ({
  turnNumber, endedAt: timestamp(days), primaryModelId: 'grok-observed', ...grokUsage(input, output, cached),
  modelUsage: { 'grok-observed': grokUsage(input, output, cached) }
});
const grokUpdate = (days, input, prompt = 'private-prompt-id') => ({
  timestamp: Math.floor((now - days * day) / 1000), method: 'session/update',
  params: { sessionId: 'private-grok-session', _meta: { totalTokens: 900000000 },
    update: { sessionUpdate: 'turn_completed', prompt_id: prompt, usage: {
      ...grokUsage(input, 10, 50), modelUsage: { 'grok-observed': grokUsage(input, 10, 50) }
    } }
  }
});

test('Grok counts timestamped turns, not lifetime balances, context size, or reasoning twice', () => {
  const parsed = parseGrokUsage({ sessionId: 'private-session', updatedAt: timestamp(0),
    session: grokUsage(900000000, 5000000, 800000000),
    turns: [grokTurn(25, 1, 300, 30, 100), grokTurn(10, 2, 200, 20, 100), grokTurn(2, 3, 100, 10, 50)]
  });
  assert.equal(parsed.invalid, 0);
  const result = aggregateEvents([...parsed.events, ...parsed.events], now);
  assert.equal(result.duplicates, 3);
  assert.deepEqual(result.items.map(item => [item.window_days, item.input_tokens, item.output_tokens, item.cached_tokens]),
    [[7, 100, 10, 50], [14, 300, 30, 150], [30, 600, 60, 250]]);
  assert.ok(!JSON.stringify(result.items).includes('private-session'));
  const fallback = parseGrokUpdate(grokUpdate(1, 200));
  assert.equal(fallback.events[0].input_tokens, 200);
  assert.equal(fallback.events[0].timestamp, now - day);
  assert.equal(parseGrokUpdate({ params: { _meta: { totalTokens: 9000000 } } }), null);
  assert.equal(parseGrokUsage({ session: grokUsage(900000000, 100), updatedAt: timestamp(0) }).events.length, 0);
});

test('Grok splits per-model usage only when it reconciles to the measured turn', () => {
  const turn = { ...grokTurn(2, 1, 300, 30, 150), modelUsage: {
    'grok-a': grokUsage(100, 10, 50), 'grok-b': grokUsage(200, 20, 100)
  } };
  const result = parseGrokUsage({ sessionId: 'grok-session', turns: [turn] });
  assert.deepEqual(result.events.map(event => [event.model, event.input_tokens]), [['grok-a', 100], ['grok-b', 200]]);
  turn.modelUsage['grok-b'].inputTokens = 400;
  const mismatch = parseGrokUsage({ sessionId: 'grok-session', turns: [turn] });
  assert.equal(mismatch.events.length, 1); assert.equal(mismatch.events[0].model, 'unknown');
  assert.equal(mismatch.events[0].input_tokens, 300);
});

test('full scan prefers Grok usage.json over mirrored updates, uses fallback, and counts completed tools once', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-grok-'));
  try {
    const measured = path.join(home, '.grok/sessions/project/session-a');
    const fallback = path.join(home, '.grok/sessions/project/session-b');
    fs.mkdirSync(measured, { recursive: true }); fs.mkdirSync(fallback, { recursive: true });
    fs.writeFileSync(path.join(measured, 'usage.json'), JSON.stringify({ sessionId: 'private-session-a', turns: [grokTurn(1, 1, 200, 10, 50)] }));
    fs.writeFileSync(path.join(measured, 'updates.jsonl'), JSON.stringify(grokUpdate(1, 200)) + '\n');
    fs.writeFileSync(path.join(fallback, 'updates.jsonl'), JSON.stringify(grokUpdate(10, 300, 'private-prompt-b')) + '\n');
    const tool = { ts: timestamp(1), type: 'tool_completed', tool_call_id: 'private-tool-id', tool_name: 'private-tool-name' };
    fs.writeFileSync(path.join(measured, 'events.jsonl'), [
      { ts: timestamp(1), type: 'turn_started', session_id: 'private-session-a', model_id: 'grok-observed' },
      { ts: timestamp(1), type: 'tool_started', tool_name: 'private-tool-name' }, tool, tool
    ].map(record => JSON.stringify(record)).join('\n'));
    const snapshot = await createSnapshot({ home, platform: 'win32', env: {}, now });
    assert.ok(snapshot.discovered.desktop_clients.includes('Grok Build'));
    assert.deepEqual(snapshot.items.filter(item => item.source === 'grok_build' && item.unit === 'tokens').map(item => item.input_tokens), [200, 500, 500]);
    assert.deepEqual(snapshot.items.filter(item => item.source === 'grok_build' && item.unit === 'tool_calls').map(item => item.amount), [1, 1, 1]);
    const source = snapshot.sources.find(source => source.source === 'grok_build');
    assert.equal(source.status, 'observed'); assert.equal(source.duplicates_removed, 1);
    assert.ok(source.notes.some(note => note.includes('Client-reported Grok usage cost')));
    assert.ok(snapshot.items.every(item => !('cost_usd' in item)));
    const exported = JSON.stringify(snapshot);
    for (const sensitive of [home, 'private-session', 'private-tool', 'private-prompt']) assert.ok(!exported.includes(sensitive));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Claude Code includes both cache categories and deduplicates streaming/fork copies in any order', () => {
  const message = (output, days = 1) => ({ type: 'assistant', timestamp: timestamp(days),
    sessionId: 'private-session', message: { id: 'private-message', role: 'assistant', model: 'claude-observed',
      content: [{ text: 'private prompt and answer' }], usage: {
        input_tokens: 100, output_tokens: output, cache_read_input_tokens: 800, cache_creation_input_tokens: 200
      } } });
  const complete = parseClaudeCodeRecord(message(50)), partial = parseClaudeCodeRecord(message(3));
  for (const events of [[complete, partial, complete], [partial, complete, partial]]) {
    const result = aggregateEvents(events, now), row = result.items[0];
    assert.equal(result.duplicates, 2);
    assert.equal(row.input_tokens, 1100); assert.equal(row.output_tokens, 50); assert.equal(row.cached_tokens, 800);
    assert.ok(!JSON.stringify(result.items).includes('private'));
  }
  const missingCache = { ...complete, timestamp: complete.timestamp - 1000, cached_tokens: null };
  assert.equal(aggregateEvents([complete, missingCache], now).items[0].cached_tokens, 800);
  const invalid = message(20); invalid.timestamp = undefined;
  assert.equal(parseClaudeCodeRecord(invalid), null);
  const contextOnly = { type: 'assistant', timestamp: timestamp(1), message: { id: 'context', usage: { total_tokens: 10000 } } };
  assert.equal(parseClaudeCodeRecord(contextOnly), null);
});

test('Claude Code scans project and subagent JSONL with provider-ID deduplication', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-claude-'));
  try {
    const folder = path.join(home, '.claude/projects/project/session/subagents');
    fs.mkdirSync(folder, { recursive: true });
    const record = { type: 'assistant', timestamp: timestamp(1), message: { id: 'message-copy', model: 'claude-observed',
      usage: { input_tokens: 5, output_tokens: 8, cache_read_input_tokens: 90, cache_creation_input_tokens: 10 } } };
    fs.writeFileSync(path.join(folder, 'subagent.jsonl'), JSON.stringify(record));
    fs.writeFileSync(path.join(home, '.claude/projects/project/session.jsonl'), JSON.stringify(record));
    const snapshot = await createSnapshot({ home, platform: 'win32', env: {}, now });
    assert.ok(snapshot.discovered.desktop_clients.includes('Claude Code'));
    assert.equal(snapshot.items.find(item => item.source === 'claude_code').input_tokens, 105);
    assert.equal(snapshot.sources.find(source => source.source === 'claude_code').duplicates_removed, 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

const cursorEvent = (id = 'private-cursor-request', days = 1) => ({ id, timestamp: String(now - days * day), model: 'claude-observed',
  tokenUsage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 30 },
  userEmail: 'private@example.test', prompt: 'private prompt', chargedCents: 5 });

test('Cursor parser accepts explicit request counters and rejects context sizes or untimed records', () => {
  const result = parseCursorRecord({ usageEvents: [cursorEvent(), { ...cursorEvent('untimed'), timestamp: undefined }],
    contextTokensUsed: 9000000, content: JSON.stringify(cursorEvent('prompt-text')) });
  assert.equal(result.events.length, 1); assert.equal(result.invalid, 1);
  assert.equal(result.events[0].input_tokens, 120); assert.equal(result.events[0].output_tokens, 20);
  assert.equal(result.events[0].cached_tokens, 80);
  assert.deepEqual(parseCursorRecord({ timestamp: timestamp(1), tokenCount: { inputTokens: 9000, outputTokens: 100 } }).events, []);
  const missingCache = cursorEvent(); delete missingCache.tokenUsage.cacheReadTokens;
  assert.equal(parseCursorRecord(missingCache).events.length, 0);
});

test('Cursor SQLite reads supported rows without modifying the database or exporting private data', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-cursor-'));
  const folder = path.join(home, 'AppData/Roaming/Cursor/User/globalStorage');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'state.vscdb');
  try {
    const db = new DatabaseSync(file);
    for (const table of ['ItemTable', 'cursorDiskKV']) {
      db.exec(`CREATE TABLE ${table} (key TEXT PRIMARY KEY, value TEXT)`);
      db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run('usageEvents', JSON.stringify({ usageEvents: [cursorEvent()] }));
    }
    db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('authUsage', JSON.stringify(cursorEvent('credential-row')));
    db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('bubbleId:context', JSON.stringify({ createdAt: timestamp(1), tokenCount: 999999 }));
    db.close();
    const before = fs.readFileSync(file);
    const parsed = await readCursorDatabase(file);
    assert.equal(parsed.events.length, 2);
    const snapshot = await createSnapshot({ home, platform: 'win32', env: {}, now });
    assert.ok(snapshot.discovered.desktop_clients.includes('Cursor IDE'));
    const source = snapshot.sources.find(source => source.source === 'cursor');
    assert.equal(source.status, 'observed'); assert.equal(source.duplicates_removed, 1);
    assert.equal(snapshot.items.find(item => item.source === 'cursor').input_tokens, 120);
    assert.deepEqual(fs.readFileSync(file), before);
    for (const privateValue of ['private@example.test', 'private prompt', 'private-cursor-request', 'credential-row', home]) {
      assert.ok(!JSON.stringify(snapshot).includes(privateValue));
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('snapshot publication uses the dedicated secret and contract and requires persisted confirmation', async () => {
  const snapshot = { schema_version: 'meter.local.v1', scanned_at: timestamp(0), discovered: {}, sources: [], items: [] };
  let captured;
  const result = await publishSnapshot(snapshot, { endpoint: 'https://meter.example.test/api/meter', token: 'private-secret',
    fetchImpl: async (url, options) => { captured = { url, options }; return { ok: true, status: 200, json: async () => ({ persisted: true }) }; } });
  assert.equal(captured.url.searchParams.get('op'), 'publish_snapshot');
  assert.equal(captured.options.headers.Authorization, 'Bearer private-secret');
  assert.equal(captured.options.redirect, 'error');
  assert.deepEqual(JSON.parse(captured.options.body), snapshot);
  assert.equal(result.persisted, true); assert.equal(result.source_scanned_at, timestamp(0));
  assert.ok(!JSON.stringify(result).includes('private-secret'));
  const failFetch = () => { throw Error('must not request'); };
  await assert.rejects(publishSnapshot(snapshot, { token: '', fetchImpl: failFetch }), /required/);
  await assert.rejects(publishSnapshot(snapshot, { token: 'secret', endpoint: 'http://public.example.test/api/meter', fetchImpl: failFetch }), /HTTPS/);
  await assert.rejects(publishSnapshot(snapshot, { token: 'secret', endpoint: 'https://meter.example.test/api/meter?op=ingest', fetchImpl: failFetch }), /different contract/);
  await assert.rejects(publishSnapshot(snapshot, { token: 'secret', fetchImpl: async () => ({ ok: true, json: async () => ({ persisted: false }) }) }), /without confirming/);
});

test('Ed25519 publication sends a verifiable body-bound signature and never sends its private key', async () => {
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const signingKey=privateKey.export({format:'pem',type:'pkcs8'});
  const snapshot={scanned_at:timestamp(0),schema_version:'meter.local.v1',discovered:{mcp_servers:[],desktop_clients:['Synthetic client']},items:[],sources:[]};
  let captured;
  await publishSnapshot(snapshot,{signingKey,token:'unused-bearer',now,fetchImpl:async(url,options)=>{captured=options;return {ok:true,status:200,json:async()=>({persisted:true})};}});
  assert.equal(captured.headers.Authorization,undefined);
  assert.equal(captured.headers['X-Meter-Timestamp'],String(now/1000));
  const hash=createHash('sha256').update(canonicalJson(JSON.parse(captured.body))).digest('hex');
  const message=Buffer.from(captured.headers['X-Meter-Timestamp']+'\n'+hash);
  const signature=Buffer.from(captured.headers['X-Meter-Signature'],'base64url');
  assert.equal(verify(null,message,publicKey,signature),true);
  assert.equal(verify(null,Buffer.from(message+'changed'),publicKey,signature),false);
  assert.ok(!JSON.stringify(captured).includes('PRIVATE KEY'));
  assert.ok(!JSON.stringify(captured).includes('unused-bearer'));
  assert.equal(canonicalJson({b:[{z:1,a:2}],a:null}),canonicalJson({a:null,b:[{a:2,z:1}]}));
});
