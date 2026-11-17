import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {acquireLock,runTask} from '../cli/meter-task.mjs';
import {taskXml} from '../cli/meter-install-windows.mjs';

function fixture(t,extra={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'meter-task-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const config=path.join(dir,'config.json');fs.writeFileSync(config,JSON.stringify({version:1,output:'snapshot.json',...extra}));return {dir,config};}
const snapshot=()=>({scanned_at:new Date().toISOString(),items:[],sources:[]});

test('a live lock prevents overlapping tasks, and a dead-owner lock is recovered',t=>{
 const {dir}=fixture(t),lock=path.join(dir,'collector.lock'),release=acquireLock(lock);assert.equal(typeof release,'function');assert.equal(acquireLock(lock),null);release();
 fs.writeFileSync(lock,JSON.stringify({pid:99999,owner:'dead',started_at:new Date().toISOString()}));const recovered=acquireLock(lock,{isAlive:()=>false});assert.equal(typeof recovered,'function');recovered();assert.equal(fs.existsSync(lock),false);
});
test('local-only task never decrypts or publishes and writes its completed status',async t=>{
 const {dir,config}=fixture(t);const result=await runTask(config,{scan:async()=>snapshot(),readCredential:()=>{throw Error('unexpected');},publish:()=>{throw Error('unexpected');}});
 assert.equal(result.ok,true);assert.equal(result.published,false);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'last-run.json'))).ok,true);assert.equal(fs.existsSync(path.join(dir,'collector.lock')),false);
});
test('publication retries the same snapshot, stores no token, and confirms persisted success',async t=>{
 const {dir,config}=fixture(t,{publish_endpoint:'https://example.invalid/api/meter?op=publish_snapshot'});let calls=0,first;const secret='PRIVATE-CREDENTIAL-TEST';
 const result=await runTask(config,{scan:async()=>snapshot(),readCredential:()=>secret,sleep:async()=>{},publish:async(s,options)=>{assert.equal(options.token,secret);if(!first)first=s;else assert.equal(s,first);if(++calls<3)throw Error('transient');return{persisted:true};}});
 assert.equal(calls,3);assert.equal(result.published,true);assert.equal(result.publication_attempts,3);assert.ok(!fs.readFileSync(path.join(dir,'last-run.json'),'utf8').includes(secret));
});
test('failed publication preserves local data, releases lock, and records failure',async t=>{
 const {dir,config}=fixture(t,{publish_endpoint:'https://example.invalid/api/meter?op=publish_snapshot'});let calls=0;
 await assert.rejects(()=>runTask(config,{scan:async()=>snapshot(),readCredential:()=> 'PRIVATE',sleep:async()=>{},publish:async()=>{calls++;throw Error('offline');}}),/publication_failed_after_retries/);
 assert.equal(calls,3);assert.equal(fs.existsSync(path.join(dir,'snapshot.json')),true);assert.equal(fs.existsSync(path.join(dir,'collector.lock')),false);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'last-run.json'))).ok,false);
});

test('signed tasks decrypt only their configured key file and keep private key out of status',async t=>{
 const {dir,config}=fixture(t,{publish_endpoint:'https://example.invalid/api/meter?op=publish_snapshot',signing_key_file:'publish-key.dpapi'});
 const privateKey='SYNTHETIC-PRIVATE-KEY';let observed;
 const result=await runTask(config,{scan:async()=>snapshot(),readCredential:file=>{assert.equal(file,path.join(dir,'publish-key.dpapi'));return privateKey;},publish:async(s,options)=>{observed=options;return{persisted:true};}});
 assert.equal(observed.signingKey,privateKey);assert.equal(observed.token,undefined);assert.equal(result.publication_auth,'ed25519');assert.ok(!fs.readFileSync(path.join(dir,'last-run.json'),'utf8').includes(privateKey));
});

test('Windows task definition stays disabled by default and escapes account/path values',()=>{
 const xml=taskXml({account:'TEST\\Synthetic',node:"C:\\Program Files\\node.exe",runner:"C:\\Synthetic's & data\\meter-task.mjs",config:'C:\\Synthetic\\config.json',powershell:'C:\\Windows\\powershell.exe',start:'2026-11-17T16:00:00Z'});
 assert.ok(xml.includes('<Interval>PT5M</Interval>'));assert.ok(xml.includes('<Enabled>false</Enabled>'));assert.ok(xml.includes('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'));assert.ok(xml.includes('<RunLevel>LeastPrivilege</RunLevel>'));assert.ok(xml.includes('Synthetic&apos;&apos;s &amp; data'));assert.ok(!xml.includes('ExecutionPolicy'));assert.ok(!xml.includes('PRIVATE KEY'));
 assert.ok(xml.includes('<ExecutionTimeLimit>PT45M</ExecutionTimeLimit>'));assert.ok(xml.includes('<Priority>5</Priority>'));
});

test('task opts into its local cache and records a sanitized durable-publication receipt',async t=>{
 const {dir,config}=fixture(t,{cache_file:'event-cache.json',publish_endpoint:'https://example.invalid/api/meter?op=publish_snapshot'});
 const result=await runTask(config,{scan:async options=>{assert.equal(options.cacheFile,path.join(dir,'event-cache.json'));options.onCache({hits:9,misses:1});return snapshot();},readCredential:()=> 'PRIVATE',publish:async()=>({persisted:true,status:200,storage:'supabase',sha256:'a'.repeat(64),private_key:'NEVER-SAVE'})});
 assert.equal(result.cache.hits,9);assert.equal(result.publication.persisted,true);assert.equal(result.publication.http_status,200);assert.equal(result.publication.sha256,'a'.repeat(64));assert.ok(result.collection_duration_ms>=0);assert.ok(!JSON.stringify(result).includes('NEVER-SAVE'));
});

test('cache filename cannot overwrite snapshot, configuration or parent paths',async t=>{
 for(const cache_file of ['snapshot.json','config.json','CONFIG.JSON','last-run.json','../outside.json']){const {config}=fixture(t,{cache_file});await assert.rejects(()=>runTask(config),/invalid_cache_file/);}
});
