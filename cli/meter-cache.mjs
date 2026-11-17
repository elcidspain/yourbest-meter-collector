import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

// Increment when any local parser's identity or accounting rules change.
export const CACHE_PARSER_VERSION = 'meter-local-parsers-2026-11-17.1';
const FORMAT = 'meter.normalized-event-cache.v1';
const DAY = 86400000;
const LIMIT_BYTES = 32 * 1024 * 1024;
const LIMIT_FILES = 2048;
const LIMIT_EVENTS = 200000;
const hash = value => createHash('sha256').update(value).digest('hex');
const count = value => Number.isSafeInteger(value) && value >= 0;
const sources = new Set(['codex','grok_build','claude_code','desktop_commander','claude_mcp']);

function fingerprint(file) {
 const stat = fs.statSync(file,{bigint:true});
 if (!stat.isFile()) throw Error('not_regular_file');
 return {value:hash(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`),bytes:Number(stat.size)};
}

// Only these fields may reach disk. Source text, paths and raw identifiers are
// never serialized, even if a future parser accidentally returns extra fields.
function safeEvent(event, source) {
 if (!event || event.source !== source || !sources.has(source) || !/^[a-f0-9]{64}$/.test(event.key) ||
     !Number.isFinite(event.timestamp) || typeof event.model !== 'string' || !/^[\w./:-]{1,100}$/.test(event.model) ||
     typeof event.method !== 'string' || !/^[a-z0-9_]{1,100}$/.test(event.method)) return null;
 const output={key:event.key,timestamp:event.timestamp,source,model:event.model,unit:event.unit,method:event.method};
 if (event.unit === 'tokens') {
  if (![event.input_tokens,event.output_tokens].every(count) || !count(event.input_tokens+event.output_tokens) ||
      (event.cached_tokens != null && (!count(event.cached_tokens) || event.cached_tokens > event.input_tokens))) return null;
  Object.assign(output,{input_tokens:event.input_tokens,output_tokens:event.output_tokens,cached_tokens:event.cached_tokens??null});
  for (const key of ['model_calls','client_cost_usd_ticks']) if (count(event[key])) output[key]=event[key];
 } else if (event.unit === 'tool_calls' && count(event.amount)) output.amount=event.amount;
 else return null;
 return output;
}

export function createEventCache(file,{now=Date.now(),parserVersion=CACHE_PARSER_VERSION,maxBytes=LIMIT_BYTES,maxFiles=LIMIT_FILES}={}) {
 maxBytes=Math.min(LIMIT_BYTES,Math.max(1024,Number.isSafeInteger(maxBytes)?maxBytes:LIMIT_BYTES));
 maxFiles=Math.min(LIMIT_FILES,Math.max(1,Number.isSafeInteger(maxFiles)?maxFiles:LIMIT_FILES));
 const retainedFrom=now-31*DAY, entries=new Map(), visited=new Set();
 const stats={enabled:true,hits:0,misses:0,bytes_reused:0,files_changed_during_read:0,entries_saved:0,bytes_saved:0,evicted:0,load:'missing',write:'pending'};
 let storedBytes=0,storedEvents=0;
 const entrySize=(key,value)=>Buffer.byteLength(JSON.stringify({[key]:value}));
 function normalize(result,source) {
  if (!result || !Array.isArray(result.events) || !count(result.invalid??0)) throw Error('invalid_parser_result');
  const events=[];
  for (const event of result.events) {
   const safe=safeEvent(event,source);
   if (!safe) throw Error('invalid_normalized_event');
   if (safe.timestamp>=retainedFrom) events.push(safe);
  }
  return {events,invalid:result.invalid??0,has_events:result.has_events??result.events.length>0};
 }
 function remove(key) {
  const old=entries.get(key);if(!old)return;
  storedBytes-=entrySize(key,old);storedEvents-=old.result.events.length;entries.delete(key);
 }
 function insert(key,value) {
  remove(key);const bytes=entrySize(key,value),events=value.result.events.length;
  if (entries.size>=maxFiles || storedBytes+bytes>maxBytes-512 || storedEvents+events>LIMIT_EVENTS) {stats.evicted++;return;}
  entries.set(key,value);storedBytes+=bytes;storedEvents+=events;
 }
 try {
  const size=fs.statSync(file).size;
  if(size>maxBytes)stats.load='oversized';
  else {
   const saved=JSON.parse(fs.readFileSync(file,'utf8'));
   if(saved.format!==FORMAT || saved.parser_version!==parserVersion || !Number.isFinite(saved.retained_from) || saved.retained_from>now-30*DAY ||
       !saved.entries || typeof saved.entries!=='object' || Array.isArray(saved.entries) || Object.keys(saved.entries).length>maxFiles) stats.load='invalidated';
   else {
    for(const [key,value] of Object.entries(saved.entries)) {
     if(!/^[a-f0-9]{64}$/.test(key)||!value||!/^[a-f0-9]{64}$/.test(value.fingerprint)||!sources.has(value.source)||typeof value.result?.has_events!=='boolean')throw Error('invalid_cache');
     const result=normalize(value.result,value.source);
     insert(key,{fingerprint:value.fingerprint,source:value.source,result});
    }
    stats.load='loaded';
   }
  }
 } catch(error) {if(error.code!=='ENOENT'){entries.clear();storedBytes=0;storedEvents=0;stats.load='corrupt';}}

 return {
  stats,
  async read(file,source,parser,parse) {
   const key=hash(`${parserVersion}:${source}:${parser}:${path.resolve(file)}`),before=fingerprint(file);
   visited.add(key);
   const saved=entries.get(key);
   if(saved?.fingerprint===before.value) {stats.hits++;stats.bytes_reused+=before.bytes;return structuredClone(saved.result);}
   stats.misses++;remove(key);
   const result=normalize(await parse(),source);
   // A growing/replaced file is measured for this scan but never cached under
   // a fingerprint that did not describe the bytes actually parsed.
   let after;try{after=fingerprint(file);}catch{}
   if(after?.value===before.value)insert(key,{fingerprint:before.value,source,result});
   else stats.files_changed_during_read++;
   return structuredClone(result);
  },
  save() {
   for(const key of entries.keys())if(!visited.has(key))remove(key);
   const value={format:FORMAT,parser_version:parserVersion,retained_from:retainedFrom,saved_at:now,entries:Object.fromEntries(entries)};
   const text=JSON.stringify(value),bytes=Buffer.byteLength(text);
   if(bytes>maxBytes){stats.write='bounded_skip';return {...stats};}
   const temporary=file+'.'+randomUUID()+'.tmp';
   try{fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});fs.writeFileSync(temporary,text,{mode:0o600});fs.renameSync(temporary,file);stats.write='saved';stats.entries_saved=entries.size;stats.bytes_saved=bytes;}
   catch{stats.write='failed';try{fs.unlinkSync(temporary);}catch{}}
   return {...stats};
  }
 };
}
