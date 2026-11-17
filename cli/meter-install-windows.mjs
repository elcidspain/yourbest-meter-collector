#!/usr/bin/env node
// Uses Task Scheduler's supported XML import; does not change PowerShell policy.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const taskName='YourBestMeter-LocalCollection';
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const ps=value=>"'"+value.replaceAll("'","''")+"'";
export function taskXml({account,node,runner,config,powershell,enabled=false,start=new Date(Date.now()+60000).toISOString()}){
 const args='-NoProfile -NonInteractive -WindowStyle Hidden -Command "& '+ps(node)+' '+ps(runner)+' --config '+ps(config)+'; exit $LASTEXITCODE"';
 return `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>YourBest METER / AUMARA: sanitized local usage every five minutes.</Description></RegistrationInfo><Triggers><TimeTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${xml(start)}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers><Principals><Principal id="Collector"><UserId>${xml(account)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>${enabled?'true':'false'}</Enabled><ExecutionTimeLimit>PT15M</ExecutionTimeLimit></Settings><Actions Context="Collector"><Exec><Command>${xml(powershell)}</Command><Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(path.dirname(config))}</WorkingDirectory></Exec></Actions></Task>`;
}

export function installWindowsTask(args=process.argv.slice(2)){
 if(process.platform!=='win32')throw Error('windows_required');
 const value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 const directory=path.resolve(value('--directory')||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'YourBestMeter'));
 const endpoint=value('--publish'),enabled=args.includes('--enable');
 if(endpoint&&new URL(endpoint).protocol!=='https:')throw Error('https_endpoint_required');
 if(args.includes('--start-now')&&!enabled)throw Error('enable_required_for_immediate_start');
 fs.mkdirSync(directory,{recursive:true});
 const marker=path.join(directory,'managed-task.json'),query=spawnSync('schtasks.exe',['/Query','/TN',taskName,'/XML'],{encoding:'utf8',windowsHide:true,timeout:15000});
 if(query.status===0&&(!fs.existsSync(marker)||JSON.parse(fs.readFileSync(marker,'utf8')).managed_by!=='yourbest-meter-collector'))throw Error('existing_task_not_managed_by_collector');
 const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 if(source.toLowerCase()!==directory.toLowerCase())for(const folder of ['cli','lib'])fs.cpSync(path.join(source,folder),path.join(directory,folder),{recursive:true});
 const configFile=path.join(directory,'config.json');let config={version:1,output:'snapshot.json',signing_key_file:'publish-key.dpapi',publish_endpoint:''};
 if(fs.existsSync(configFile))config={...config,...JSON.parse(fs.readFileSync(configFile,'utf8'))};
 if(endpoint!==undefined)config.publish_endpoint=endpoint;
 fs.writeFileSync(configFile,JSON.stringify(config,null,2)+'\n');
 const who=spawnSync('whoami.exe',[],{encoding:'utf8',windowsHide:true,timeout:5000});if(who.status!==0)throw Error('current_account_unavailable');
 const definition=taskXml({account:who.stdout.trim(),node:process.execPath,runner:path.join(directory,'cli','meter-task.mjs'),config:configFile,powershell:path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),enabled});
 const definitionFile=path.join(directory,'task-definition.xml');fs.writeFileSync(definitionFile,'\ufeff'+definition,'utf16le');
 const result=spawnSync('schtasks.exe',['/Create','/TN',taskName,'/XML',definitionFile,'/F'],{encoding:'utf8',windowsHide:true,timeout:15000});
 if(result.status!==0)throw Error('task_registration_failed: '+String(result.stderr||result.stdout).trim().slice(0,500));
 fs.writeFileSync(marker,JSON.stringify({version:1,task_name:taskName,managed_by:'yourbest-meter-collector'})+'\n');
 if(args.includes('--start-now')){const run=spawnSync('schtasks.exe',['/Run','/TN',taskName],{encoding:'utf8',windowsHide:true,timeout:10000});if(run.status!==0)throw Error('task_start_failed');}
 return {registered:true,task_name:taskName,enabled,interval_minutes:5,publishing_configured:Boolean(config.publish_endpoint),credential_present:fs.existsSync(path.join(directory,config.signing_key_file||config.token_file)),directory};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.argv.includes('--help'))console.log('node cli/meter-install-windows.mjs [--directory PATH] [--publish HTTPS_ENDPOINT] [--enable] [--start-now]\nInstalls a current-user five-minute task. Disabled by default. Private signing key stays in publish-key.dpapi.');
 else try{console.log(JSON.stringify(installWindowsTask()));}catch(error){console.error(JSON.stringify({registered:false,error:error.message}));process.exitCode=1;}
}
