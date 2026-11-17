import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {createEventCache} from '../cli/meter-cache.mjs';
import {createSnapshot} from '../cli/meter-scan.mjs';

const DAY=86400000,now=Date.parse('2026-11-17T12:00:00Z');
const digest=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'meter-cache-test-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return{home,cacheFile:path.join(home,'event-cache.json')};}
const event=(key='test',timestamp=now-1000)=>({key:digest(key),timestamp,source:'codex',model:'synthetic-model',unit:'tokens',input_tokens:90,output_tokens:10,cached_tokens:20,method:'per_response_token_telemetry'});
function record(id,timestamp,input=90){return JSON.stringify({timestamp:new Date(timestamp).toISOString(),type:'token_usage_record',payload:{response_id:id,model:'synthetic-model',usage:{input_tokens:input,output_tokens:10,cached_input_tokens:20},prompt:'DO-NOT-SAVE-THIS-PROMPT'}})+'\n';}
async function snapshot(options){return createSnapshot({platform:'linux',env:{},now,...options});}

test('unchanged cache reuses normalized events, deduplicates files and recomputes rolling windows',async t=>{
 const {home,cacheFile}=fixture(t),dir=path.join(home,'.codex','sessions');fs.mkdirSync(dir,{recursive:true});
 const content=record('PRIVATE-RESPONSE-ID',now-7*DAY+1000);
 fs.writeFileSync(path.join(dir,'one.jsonl'),content);fs.writeFileSync(path.join(dir,'copy.jsonl'),content);
 let cold,warm;
 const first=await snapshot({home,cacheFile,onCache:v=>cold=v});
 assert.deepEqual(first.items,(await snapshot({home})).items);assert.equal(cold.misses,2);assert.equal(cold.hits,0);
 const second=await snapshot({home,cacheFile,now:now+2000,onCache:v=>warm=v});
 assert.deepEqual(second.items,(await snapshot({home,now:now+2000})).items);assert.equal(warm.hits,2);assert.equal(warm.misses,0);
 assert.equal(second.items.filter(x=>x.window_days===7).length,0);assert.equal(second.items.find(x=>x.window_days===14).input_tokens,90);
 assert.equal(second.scanned_at,new Date(now+2000).toISOString());
 assert.equal(second.items.find(x=>x.window_days===14).evidence.observed_to,new Date(now-7*DAY+1000).toISOString());
 const saved=fs.readFileSync(cacheFile,'utf8');for(const privateValue of ['DO-NOT-SAVE-THIS-PROMPT','PRIVATE-RESPONSE-ID',home,'one.jsonl'])assert.ok(!saved.includes(privateValue));
});

test('appended and truncated logs are reparsed while unchanged copies remain deduplicated',async t=>{
 const {home,cacheFile}=fixture(t),dir=path.join(home,'.codex','sessions');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'one.jsonl'),copy=path.join(dir,'copy.jsonl');fs.writeFileSync(file,record('shared',now-1000));fs.copyFileSync(file,copy);
 await snapshot({home,cacheFile});
 fs.appendFileSync(file,record('new',now-500,40));let metrics;
 const appended=await snapshot({home,cacheFile,onCache:v=>metrics=v});assert.deepEqual(appended.items,(await snapshot({home})).items);assert.equal(metrics.hits,1);assert.equal(metrics.misses,1);assert.equal(appended.items[0].input_tokens,130);
 fs.writeFileSync(file,record('replacement',now-500,25));
 const replaced=await snapshot({home,cacheFile});assert.deepEqual(replaced.items,(await snapshot({home})).items);assert.equal(replaced.items[0].input_tokens,115);
});

test('corrupt, old-parser and clock-incompatible caches fall back to actual parsing',async t=>{
 const {home,cacheFile}=fixture(t),file=path.join(home,'source.log');fs.writeFileSync(file,'source');let parses=0;
 const parse=async()=>{parses++;return{events:[event()],invalid:0};};
 fs.writeFileSync(cacheFile,'{broken');let cache=createEventCache(cacheFile,{now});await cache.read(file,'codex','fixture',parse);cache.save();assert.equal(cache.stats.load,'corrupt');
 cache=createEventCache(cacheFile,{now,parserVersion:'changed-parser'});await cache.read(file,'codex','fixture',parse);cache.save();assert.equal(cache.stats.load,'invalidated');
 cache=createEventCache(cacheFile,{now:now-2*DAY,parserVersion:'changed-parser'});await cache.read(file,'codex','fixture',parse);assert.equal(cache.stats.load,'invalidated');assert.equal(parses,3);
});

test('file replacement and changes during parsing cannot create stale cache hits',async t=>{
 const {home,cacheFile}=fixture(t),file=path.join(home,'source.log');fs.writeFileSync(file,'original');let parses=0;
 const parse=async()=>{parses++;return{events:[event()],invalid:0};};
 let cache=createEventCache(cacheFile,{now});await cache.read(file,'codex','fixture',parse);cache.save();
 const old=fs.statSync(file);fs.unlinkSync(file);fs.writeFileSync(file,'replaced');fs.utimesSync(file,old.atime,old.mtime);
 cache=createEventCache(cacheFile,{now});await cache.read(file,'codex','fixture',parse);assert.equal(parses,2);
 cache=createEventCache(cacheFile,{now});await cache.read(file,'codex','fixture',async()=>{fs.appendFileSync(file,' grows');return{events:[event()],invalid:0};});
 const report=cache.save();assert.equal(report.files_changed_during_read,1);assert.equal(report.entries_saved,0);
});

test('cache limits, retention, atomic replacement and allowlisted fields preserve measured output',async t=>{
 const {home,cacheFile}=fixture(t),a=path.join(home,'a.log'),b=path.join(home,'b.log');fs.writeFileSync(a,'a');fs.writeFileSync(b,'b');
 let cache=createEventCache(cacheFile,{now,maxFiles:1,maxBytes:2048});
 const result=await cache.read(a,'codex','fixture',async()=>({events:[{...event(),prompt:'PRIVATE',arguments:{secret:'PRIVATE'},path:home},event('old',now-32*DAY)],invalid:0}));
 assert.equal(result.events.length,1);assert.equal(result.events[0].prompt,undefined);
 await cache.read(b,'codex','fixture',async()=>({events:[event('second')],invalid:0}));let stats=cache.save();assert.equal(stats.entries_saved,1);assert.ok(stats.bytes_saved<=2048);assert.equal(stats.evicted,1);
 assert.ok(!fs.readFileSync(cacheFile,'utf8').includes('PRIVATE'));assert.ok(!fs.readdirSync(home).some(name=>name.endsWith('.tmp')));
 fs.appendFileSync(a,'changed');cache=createEventCache(cacheFile,{now,maxBytes:1024});const large=Array.from({length:30},(_,i)=>event(String(i)));const measured=await cache.read(a,'codex','fixture',async()=>({events:large,invalid:0}));stats=cache.save();assert.equal(measured.events.length,30);assert.equal(stats.entries_saved,0);assert.ok(stats.bytes_saved<=1024);
 cache=createEventCache(cacheFile,{now});stats=cache.save();assert.equal(stats.entries_saved,0);
});

test('standalone collection leaves no cache unless explicitly configured',async t=>{
 const {home,cacheFile}=fixture(t);await snapshot({home});assert.equal(fs.existsSync(cacheFile),false);
});

test('cached Grok usage preserves fallback selection when all valid turns age out',async t=>{
 const {home,cacheFile}=fixture(t),dir=path.join(home,'.grok','sessions','synthetic');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'usage.json'),JSON.stringify({sessionId:'synthetic',turns:[{turnNumber:1,endedAt:new Date(now-32*DAY).toISOString(),inputTokens:90,outputTokens:10,primaryModelId:'synthetic-model'},{turnNumber:2,endedAt:'invalid'}]}));
 fs.writeFileSync(path.join(dir,'updates.jsonl'),JSON.stringify({timestamp:new Date(now-1000).toISOString(),params:{sessionId:'synthetic',update:{sessionUpdate:'turn_completed',prompt_id:'mirror',usage:{inputTokens:10000,outputTokens:10},primaryModelId:'synthetic-model'}}})+'\n');
 const first=await snapshot({home,cacheFile}),second=await snapshot({home,cacheFile});assert.equal(first.items.length,0);assert.equal(second.items.length,0);assert.deepEqual(first.items,(await snapshot({home})).items);
});

test('a stalled partial read retries from clean parser state and never poisons the cache',async t=>{
 const {home,cacheFile}=fixture(t),dir=path.join(home,'.codex','sessions');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'session.jsonl');fs.writeFileSync(file,record('complete-response',now-1000));
 const original=fs.createReadStream;let injected=false;
 fs.createReadStream=(name,options)=>{
  if(name!==file||injected)return original(name,options);
  injected=true;const stream=new PassThrough();queueMicrotask(()=>{stream.write(record('partial-only',now-500,9999));stream.destroy(Error('read_timeout'));});return stream;
 };
 let first;try{first=await snapshot({home,cacheFile});}finally{fs.createReadStream=original;}
 assert.equal(first.items[0].input_tokens,90);assert.equal(first.sources.find(x=>x.source==='codex').files_retried,1);assert.equal(first.sources.find(x=>x.source==='codex').files_failed,0);
 let stats;const repeat=await snapshot({home,cacheFile,onCache:v=>stats=v});assert.equal(stats.hits,1);assert.deepEqual(repeat.items,first.items);
});
