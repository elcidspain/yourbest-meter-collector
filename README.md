# YourBest METER Collector

Observed AI usage from retained local logs, with explicit source coverage and separate token/tool-call counters.

Built for [YourBest METER](https://yourbest.space/meter) and the [AUMARA](https://aumara.me) workation ecosystem. This repository contains the standalone collector and provider usage adapters. It contains no production snapshots, credentials, conversation content or private application code.

## Run locally

Requires Node.js **22.15 or newer**. Node 22.17 and Node 24 are supported. There are no runtime npm dependencies. The built-in SQLite API can emit an experimental-feature warning on Node 22.

```sh
node cli/meter-scan.mjs --output ./snapshot.json
```

The collector uses the current operating-system account's standard application directories. The output contains aggregate windows for 7, 14 and 30 days ending at `scanned_at`.

| Source | Measurement | Limits |
| --- | --- | --- |
| OpenAI Codex | Per-response token records; supported cumulative logs use counter deltas | Retained session files only; copied response IDs are deduplicated |
| Grok Build | Timestamped turn/model usage from retained usage files | Session lifetime totals are never assigned to an arbitrary recent window |
| Claude Code | Timestamped message token usage including cache creation/read components | Copied records are deduplicated; absent usage stays unknown |
| Cursor | Supported timestamped usage fields in `state.vscdb` | Read-only SQLite; arbitrary stored conversation text is not exported |
| Desktop Commander / Claude MCP | Timestamped tool calls | Calls remain a separate unit and are never converted to tokens |
| OpenAI organization usage | Official usage API, when an `OPENAI_ADMIN_KEY` is configured | Organization scope can overlap local Codex; compare it separately |

Installed clients and configured API-provider names are discovery signals. They are not evidence that the corresponding account was used.

### Run every five minutes

```sh
node cli/meter-daemon.mjs --output ./snapshot.json
```

The daemon runs scans sequentially at a default interval of 300 seconds. A long scan finishes before another begins. `--once` performs one run. `--interval-seconds` accepts 60–86400 seconds. Stop with Ctrl+C. The operating system may suspend or terminate this process when the device sleeps or signs out; use the device's service manager when persistent startup is required.

## Publish aggregates

Publishing is opt-in. The preferred setup registers an Ed25519 **public** key with the receiving server and keeps the private key on the collecting device. Set `METER_LOCAL_SIGNING_KEY` to the private key's PEM text in the process environment, then run:

```sh
node cli/meter-scan.mjs --output ./snapshot.json --push https://yourbest.space/api/meter?op=publish_snapshot
```

The same `--push` option works with the daemon. Every signed request carries `X-Meter-Timestamp` (Unix seconds) and `X-Meter-Signature` (base64url Ed25519 signature over the timestamp, a newline, and the lowercase SHA-256 of recursively key-sorted JSON). The server verifies body integrity and freshness. The private key is never transmitted. Compatible servers can also accept the older `METER_LOCAL_SECRET` / `METER_PUSH_TOKEN` bearer option.

The hosted YourBest endpoint requires a registered public key or authorized bearer credential. Other installations can supply their own compatible HTTPS endpoint. The collector rejects redirects and rejects a success response unless it contains `persisted: true`.

Publication sends a JSON body with `schema_version`, `scanned_at`, `discovered`, `items`, `coverage` and `sources`. Each aggregate item carries an explicit `source`, `window_days`, `unit` and measured counters. The server's `publish_snapshot` contract is separate from per-request event ingestion.

No network publication happens without `--push`. Configuring `OPENAI_ADMIN_KEY` enables read-only retrieval from the official OpenAI organization usage API during a scan.

### Windows scheduled task

`node cli/meter-install-windows.mjs` prepares a five-minute Task Scheduler entry for the current signed-in user using the supported Task Scheduler XML format. It does not change PowerShell execution policy. The installer defaults to a **disabled** task, allowing the receiving endpoint and local credential to be set up first. Its `--enable` switch activates the schedule; `--start-now` additionally requests an immediate run. `--publish` specifies the authorized HTTPS publication endpoint. A PowerShell installer is also included for environments where local PowerShell scripts are enabled.

The task calls `cli/meter-task.mjs` from `%LOCALAPPDATA%\YourBestMeter`. The default signed configuration names `publish-key.dpapi`, containing the PEM private key encrypted with PowerShell `ConvertFrom-SecureString` for the current Windows user. The private key is decrypted only in memory during publication. `config.json` stores the public HTTPS endpoint and local filenames, never the private key.

Scheduled runs use a process lock, atomic snapshot replacement, three publication attempts for the same measured snapshot and an aggregate `last-run.json` status file. Failed publication preserves the local snapshot and is retried on a subsequent run. Task Scheduler uses `IgnoreNew` to prevent overlapping task instances. Collection resumes when the signed-in device becomes available after a missed run; it cannot collect while the device is off.

### Bounded local event cache

The Windows installers enable `cache_file: "event-cache.json"` in the local task configuration. Standalone CLI scans remain uncached. Library callers can opt in with `createSnapshot({ cacheFile })`; the optional `onCache` callback receives aggregate cache statistics.

The cache contains allowlisted normalized counters, hashed event identities, model/source names and original event timestamps. It contains no prompts, completions, tool arguments, raw session IDs, source paths or credentials. It is local to the collecting device and is never included in the published snapshot.

An unchanged file is reused only when its identity, size and modification metadata match. Source streams use a bounded 1 MiB read buffer, a 60-second idle timeout and one full retry after a stalled read. Failed partial parses are discarded. Changed, truncated, replaced or actively growing files are reparsed completely; files changing during a read are not cached. Global event-ID deduplication and the 7/14/30-day windows are recomputed for every scan. Cached records retain their original `observed_from` / `observed_to` timestamps; `scanned_at` describes the new inspection, not newly generated usage.

The cache retains 31 days of normalized events, including a one-day margin around the largest reporting window. It is capped at 32 MiB, 2,048 source files and 200,000 events. Oversized entries are left uncached without dropping them from the measured scan. Cache corruption, parser-version changes and incompatible clock rollback cause source rereading. Writes use atomic replacement. Files no longer present in the scan are removed from the cache. Volatile Cursor SQLite databases are always read directly so WAL changes cannot be hidden by a database-file fingerprint.

The first cached scan reads the full retained logs. Later scans reuse unchanged text logs and read only changed files. `last-run.json` records collection duration, cache hits/misses and a sanitized durable-publication receipt. A five-minute trigger is not a guarantee of five-minute freshness: `IgnoreNew` skips a trigger while collection is still running. The task uses Normal priority and a 45-minute execution limit to accommodate an initial full pass; inspect actual run duration and the public snapshot's `source_scanned_at`.

## Provider usage adapters

`lib/meter/providers.js` exports `extractUsage(provider, response)` and `createUsageCollector(provider)` for callers instrumenting their own authorized API requests. The collector preserves the provider-reported total, cumulative SSE counters and available cost fields. It supports OpenAI, Anthropic, Gemini, xAI and Perplexity response shapes.

```js
import { createUsageCollector } from './lib/meter/providers.js';

const collector = createUsageCollector('anthropic');
// Feed decoded SSE text chunks from your existing authorized API response:
// collector.text(chunk);
const observed = collector.finish();
```

`null` means no observed usage. These helpers neither call paid inference APIs nor intercept traffic automatically. Caller-owned routing or instrumentation is required to observe cloud API responses. Browser sessions and subscriptions outside accessible logs remain outside coverage.

### Accounting rules

- Cached input is already part of normalized input; it is never added to total tokens again.
- Anthropic base input excludes cache creation and reads; normalization includes those components once.
- Gemini thought tokens and xAI reasoning fields follow their respective response semantics. The reported provider total remains authoritative.
- Tool-call counts, search counts, token counts and money are distinct measurements.
- Provider response charges and administrative billing are separate evidence sources. Historical local usage can overlap gateway or organization usage.
- Client-reported local price fields remain explicitly labelled evidence. They do not establish paid invoices or subscription cash cost.
- Deleted logs, unsupported records, unavailable files and missing providers are surfaced through coverage. Missing data is never presented as observed zero.

## Privacy and storage

The collector reads local files to extract allowlisted numeric counters, model identifiers, timestamps and source-coverage statistics. It does not upload prompts, completions, tool arguments, credentials, raw session IDs or local file paths. Device identity in a snapshot is a short hash of the hostname; it is pseudonymous, not a claim of anonymity. OS and client/provider names are included.

`--output` creates a local JSON file. Keep generated snapshots, `.env` files, databases and logs outside commits. The repository's ignore rules cover the default output patterns. Source data stays on the device; optional publication contains aggregates only.

## Validate

```sh
npm test
node cli/meter-scan.mjs --help
node cli/meter-daemon.mjs --help
```

Tests use generated temporary fixtures. They exercise deduplication, timestamps, cache accounting, SQLite reads, malformed records, API pagination and publication acknowledgement. No private production dataset or paid API call is needed to run them.

## Source contracts

- [OpenAI organization usage API](https://platform.openai.com/docs/api-reference/usage)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Gemini usage metadata](https://ai.google.dev/api/generate-content#UsageMetadata)
- [xAI cost tracking](https://docs.x.ai/developers/cost-tracking)
- [Perplexity API](https://docs.perplexity.ai/)

MIT licensed. Contributions should include a synthetic fixture and a test for each newly supported telemetry shape.
