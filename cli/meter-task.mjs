#!/usr/bin/env node
// One scheduled collection. Credentials remain protected with Windows DPAPI.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSnapshot, publishSnapshot } from './meter-scan.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};

export function acquireLock(file,{now=Date.now(),isAlive=alive}={}){
 const owner=randomUUID(),value={owner,pid:process.pid,started_at:new Date(now).toISOString()};
 for(let attempt=0;attempt<2;attempt++){
  try{fs.writeFileSync(file,JSON.stringify(value),{flag:'wx',mode:0o600});return ()=>{try{if(JSON.parse(fs.readFileSync(file,'utf8')).owner===owner)fs.unlinkSync(file);}catch{}};}
  catch(error){if(error.code!=='EEXIST')throw error;let existing;try{existing=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}
   const stamp=Date.parse(existing.started_at),fromPreviousBoot=Number.isFinite(stamp)&&stamp<now-os.uptime()*1000-60000;
   if(!Number.isInteger(existing.pid)||existing.pid<1||(!fromPreviousBoot&&isAlive(existing.pid)))return null;
   // Compare ownership before deleting a stale lock. A live process is retained.
   try{if(JSON.parse(fs.readFileSync(file,'utf8')).owner===existing.owner)fs.unlinkSync(file);}catch{}
  }
 }
 return null;
}

export function readWindowsCredential(tokenFile){
 if(process.platform!=='win32')throw Error('dpapi_requires_windows');
 const script="$ErrorActionPreference='Stop'; $s=(Get-Content -LiteralPath $env:YOURBEST_METER_TOKEN_FILE -Raw).Trim() | ConvertTo-SecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }";
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,YOURBEST_METER_TOKEN_FILE:tokenFile},encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:16384});
 if(result.status!==0||!result.stdout||result.stdout.length>8192)throw Error('publication_credential_unavailable');
 return result.stdout;
}

function writeJson(file,value){const temporary=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,file);}

export async function runTask(configFile,{scan=createSnapshot,publish=publishSnapshot,readCredential=readWindowsCredential,sleep=wait}={}){
 const folder=path.dirname(path.resolve(configFile)),config=JSON.parse(fs.readFileSync(configFile,'utf8'));
 if(config.version!==1||!config.output||!/^[A-Za-z0-9._-]+\.json$/.test(config.output))throw Error('invalid_task_configuration');
 if(config.cache_file&&(!/^[A-Za-z0-9._-]+\.json$/.test(config.cache_file)||['config.json','last-run.json',config.output.toLowerCase()].includes(config.cache_file.toLowerCase())))throw Error('invalid_cache_file');
 const signing=Boolean(config.signing_key_file),tokenName=config.signing_key_file||config.token_file||'publish-token.dpapi';
 if(!/^[A-Za-z0-9._-]+\.dpapi$/.test(tokenName))throw Error('invalid_token_file');
 const release=acquireLock(path.join(folder,'collector.lock'));
 if(!release)return {ok:true,skipped:'already_running'};
 const status={started_at:new Date().toISOString(),publishing_requested:Boolean(config.publish_endpoint),published:false};
 try{
  const collectionStarted=Date.now();
  const snapshot=await scan(config.cache_file?{cacheFile:path.join(folder,config.cache_file),onCache:value=>{status.cache=value;}}:{});
  status.collection_duration_ms=Date.now()-collectionStarted;writeJson(path.join(folder,config.output),snapshot);
  status.source_scanned_at=snapshot.scanned_at;status.items=snapshot.items.length;
  if(config.publish_endpoint){
   const credential=readCredential(path.join(folder,tokenName));let last;
   for(let attempt=0;attempt<3;attempt++){
    try{const receipt=await publish(snapshot,{endpoint:config.publish_endpoint,...(signing?{signingKey:credential}:{token:credential})});
     if(receipt?.persisted!==true)throw Error('publication_not_persisted');
     status.publication={persisted:true,...(Number.isInteger(receipt.status)?{http_status:receipt.status}:{}),...(receipt.storage==='supabase'?{storage:receipt.storage}:{}),...(/^[a-f0-9]{64}$/.test(receipt.sha256)?{sha256:receipt.sha256}:{}),source_scanned_at:snapshot.scanned_at};
     status.published=true;status.publication_attempts=attempt+1;status.publication_auth=signing?'ed25519':'bearer';last=null;break;}
    catch(error){last=error;if(attempt<2)await sleep(1000*2**attempt);}
   }
   if(last)throw Error('publication_failed_after_retries');
  }
  Object.assign(status,{ok:true,completed_at:new Date().toISOString()});writeJson(path.join(folder,'last-run.json'),status);return status;
 }catch(error){Object.assign(status,{ok:false,completed_at:new Date().toISOString(),error:['publication_credential_unavailable','publication_failed_after_retries','dpapi_requires_windows'].includes(error.message)?error.message:'collection_failed'});writeJson(path.join(folder,'last-run.json'),status);throw Error(status.error);}
 finally{release();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const index=process.argv.indexOf('--config');
 if(process.argv.includes('--help'))console.log('node cli/meter-task.mjs --config /absolute/path/config.json\nOne collection with a process lock, atomic snapshot writes and up to three publication attempts. On Windows, publication uses a current-user DPAPI token file.');
 else if(index<0||!process.argv[index+1]){console.error('A --config file is required.');process.exitCode=1;}
 else runTask(process.argv[index+1]).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;});
}
