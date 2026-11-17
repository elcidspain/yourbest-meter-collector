#!/usr/bin/env node
// Aggregate-only local telemetry. Prompts, arguments, credentials and paths never leave this process.
// node cli/meter-scan.mjs [--output snapshot.json] [--push https://yourbest.space/api/meter?op=publish_snapshot]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import * as zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

export const WINDOWS = [7, 14, 30];
const DAY = 86400000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const validCount = n => Number.isSafeInteger(n) && n >= 0;
const modelName = value => typeof value === 'string' && /^[\w./:-]{1,100}$/.test(value) ? value : 'unknown';
const exists = file => { try { return fs.existsSync(file); } catch { return false; } };
const entries = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
const iso = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null;
const timestampMs = value => {
  if (typeof value === 'string' && /^\d{10,13}(?:\.\d+)?$/.test(value)) value = Number(value);
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? (value < 1e11 ? value * 1000 : value) : NaN;
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
};

export function localPaths(home = os.homedir(), platform = os.platform()) {
  const roaming = platform === 'darwin' ? path.join(home, 'Library/Application Support')
    : platform === 'win32' ? path.join(home, 'AppData/Roaming') : path.join(home, '.config');
  return {
    home, codex: path.join(home, '.codex'), grok: path.join(home, '.grok'),
    claudeCode: path.join(home, '.claude'),
    claude: path.join(roaming, 'Claude'),
    claudeLogs: platform === 'darwin' ? path.join(home, 'Library/Logs/Claude') : path.join(roaming, 'Claude/logs'),
    cursor: path.join(roaming, 'Cursor'),
    commander: path.join(home, '.claude-server-commander'),
    commanderRemote: path.join(home, '.desktop-commander-device'),
    packages: path.join(home, 'AppData/Local/Packages'),
    chatgpt: path.join(roaming, 'com.openai.chat'),
    ollama: path.join(home, '.ollama/models/manifests')
  };
}

export function scanInstalledStack(paths = localPaths(), env = process.env, platform = os.platform()) {
  const discovered = {
    os: `${platform} (${os.arch()})`,
    node_id: digest(os.hostname()).slice(0, 12),
    desktop_clients: [], mcp_servers: [], api_providers: [], local_models: []
  };
  if (exists(paths.codex)) discovered.desktop_clients.push('OpenAI Codex');
  if (exists(paths.grok)) discovered.desktop_clients.push('Grok Build');
  if (exists(path.join(paths.claudeCode, 'projects'))) discovered.desktop_clients.push('Claude Code');
  if (exists(paths.claude)) discovered.desktop_clients.push('Claude Desktop');
  if (exists(paths.cursor)) discovered.desktop_clients.push('Cursor IDE');
  if (exists(paths.chatgpt) || entries(paths.packages).some(e => /^OpenAI\.ChatGPT/i.test(e.name))) {
    discovered.desktop_clients.push('ChatGPT Desktop');
  }
  if (exists(paths.commander) || exists(paths.commanderRemote)) discovered.mcp_servers.push('desktop-commander');
  try {
    const config = JSON.parse(fs.readFileSync(path.join(paths.claude, 'claude_desktop_config.json'), 'utf8'));
    discovered.mcp_servers.push(...Object.keys(config.mcpServers || {}).filter(n => /^[\w.-]{1,80}$/.test(n)));
  } catch { /* configuration is optional */ }
  try {
    const config = fs.readFileSync(path.join(paths.codex, 'config.toml'), 'utf8');
    for (const match of config.matchAll(/^\s*\[mcp_servers\.(?:"([\w.-]+)"|([\w-]+))\]\s*$/gm)) {
      discovered.mcp_servers.push(match[1] || match[2]);
    }
  } catch { /* configuration is optional */ }
  const providerVariables = {
    OPENAI_API_KEY: 'openai', OPENAI_ADMIN_KEY: 'openai', ANTHROPIC_API_KEY: 'anthropic',
    ANTHROPIC_ADMIN_API_KEY: 'anthropic', ANTHROPIC_ADMIN_KEY: 'anthropic', XAI_API_KEY: 'xai', GEMINI_API_KEY: 'google', GOOGLE_API_KEY: 'google',
    PERPLEXITY_API_KEY: 'perplexity', OPENROUTER_API_KEY: 'openrouter'
  };
  for (const [key, provider] of Object.entries(providerVariables)) {
    if (env[key]) discovered.api_providers.push(provider);
  }
  // Directory names only: model tags are read from locally installed Ollama manifests.
  for (const registry of entries(paths.ollama).filter(e => e.isDirectory())) {
    for (const namespace of entries(path.join(paths.ollama, registry.name)).filter(e => e.isDirectory())) {
      for (const model of entries(path.join(paths.ollama, registry.name, namespace.name)).filter(e => e.isDirectory())) {
        if (/^[\w.-]{1,80}$/.test(model.name)) discovered.local_models.push(model.name);
      }
    }
  }
  for (const key of ['desktop_clients', 'mcp_servers', 'api_providers', 'local_models']) {
    discovered[key] = [...new Set(discovered[key])].sort();
  }
  return discovered;
}

function walkFiles(root, accept, depth = 0) {
  if (depth > 8) return [];
  return entries(root).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(file, accept, depth + 1)
      : entry.isFile() && accept(entry.name) ? [file] : [];
  });
}

async function forEachLine(file, consume) {
  if (file.endsWith('.zst') && !zlib.createZstdDecompress) throw new Error('unsupported_zstd');
  return new Promise((resolve, reject) => {
    const raw = fs.createReadStream(file);
    const input = file.endsWith('.zst') ? raw.pipe(zlib.createZstdDecompress()) : raw;
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let done = false;
    let timer = setTimeout(() => finish(new Error('read_timeout')), 15000);
    // Bound stalled I/O, while allowing a large readable log to finish.
    input.on('data', () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('read_timeout')), 15000); });
    function finish(error) {
      if (done) return; done = true; clearTimeout(timer);
      lines.close(); input.destroy(); raw.destroy();
      if (error) reject(error); else resolve();
    }
    raw.on('error', finish); if (input !== raw) input.on('error', finish);
    lines.on('error', finish);
    lines.on('line', line => { try { consume(line); } catch (error) { finish(error); } });
    lines.once('close', () => finish());
  });
}

function usageCounts(value) {
  if (!value || !validCount(value.input_tokens) || !validCount(value.output_tokens)) return null;
  if (!validCount(value.input_tokens + value.output_tokens)) return null;
  const cached = value.cached_input_tokens ?? value.input_cached_tokens ?? value.cached_tokens;
  if (cached != null && (!validCount(cached) || cached > value.input_tokens)) return null;
  return { input_tokens: value.input_tokens, output_tokens: value.output_tokens, cached_tokens: cached ?? null };
}

// Modern Codex writes one usage record per response. Legacy token_count entries are cumulative.
// A response ID deduplicates copied/forked histories without exposing that ID in the snapshot.
export function createCodexParser(fileIdentity = 'session') {
  let session = fileIdentity, currentModel = 'unknown', previousTotal = null;
  let firstModern = Infinity, invalid = 0;
  const turns = new Map(), modern = [], legacy = [];
  function consume(record) {
    const payload = record.payload || {};
    const timestamp = Date.parse(record.timestamp);
    if (record.type === 'session_meta' && payload.id) session = payload.id;
    if (record.type === 'turn_context') {
      currentModel = modelName(payload.model);
      if (payload.turn_id) turns.set(payload.turn_id, currentModel);
    }
    if (!Number.isFinite(timestamp)) return;
    if (record.type === 'token_usage_record') {
      const usage = usageCounts(payload.usage);
      if (!usage) { invalid++; return; }
      firstModern = Math.min(firstModern, timestamp);
      modern.push({
        key: digest(`response:${payload.response_id || `${payload.thread_id || session}:${timestamp}:${JSON.stringify(usage)}`}`),
        timestamp, source: 'codex', model: modelName(payload.model || (payload.turn_id ? turns.get(payload.turn_id) : currentModel)),
        unit: 'tokens', ...usage, method: 'per_response_token_telemetry'
      });
      return;
    }
    if (record.type !== 'event_msg' || payload.type !== 'token_count' || !payload.info) return;
    const total = usageCounts(payload.info.total_token_usage);
    const last = usageCounts(payload.info.last_token_usage);
    if (!total) { invalid++; return; }
    let usage = last;
    if (previousTotal) {
      if (total.input_tokens === previousTotal.input_tokens && total.output_tokens === previousTotal.output_tokens) return;
      if (total.input_tokens >= previousTotal.input_tokens && total.output_tokens >= previousTotal.output_tokens) {
        const deltaCached = total.cached_tokens == null || previousTotal.cached_tokens == null
          ? null : total.cached_tokens - previousTotal.cached_tokens;
        usage = usageCounts({
          input_tokens: total.input_tokens - previousTotal.input_tokens,
          output_tokens: total.output_tokens - previousTotal.output_tokens,
          cached_tokens: deltaCached
        });
      }
    }
    previousTotal = total;
    if (!usage) { invalid++; return; }
    legacy.push({
      key: digest(`legacy:${session}:${timestamp}:${JSON.stringify(total)}`),
      timestamp, source: 'codex', model: currentModel, unit: 'tokens', ...usage,
      method: 'cumulative_token_delta'
    });
  }
  return { consume, finish: () => ({
    events: [...legacy.filter(event => event.timestamp < firstModern), ...modern], invalid
  }) };
}

function grokCounts(value) {
  if (!value || !validCount(value.inputTokens) || !validCount(value.outputTokens)) return null;
  const input = value.inputTokens, output = value.outputTokens;
  if (!validCount(input + output)) return null;
  if (value.totalTokens != null && value.totalTokens !== input + output) return null;
  const cached = value.cachedReadTokens;
  const creation = value.cacheCreationTokens;
  if (cached != null && (!validCount(cached) || cached > input)) return null;
  if (creation != null && (!validCount(creation) || creation + (cached || 0) > input)) return null;
  // Grok Build's outputTokens already includes reasoningTokens. This is not the
  // legacy xAI Chat Completions shape, where reasoning may be reported separately.
  return { input_tokens: input, output_tokens: output, cached_tokens: cached ?? null,
    ...(validCount(value.modelCalls) ? { model_calls: value.modelCalls } : {}),
    ...(validCount(value.costUsdTicks) ? { client_cost_usd_ticks: value.costUsdTicks } : {}) };
}

function grokTurnEvents(usage, { session, identity, timestamp, model, method }) {
  const total = grokCounts(usage);
  if (!total) return null;
  const models = usage.modelUsage && typeof usage.modelUsage === 'object' && !Array.isArray(usage.modelUsage)
    ? Object.entries(usage.modelUsage).map(([name, value]) => ({ name: modelName(name), usage: grokCounts(value) })) : [];
  // Split a turn by model only when the model counters reconcile to the turn.
  // Otherwise preserve its measured total with no guessed model attribution.
  const reconciled = models.length > 0 && models.every(row => row.usage) &&
    ['input_tokens', 'output_tokens'].every(field => models.reduce((sum, row) => sum + row.usage[field], 0) === total[field]);
  const rows = reconciled ? models : [{ name: models.length > 1 ? 'unknown' : modelName(model), usage: total }];
  return rows.map(row => ({
    key: digest(`grok-build:${session}:${identity}:${row.name}`), timestamp, source: 'grok_build',
    model: row.name, unit: 'tokens', ...row.usage, method
  }));
}

// Observed Grok Build usage.json schema: session is cumulative, turns are
// incremental and timestamped. Never attribute the session balance to updatedAt.
export function parseGrokUsage(record, fileIdentity = 'session') {
  const events = []; let invalid = 0;
  if (!record || !Array.isArray(record.turns)) return { events, invalid: 1 };
  const session = typeof record.sessionId === 'string' ? record.sessionId : fileIdentity;
  for (const turn of record.turns) {
    const timestamp = timestampMs(turn?.endedAt);
    if (!Number.isFinite(timestamp) || !validCount(turn?.turnNumber)) { invalid++; continue; }
    const parsed = grokTurnEvents(turn, { session, identity: `turn:${turn.turnNumber}`, timestamp,
      model: turn.primaryModelId, method: 'grok_build_timestamped_turn_usage' });
    if (parsed) events.push(...parsed); else invalid++;
  }
  return { events, invalid };
}

// Used only when a session has no readable usage.json. updates.jsonl repeats
// usage.json; reading both for the same session would count every turn twice.
export function parseGrokUpdate(record) {
  const update = record?.params?.update;
  if (update?.sessionUpdate !== 'turn_completed' || !update.usage) return null;
  const timestamp = timestampMs(record.timestamp);
  if (!Number.isFinite(timestamp) || typeof record.params.sessionId !== 'string' || typeof update.prompt_id !== 'string') return { events: [], invalid: 1 };
  const events = grokTurnEvents(update.usage, { session: record.params.sessionId, identity: `prompt:${update.prompt_id}`,
    timestamp, model: update.primaryModelId, method: 'grok_build_completed_update_usage' });
  return { events: events || [], invalid: events ? 0 : 1 };
}

// Claude Code assistant records can repeat a message while streaming, or be
// copied into subagent/fork transcripts. The provider message ID is the key.
export function parseClaudeCodeRecord(record) {
  if (record?.type !== 'assistant' || !record.message?.usage) return null;
  const message = record.message, usage = message.usage;
  const timestamp = timestampMs(record.timestamp);
  if (!Number.isFinite(timestamp) || typeof message.id !== 'string' || !message.id) return null;
  const cached = usage.cache_read_input_tokens ?? 0, creation = usage.cache_creation_input_tokens ?? 0;
  if (![usage.input_tokens, usage.output_tokens, cached, creation].every(validCount)) return null;
  const input = usage.input_tokens + cached + creation;
  if (!validCount(input) || !validCount(input + usage.output_tokens)) return null;
  return { key: digest(`claude-code:${message.id}`), timestamp, source: 'claude_code', model: modelName(message.model),
    unit: 'tokens', input_tokens: input, output_tokens: usage.output_tokens, cached_tokens: cached,
    method: 'claude_code_message_usage' };
}

// Cursor does not document state.vscdb as a billing contract. Accept only
// timestamped request records carrying explicit tokenUsage counters; context
// sizes, prompt text, message lengths, and database modification dates are not usage.
export function parseCursorRecord(record, rowIdentity = 'record') {
  const events = []; let invalid = 0, visited = 0;
  function visit(value, identity, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8 || ++visited > 100000) return;
    if (Array.isArray(value)) { value.forEach((entry, i) => visit(entry, `${identity}:${i}`, depth + 1)); return; }
    if (value.tokenUsage && typeof value.tokenUsage === 'object') {
      const usage = value.tokenUsage;
      const timestamp = timestampMs(value.timestamp ?? value.createdAt ?? value.created_at);
      const cached = usage.cacheReadTokens, creation = usage.cacheWriteTokens;
      // The four Cursor usage categories are disjoint in its usage-events API.
      // Requiring the cache fields avoids guessing for undocumented tokenCount blobs.
      if (!Number.isFinite(timestamp) || ![usage.inputTokens, usage.outputTokens, cached, creation].every(validCount)) { invalid++; return; }
      const input = usage.inputTokens + cached + creation;
      if (!validCount(input) || !validCount(input + usage.outputTokens) || (usage.totalTokens != null && usage.totalTokens !== input + usage.outputTokens)) { invalid++; return; }
      const stableId = value.requestId ?? value.request_id ?? value.usageEventId ?? value.id ?? value.bubbleId;
      const model = modelName(value.model ?? value.modelName);
      const fallback = `${timestamp}:${model}:${input}:${usage.outputTokens}:${cached}:${value.conversationId || identity}`;
      events.push({ key: digest(`cursor-usage:${typeof stableId === 'string' ? stableId : fallback}`), timestamp,
        source: 'cursor', model, unit: 'tokens', input_tokens: input, output_tokens: usage.outputTokens,
        cached_tokens: cached, method: 'cursor_sqlite_explicit_usage' });
      return;
    }
    for (const key of ['usageEvents', 'events', 'records', 'data', 'bubbles', 'conversation', 'fullConversation', 'allComposers', 'composers']) {
      if (value[key] && typeof value[key] === 'object') visit(value[key], `${identity}:${key}`, depth + 1);
    }
  }
  visit(record, rowIdentity);
  return { events, invalid };
}

export async function readCursorDatabase(file) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { throw new Error('unsupported_sqlite'); }
  let db; const events = []; let invalid = 0, rows = 0;
  try {
    db = new DatabaseSync(file, { readOnly: true, enableExtension: false });
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ItemTable','cursorDiskKV')").all();
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map(column => column.name);
      if (!columns.includes('key') || !columns.includes('value')) continue;
      const query = db.prepare(`SELECT key, value FROM "${name}" WHERE length(value) <= 16777216 AND (key LIKE 'bubbleId:%' OR key LIKE 'composerData:%' OR lower(key) LIKE '%usage%')`);
      for (const row of query.iterate()) {
        if (/auth|secret|credential|api.?key|access.?token|refresh.?token/i.test(row.key)) continue;
        rows++;
        let value;
        try { value = JSON.parse(Buffer.isBuffer(row.value) || row.value instanceof Uint8Array ? Buffer.from(row.value).toString('utf8') : row.value); }
        catch { continue; }
        const result = parseCursorRecord(value, row.key);
        events.push(...result.events); invalid += result.invalid;
      }
    }
    return { events, invalid, rows };
  } finally { if (db) db.close(); }
}

export function parseCommanderLine(line) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s*\|\s*([\w-]+)\s*\|/.exec(line);
  if (!match) return null;
  return { key: digest(`commander:${line}`), timestamp: Date.parse(match[1]), source: 'desktop_commander',
    model: 'unknown', unit: 'tool_calls', amount: 1, method: 'timestamped_tool_calls' };
}

function parseClaudeLine(line, server) {
  if (!/"method"\s*:\s*"tools\/call"/.test(line)) return null;
  const stamp = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/.exec(line);
  if (!stamp) return null;
  if (!/Message from client|Received.*(?:request|message)|\brequest\b/i.test(line)) return null;
  const id = /"id"\s*:\s*("[^"]+"|\d+)/.exec(line)?.[1];
  return { key: digest(`claude:${server}:${stamp[0]}:${id || line}`), timestamp: Date.parse(stamp[0]),
    source: 'claude_mcp', model: 'unknown', unit: 'tool_calls', amount: 1, method: 'timestamped_tool_calls' };
}

function sourceMeta(source, method) {
  return { source, method, status: 'unavailable', records: 0, files_scanned: 0, files_failed: 0,
    unsupported_files: 0, timed_out_files: 0, invalid_records: 0, duplicates_removed: 0, earliest_event: null, latest_event: null, notes: [] };
}

export function aggregateEvents(events, now = Date.now()) {
  const unique = new Map();
  for (const event of events) {
    if (!Number.isFinite(event.timestamp) || event.timestamp > now) continue;
    const previous = unique.get(event.key);
    // Streaming snapshots of the same provider response may be read in any
    // file order. Retain its most complete counters; never add partial copies.
    const size = value => value.unit === 'tokens' ? value.input_tokens + value.output_tokens : value.amount;
    const cachedKnown = value => value.cached_tokens != null;
    if (!previous || size(event) > size(previous) ||
      (size(event) === size(previous) && cachedKnown(event) && !cachedKnown(previous)) ||
      (size(event) === size(previous) && cachedKnown(event) === cachedKnown(previous) && event.timestamp < previous.timestamp)) unique.set(event.key, event);
  }
  const items = [];
  for (const days of WINDOWS) {
    const groups = new Map();
    for (const event of unique.values()) {
      if (event.timestamp < now - days * DAY) continue;
      const key = `${event.source}:${event.model}:${event.unit}`;
      let item = groups.get(key);
      if (!item) {
        item = { source: event.source, model: event.model, unit: event.unit, window_days: days,
          ...(event.unit === 'tokens' ? { input_tokens: 0, output_tokens: 0, cached_tokens: 0 } : { amount: 0 }),
          evidence: { method: event.method, records: 0, observed_from: iso(event.timestamp),
            observed_to: iso(event.timestamp), scope: 'retained_local_logs' } };
        groups.set(key, item);
      }
      if (event.unit === 'tokens') {
        item.input_tokens += event.input_tokens; item.output_tokens += event.output_tokens;
        item.cached_tokens = item.cached_tokens == null || event.cached_tokens == null ? null : item.cached_tokens + event.cached_tokens;
      } else item.amount += event.amount;
      item.evidence.records++;
      item.evidence.observed_from = iso(Math.min(Date.parse(item.evidence.observed_from), event.timestamp));
      item.evidence.observed_to = iso(Math.max(Date.parse(item.evidence.observed_to), event.timestamp));
      if (item.evidence.method !== event.method) item.evidence.method = 'recorded_token_telemetry';
    }
    items.push(...[...groups.values()].sort((a, b) => `${a.source}:${a.model}`.localeCompare(`${b.source}:${b.model}`)));
  }
  return { items, events: [...unique.values()], duplicates: events.length - unique.size };
}

export async function scanLocalUsage(paths = localPaths(), now = Date.now(), onProgress = () => {}) {
  const events = [], sources = [];
  const codex = sourceMeta('codex', 'local_token_telemetry');
  const codexFiles = [...walkFiles(path.join(paths.codex, 'sessions'), name => /\.jsonl(?:\.zst)?$/.test(name)),
    ...walkFiles(path.join(paths.codex, 'archived_sessions'), name => /\.jsonl(?:\.zst)?$/.test(name))];
  let cursor = 0, completed = 0;
  async function worker() {
    while (cursor < codexFiles.length) {
      const file = codexFiles[cursor++], parser = createCodexParser(digest(file));
      try {
        await forEachLine(file, line => {
          if (!/"(?:session_meta|turn_context|token_usage_record|token_count)"/.test(line)) return;
          try { parser.consume(JSON.parse(line)); } catch { codex.invalid_records++; }
        });
        const parsed = parser.finish(); events.push(...parsed.events); codex.invalid_records += parsed.invalid;
        codex.files_scanned++;
      } catch (error) {
        codex.files_failed++;
        if (error.message === 'unsupported_zstd') codex.unsupported_files++;
        if (error.message === 'read_timeout') codex.timed_out_files++;
      }
      completed++;
      if (completed % 10 === 0 || completed === codexFiles.length) onProgress({ source: 'codex', completed, total: codexFiles.length, failed: codex.files_failed });
    }
  }
  onProgress({ source: 'codex', completed: 0, total: codexFiles.length, failed: 0 });
  await Promise.all(Array.from({ length: Math.min(3, codexFiles.length) }, worker));
  codex.notes.push('Retained local Codex telemetry only; deleted sessions and other devices are outside coverage. Cached input is included in input tokens.');
  sources.push(codex);

  const grok = sourceMeta('grok_build', 'grok_build_timestamped_turn_usage');
  const grokSessions = path.join(paths.grok, 'sessions'), measuredSessions = new Set();
  for (const file of walkFiles(grokSessions, name => name === 'usage.json')) {
    try {
      if (fs.statSync(file).size > 16777216) { grok.unsupported_files++; continue; }
      const result = parseGrokUsage(JSON.parse(fs.readFileSync(file, 'utf8')), digest(path.dirname(file)));
      events.push(...result.events); grok.invalid_records += result.invalid; grok.files_scanned++;
      if (result.events.length || !result.invalid) measuredSessions.add(path.dirname(file));
    } catch { grok.files_failed++; }
  }
  for (const file of walkFiles(grokSessions, name => name === 'updates.jsonl')) {
    if (measuredSessions.has(path.dirname(file))) continue;
    try {
      await forEachLine(file, line => {
        if (!line.includes('turn_completed')) return;
        try { const result = parseGrokUpdate(JSON.parse(line)); if (result) { events.push(...result.events); grok.invalid_records += result.invalid; } }
        catch { grok.invalid_records++; }
      });
      grok.files_scanned++;
    } catch (error) { grok.files_failed++; if (error.message === 'read_timeout') grok.timed_out_files++; }
  }
  // Completed tool records have stable call IDs. Started records have no ID and
  // are deliberately not mixed with completions or token/model-call counts.
  for (const file of walkFiles(grokSessions, name => name === 'events.jsonl')) {
    let session = digest(path.dirname(file)), model = 'unknown';
    try {
      await forEachLine(file, line => {
        if (!/"(?:turn_started|tool_completed)"/.test(line)) return;
        let record; try { record = JSON.parse(line); } catch { grok.invalid_records++; return; }
        if (record.type === 'turn_started') {
          if (typeof record.session_id === 'string') session = record.session_id;
          model = modelName(record.model_id); return;
        }
        const timestamp = timestampMs(record.ts);
        if (record.type !== 'tool_completed' || !Number.isFinite(timestamp) || typeof record.tool_call_id !== 'string') return;
        events.push({ key: digest(`grok-tool:${session}:${record.tool_call_id}`), timestamp, source: 'grok_build', model,
          unit: 'tool_calls', amount: 1, method: 'timestamped_completed_tool_calls' });
      });
      grok.files_scanned++;
    } catch (error) { grok.files_failed++; if (error.message === 'read_timeout') grok.timed_out_files++; }
  }
  grok.notes.push('Completed turn usage only. Session totals and context-size counters are excluded. Cached input and output reasoning are already included in token totals. Completed tools are counted separately.');
  sources.push(grok);
  onProgress({ source: 'grok_build', completed: grok.files_scanned, failed: grok.files_failed });

  const claudeCode = sourceMeta('claude_code', 'claude_code_message_usage');
  for (const file of walkFiles(path.join(paths.claudeCode, 'projects'), name => /\.jsonl$/.test(name))) {
    try {
      await forEachLine(file, line => {
        if (!/"usage"\s*:/.test(line)) return;
        let record; try { record = JSON.parse(line); } catch { claudeCode.invalid_records++; return; }
        const event = parseClaudeCodeRecord(record);
        if (event) events.push(event);
        else if (record.type === 'assistant' && record.message?.usage) claudeCode.invalid_records++;
      });
      claudeCode.files_scanned++;
    } catch (error) { claudeCode.files_failed++; if (error.message === 'read_timeout') claudeCode.timed_out_files++; }
  }
  claudeCode.notes.push('Provider message IDs deduplicate streaming and copied transcripts. Input equals uncached input plus cache creation plus cache reads. Subscription fees and billed cash are outside this measurement.');
  sources.push(claudeCode);
  onProgress({ source: 'claude_code', completed: claudeCode.files_scanned, failed: claudeCode.files_failed });

  const cursorUsage = sourceMeta('cursor', 'cursor_sqlite_explicit_usage');
  for (const file of walkFiles(path.join(paths.cursor, 'User'), name => name === 'state.vscdb')) {
    try {
      const result = await readCursorDatabase(file);
      events.push(...result.events); cursorUsage.invalid_records += result.invalid; cursorUsage.files_scanned++;
      if (!result.events.length) cursorUsage.unsupported_files++;
    } catch (error) {
      cursorUsage.files_failed++;
      if (error.message === 'unsupported_sqlite') cursorUsage.unsupported_files++;
    }
  }
  cursorUsage.notes.push('Read-only SQLite scan accepts explicit timestamped tokenUsage records only. Cursor database formats vary; absent counters are unavailable evidence. Token counts are not inferred from conversation text or context length.');
  sources.push(cursorUsage);
  onProgress({ source: 'cursor', completed: cursorUsage.files_scanned, failed: cursorUsage.files_failed });

  const commander = sourceMeta('desktop_commander', 'timestamped_tool_calls');
  for (const file of walkFiles(paths.commander, name => /^claude_tool_call(?:_.*)?\.log$/.test(name))) {
    try { await forEachLine(file, line => { const event = parseCommanderLine(line); if (event) events.push(event); }); commander.files_scanned++; }
    catch (error) { commander.files_failed++; if (error.message === 'read_timeout') commander.timed_out_files++; }
  }
  commander.notes.push('Counts logged local tool invocations. Tool calls do not identify model tokens or charges.');
  sources.push(commander);

  const claude = sourceMeta('claude_mcp', 'timestamped_tool_calls');
  for (const file of walkFiles(paths.claudeLogs, name => /mcp.*\.log(?:\.\d+)?$/.test(name))) {
    try {
      const server = path.basename(file).replace(/\.log.*$/, '');
      await forEachLine(file, line => { const event = parseClaudeLine(line, server); if (event) events.push(event); });
      claude.files_scanned++;
    } catch (error) { claude.files_failed++; if (error.message === 'read_timeout') claude.timed_out_files++; }
  }
  claude.notes.push('Timestamped incoming tools/call requests only; timestamps absent from log entries are excluded.');
  sources.push(claude);

  const aggregated = aggregateEvents(events, now);
  for (const source of sources) {
    const all = aggregated.events.filter(event => event.source === source.source);
    const recent = all.filter(event => event.timestamp >= now - 30 * DAY);
    source.records = recent.length;
    source.duplicates_removed = events.filter(event => event.source === source.source).length - all.length;
    if (all.length) {
      source.earliest_event = iso(all.reduce((minimum, event) => Math.min(minimum, event.timestamp), Infinity));
      source.latest_event = iso(all.reduce((maximum, event) => Math.max(maximum, event.timestamp), -Infinity));
    }
    source.status = source.files_failed || source.invalid_records || source.unsupported_files ? 'partial' : source.files_scanned ? 'observed' : 'unavailable';
    if (!source.files_scanned) source.notes.push('No readable supported logs were found. This is missing evidence, not zero usage.');
    if (source.source === 'grok_build') {
      const tokenRows = recent.filter(event => event.unit === 'tokens');
      if (tokenRows.length && tokenRows.every(event => validCount(event.model_calls))) {
        source.notes.push(`Recorded model calls in the last 30 days: ${tokenRows.reduce((sum, event) => sum + event.model_calls, 0)}. These are separate from completed tool calls.`);
      }
      if (tokenRows.length && tokenRows.every(event => validCount(event.client_cost_usd_ticks))) {
        const ticks = tokenRows.reduce((sum, event) => sum + event.client_cost_usd_ticks, 0);
        if (validCount(ticks)) source.notes.push(`Client-reported Grok usage cost in the last 30 days: USD ${(ticks / 1e10).toFixed(10)} (costUsdTicks / 10^10). This is unreconciled client telemetry, not subscription charges or an invoice.`);
      }
    }
    if (source.source === 'cursor' && source.files_scanned && !all.length) source.notes.push('SQLite files were readable but no supported timestamped request counters were found. Use an authorized Cursor usage export for billing reconciliation.');
  }
  return { items: aggregated.items, sources };
}

// OpenAI organization usage API: model grouping, end_time and complete pagination.
// https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage
export async function fetchOpenAiUsage({ key = process.env.OPENAI_ADMIN_KEY, now = Date.now(), fetchImpl = fetch } = {}) {
  const source = sourceMeta('openai', 'organization_usage_api'), items = [];
  if (!key) {
    source.notes.push('OpenAI organization usage was not requested because OPENAI_ADMIN_KEY is not configured.');
    return { items, source };
  }
  let failed = false;
  for (const days of WINDOWS) {
    const start = Math.floor((now - days * DAY) / 1000), end = Math.floor(now / 1000);
    const models = new Map(), cursors = new Set(); let page = null;
    try {
      do {
        const url = new URL('https://api.openai.com/v1/organization/usage/completions');
        url.searchParams.set('start_time', String(start)); url.searchParams.set('end_time', String(end));
        url.searchParams.set('bucket_width', '1d'); url.searchParams.set('limit', '31');
        url.searchParams.append('group_by[]', 'model'); if (page) url.searchParams.set('page', page);
        const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`http_${response.status}`);
        const json = await response.json(); if (!Array.isArray(json.data)) throw new Error('invalid_usage_response');
        for (const bucket of json.data) for (const row of bucket.results || []) {
          const usage = usageCounts(row); if (!usage) { source.invalid_records++; continue; }
          const model = modelName(row.model);
          const item = models.get(model) || { source: 'openai', model, unit: 'tokens', window_days: days,
            input_tokens: 0, output_tokens: 0, cached_tokens: 0,
            evidence: { method: 'organization_usage_api', records: 0, observed_from: iso(start * 1000), observed_to: iso(end * 1000), scope: 'organization_usage_api' } };
          item.input_tokens += usage.input_tokens; item.output_tokens += usage.output_tokens;
          item.cached_tokens = item.cached_tokens == null || usage.cached_tokens == null ? null : item.cached_tokens + usage.cached_tokens;
          item.evidence.records++; models.set(model, item);
        }
        page = json.has_more ? json.next_page : null;
        if (json.has_more && (!page || cursors.has(page))) throw new Error('invalid_pagination');
        if (page) cursors.add(page);
      } while (page);
      items.push(...models.values());
    } catch (error) {
      failed = true;
      source.notes.push(`Window ${days}d unavailable: ${/^http_\d+$/.test(error.message) ? error.message : 'request_or_parse_failed'}.`);
    }
  }
  source.status = failed || source.invalid_records ? 'partial' : 'observed';
  source.records = items.reduce((n, item) => n + item.evidence.records, 0);
  source.notes.push('Organization API usage excludes ChatGPT subscriptions. Local Codex API usage may overlap this scope; compare sources separately.');
  return { items, source };
}

export async function createSnapshot({ home = os.homedir(), platform = os.platform(), env = process.env, now = Date.now(), fetchImpl = fetch, onProgress = () => {} } = {}) {
  const paths = localPaths(home, platform);
  const local = await scanLocalUsage(paths, now, onProgress);
  const api = await fetchOpenAiUsage({ key: env.OPENAI_ADMIN_KEY || null, now, fetchImpl });
  return {
    schema_version: 'meter.local.v1',
    discovered: scanInstalledStack(paths, env, platform), items: [...local.items, ...api.items], scanned_at: iso(now),
    coverage: { status: 'partial', scope: 'retained_local_logs_and_authorized_api', timezone: 'UTC',
      windows: Object.fromEntries(WINDOWS.map(days => [`${days}d`, { from: iso(now - days * DAY), to: iso(now), status: 'partial' }])),
      note: 'Measured retained logs only. Missing providers or deleted history are not zero. Tool calls are separate from tokens. Configured providers are not proof of use.' },
    sources: [...local.sources, api.source]
  };
}

export async function publishSnapshot(snapshot, {
  endpoint = 'https://yourbest.space/api/meter?op=publish_snapshot',
  signingKey = process.env.METER_LOCAL_SIGNING_KEY,
  token = process.env.METER_LOCAL_SECRET || process.env.METER_PUSH_TOKEN, fetchImpl = fetch, now = Date.now()
} = {}) {
  if ((!signingKey || typeof signingKey !== 'string') && (typeof token !== 'string' || !token.trim())) throw new Error('METER_LOCAL_SIGNING_KEY or METER_LOCAL_SECRET/METER_PUSH_TOKEN is required to publish a local snapshot.');
  const url = new URL(endpoint);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('An HTTPS snapshot endpoint is required.');
  }
  if (url.searchParams.has('op') && url.searchParams.get('op') !== 'publish_snapshot') throw new Error('Local snapshots require op=publish_snapshot; the event ingestion endpoint uses a different contract.');
  url.searchParams.set('op', 'publish_snapshot');
  const body = JSON.stringify(snapshot), headers = { 'Content-Type': 'application/json' };
  if (signingKey) {
    const key = crypto.createPrivateKey(signingKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('The snapshot signing key must be Ed25519.');
    const timestamp = String(Math.floor(now / 1000));
    const message = `${timestamp}\n${digest(canonicalJson(JSON.parse(body)))}`;
    headers['X-Meter-Timestamp'] = timestamp;
    headers['X-Meter-Signature'] = crypto.sign(null, Buffer.from(message), key).toString('base64url');
  } else headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
    headers, body, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Meter snapshot publication failed (${response.status}).`);
  const report = await response.json();
  if (report.persisted !== true) throw new Error('Meter accepted the request without confirming durable snapshot storage.');
  return { delivered: true, status: response.status, persisted: true, mode: 'published_local_snapshot',
    source_scanned_at: report.source_scanned_at || snapshot.scanned_at };
}

export function canonicalJson(value) {
  const sorted = item => Array.isArray(item) ? item.map(sorted)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])])) : item;
  return JSON.stringify(sorted(value));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node cli/meter-scan.mjs [--output snapshot.json] [--push https://yourbest.space/api/meter?op=publish_snapshot]\nPublishing requires METER_LOCAL_SIGNING_KEY (Ed25519) or a compatible bearer credential. Only sanitized aggregates are uploaded.'); return;
  }
  const snapshot = await createSnapshot({ onProgress: progress => console.error(JSON.stringify({ meter_scan: progress })) });
  const text = JSON.stringify(snapshot, null, 2) + '\n';
  const outputIndex = args.indexOf('--output');
  if (outputIndex !== -1) {
    const output = args[outputIndex + 1]; if (!output || output.startsWith('--')) throw new Error('An output filename is required.');
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, text, { mode: 0o600 });
    console.log(JSON.stringify({ saved: true, scanned_at: snapshot.scanned_at, items: snapshot.items.length }));
  } else process.stdout.write(text);
  const pushIndex = args.indexOf('--push');
  if (pushIndex !== -1) {
    const endpoint = args[pushIndex + 1];
    if (!endpoint || endpoint.startsWith('--')) throw new Error('A snapshot endpoint is required after --push.');
    console.error(JSON.stringify(await publishSnapshot(snapshot, { endpoint })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
