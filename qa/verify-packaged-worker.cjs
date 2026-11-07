#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function resolveResources(target) {
  for (const candidate of [path.join(target,'Contents','Resources'),path.join(target,'resources'),target]) {
    if (fs.existsSync(path.join(candidate,'app.asar'))) return candidate;
  }
  throw Error(`No app.asar found under ${target}`);
}
function resolveElectronBinary(installation = path.dirname(require.resolve('electron/package.json')), explicit = process.env.PACKAGED_ELECTRON_PATH) {
  if (explicit) return path.resolve(explicit);
  const relative = fs.readFileSync(path.join(installation,'path.txt'),'utf8').trim();
  const dist = path.join(installation,'dist'), binary = path.resolve(dist,relative);
  if (!binary.startsWith(`${dist}${path.sep}`) || !fs.existsSync(binary)) throw Error('Installed Electron binary is unavailable');
  return binary;
}
function run(input = process.argv[2]) {
  if (!input) throw Error('Usage: node qa/verify-packaged-worker.cjs <app-or-resources>');
  const resources = resolveResources(path.resolve(input));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'a-stock-worker-probe-'));
  const probe = path.join(temporary,'probe.cjs');
  try {
    fs.writeFileSync(probe, `
const {app}=require('electron');
const path=require('node:path');
const {Worker}=require('node:worker_threads');
const RES=${JSON.stringify(resources)};
app.setPath('userData',${JSON.stringify(path.join(temporary,'profile'))});
app.whenReady().then(()=>{
 try{
  const {workerScriptPath}=require(path.join(RES,'app.asar','electron','worker-runner.cjs'));
  const {STRATEGY_DEFINITIONS}=require(path.join(RES,'app.asar','electron','strategy-signal-engine.cjs'));
  const resolved=workerScriptPath(path.join(RES,'app.asar','electron'),'portfolio-backtest-worker.cjs');
  const worker=new Worker(resolved,{workerData:{task:'single-stock-replay',strategyIds:[STRATEGY_DEFINITIONS[0].id],security:{code:'600000',name:'ISOLATED_WORKER_PROBE'},history:[],benchmarkHistory:[],replayOptions:{}}});
  worker.once('message',message=>{console.log(JSON.stringify({resolved,ok:message.ok,error:message.error}));app.exit(message.ok===true?0:1);});
  worker.once('error',error=>{console.error(error);app.exit(1);});
  setTimeout(()=>app.exit(1),20000);
 }catch(error){console.error(error);app.exit(1);}
});
`);
    const result=spawnSync(resolveElectronBinary(),[probe],{encoding:'utf8',timeout:25000,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
    if(result.error) throw result.error;
    if(result.status!==0) throw Error(`Packaged worker probe failed: ${result.stderr} ${result.stdout}`);
    console.log(result.stdout.trim());return {passed:true};
  } finally {fs.rmSync(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
if(require.main===module){try{run();}catch(error){console.error(error);process.exitCode=1;}}
module.exports={resolveResources,resolveElectronBinary,run};
