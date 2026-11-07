'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright-core');
async function launchPackaged(executablePath,{hidden=true}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'a-stock-e2e-'));
 const child=spawn(executablePath,[`--user-data-dir=${directory}`,'--remote-debugging-port=0',...(hidden?['--disable-gpu','--disable-gpu-compositing']:[])],{
  env:{...process.env,A_STOCK_E2E_HIDDEN:hidden?'1':'0',A_STOCK_E2E_USER_DATA:directory,ELECTRON_RUN_AS_NODE:undefined},stdio:['ignore','ignore','pipe']});
 let browser,closed=false;
 async function close(){
  if(closed)return;closed=true;
  try{await browser?.close();}finally{
   if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await exited;clearTimeout(timer);}
   fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
 }
 try{
  const endpoint=await new Promise((resolve,reject)=>{
   let log='';const timer=setTimeout(()=>finish(Error('Packaged page debugger did not start')),20000);
   const finish=(error,url)=>{clearTimeout(timer);child.stderr.off('data',read);child.off('error',fail);child.off('exit',exit);if(error)reject(error);else resolve(url);};
   const read=data=>{log=(log+data.toString()).slice(-8000);const match=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match)finish(null,match[1]);};
   const fail=error=>finish(error),exit=code=>finish(Error(`Packaged application exited: ${code}`));
   child.stderr.on('data',read);child.once('error',fail);child.once('exit',exit);
  });
  browser=await chromium.connectOverCDP(endpoint);
  const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page',{timeout:20000});
  return {browser,context,page,close};
 }catch(error){await close();throw error;}
}
function appExecutable(appPath){
 if(!appPath.endsWith('.app'))return path.resolve(appPath);
 const directory=path.join(path.resolve(appPath),'Contents','MacOS');
 const names=fs.readdirSync(directory).filter(name=>fs.statSync(path.join(directory,name)).isFile());
 if(names.length!==1)throw Error('Application executable is ambiguous');
 return path.join(directory,names[0]);
}
module.exports={launchPackaged,appExecutable};
