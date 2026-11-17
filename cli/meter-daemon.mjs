#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('YourBest METER / AUMARA collector\nnode cli/meter-daemon.mjs [--interval-seconds 300] [--once] [--output ./snapshot.json] [--push https://yourbest.space/api/meter?op=publish_snapshot]\nRuns scans sequentially. Publishing is opt-in and requires METER_LOCAL_SIGNING_KEY (Ed25519) or a compatible bearer credential.');
} else {
  const forwarded = [];
  let interval = 300;
  const once = args.includes('--once');
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--once') continue;
    if (args[index] === '--interval-seconds') { interval = Number(args[++index]); continue; }
    forwarded.push(args[index]);
  }
  if (!Number.isInteger(interval) || interval < 60 || interval > 86400) {
    console.error('interval-seconds must be an integer between 60 and 86400.'); process.exitCode = 1;
  } else {
    if (!forwarded.includes('--output')) forwarded.unshift('--output', path.resolve('.yourbest-meter/snapshot.json'));
    let stopping = false, child = null, timer = null, wake = null;
    const stop = () => { stopping = true; if (timer) clearTimeout(timer); if (wake) wake(); if (child) child.kill('SIGTERM'); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const cli = fileURLToPath(new URL('./meter-scan.mjs', import.meta.url));
    do {
      const started = Date.now();
      const code = await new Promise(resolve => {
        let settled = false;
        const done = value => { if (!settled) { settled = true; child = null; resolve(value); } };
        child = spawn(process.execPath, [cli, ...forwarded], { stdio: 'inherit', windowsHide: true });
        child.once('error', () => done(1)); child.once('exit', code => done(code ?? 1));
      });
      console.error(JSON.stringify({ meter_daemon: { completed_at: new Date().toISOString(), scan_exit_code: code, next_scan_seconds: once || stopping ? null : Math.max(1, Math.ceil((interval * 1000 - (Date.now() - started)) / 1000)) } }));
      if (once) { process.exitCode = code; break; }
      if (!stopping) await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, Math.max(1000, interval * 1000 - (Date.now() - started))); });
      timer = null; wake = null;
    } while (!stopping);
  }
}
