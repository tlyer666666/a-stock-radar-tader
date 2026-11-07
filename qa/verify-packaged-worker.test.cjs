'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolveResources,resolveElectronBinary}=require('./verify-packaged-worker.cjs');
test('worker verifier resolves installed runtime using path.txt across platforms',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'worker-path-test-'));
 try{for(const relative of ['electron.exe','electron','Electron.app/Contents/MacOS/Electron']){
  const binary=path.join(root,'dist',relative);fs.mkdirSync(path.dirname(binary),{recursive:true});fs.writeFileSync(binary,'fixture');fs.writeFileSync(path.join(root,'path.txt'),relative);
  assert.equal(resolveElectronBinary(root,''),binary);
 }}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('worker verifier accepts app bundle and Windows resource layouts',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'worker-resource-test-'));
 try{for(const relative of ['Contents/Resources','resources']){const folder=path.join(root,relative);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'app.asar'),'fixture');assert.equal(resolveResources(folder),folder);}}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});
