'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return `http://127.0.0.1:${instance.address().port}`;
}
function productionTransportProbe() {
  return `const {getHttpDiagnostics}=require(${JSON.stringify(path.join(__dirname,'http-client.cjs'))}); const {requiresNativeTransport}=require(${JSON.stringify(path.join(__dirname,'native-http.cjs'))}); const mode=getHttpDiagnostics().transportMode; require('node:assert/strict').equal(mode.native,requiresNativeTransport(process.versions.undici)); console.log('production transport',JSON.stringify(mode));`;
}
// These two child processes verify the production transport. Do not inherit
// the unit-suite-only fetch override from qa/test-env.cjs.
test('Electron handles early close after excessive encodings without an uncaught stream error', async t => {
  const electronRoot = path.dirname(require.resolve('electron/package.json'));
  const binary = path.join(electronRoot, 'dist', fs.readFileSync(path.join(electronRoot, 'path.txt'), 'utf8').trim());
  const instance = net.createServer(socket => { socket.on('error', () => {}); socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nContent-Length: 1\r\nConnection: close\r\n\r\n')); });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => instance.close());
  const script = `${productionTransportProbe()} const {fetchArrayBufferWithPolicy}=require(${JSON.stringify(path.join(__dirname,'http-client.cjs'))}); fetchArrayBufferWithPolicy(process.argv[1],{}, {retries:0}).then(()=>{process.exitCode=2},()=>{console.log('rejected safely');setTimeout(()=>{},100)});`;
  const child = spawn(binary, ['-e', script, `http://127.0.0.1:${instance.address().port}`], { env: { ...process.env, ASTOCK_HTTP_TRANSPORT: undefined, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore','pipe','pipe'] });
  const timer = setTimeout(() => child.kill(), 8000); t.after(() => clearTimeout(timer));
  let output = '', error = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => error += b);
  const [code] = await once(child,'close');
  assert.equal(code,0,error); assert.match(output,/rejected safely/);
});
test('native HTTP preserves redirects, decoded bytes and final URL', async t => {
  const url = await server(t,(req,res) => {
    if(req.url==='/redirect') {res.writeHead(302,{location:'/data'});res.end();return;}
    res.writeHead(200,{'content-encoding':'gzip'}); res.end(zlib.gzipSync('行情数据'));
  });
  const response = await require('./native-http.cjs').fetchNative(`${url}/redirect`,{},1024);
  assert.equal(await response.text(),'行情数据'); assert.equal(response.url,`${url}/data`); assert.equal(response.redirected,true);
});
test('native HTTP aborts before headers and releases the physical socket', async t => {
  const sockets = new Set();
  const url = await server(t,(_req,res) => { sockets.add(res.socket); res.socket.once('close',()=>sockets.delete(res.socket)); });
  const controller = new AbortController();
  const promise = require('./native-http.cjs').fetchNative(url,{signal:controller.signal},1024);
  const timer = setTimeout(()=>controller.abort(new Error('cancelled')),25); t.after(()=>clearTimeout(timer));
  await assert.rejects(promise,/cancelled/);
  await new Promise(resolve=>setTimeout(resolve,25)); assert.equal(sockets.size,0);
});
test('native HTTP caps both compressed transfer and decoded output', async t => {
  const url = await server(t,(_req,res) => {res.writeHead(200,{'content-encoding':'gzip'});res.end(zlib.gzipSync(Buffer.alloc(4096,1)));});
  await assert.rejects(require('./native-http.cjs').fetchNative(url,{},128),error=>error.code==='RESPONSE_TOO_LARGE');
});
test('native HTTP rejects a truncated body instead of hanging', async t => {
  const url = await server(t,(_req,res) => {res.writeHead(200,{'content-length':'100'});res.flushHeaders();res.end('short');});
  await assert.rejects(require('./native-http.cjs').fetchNative(url,{},1024));
});
test('malformed redirect becomes a handled rejection, not an uncaught exception',async t=>{
 const url=await server(t,(_req,res)=>{res.writeHead(302,{location:'http://['});res.end();});
 const script=`require(${JSON.stringify(path.join(__dirname,'native-http.cjs'))}).fetchNative(process.argv[1],{},1024).then(()=>{process.exitCode=2},()=>console.log('rejected safely'))`;
 const child=spawn(process.execPath,['-e',script,url],{stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);
 const [code]=await once(child,'close');assert.equal(code,0,error);assert.match(output,/rejected safely/);
});
test('THS text requests using default fetch also reject malformed encodings safely in Electron',async t=>{
 const instance=net.createServer(socket=>{socket.on('error',()=>{});socket.once('data',()=>socket.end('HTTP/1.1 200 OK\r\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nContent-Length: 1\r\nConnection: close\r\n\r\n'));});await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));t.after(()=>instance.close());
 const electronRoot=path.dirname(require.resolve('electron/package.json'));const binary=path.join(electronRoot,'dist',fs.readFileSync(path.join(electronRoot,'path.txt'),'utf8').trim());
 const script=`${productionTransportProbe()} require(${JSON.stringify(path.join(__dirname,'ths-quote.cjs'))}).fetchThsText(fetch,process.argv[1],'utf-8','',1000).then(()=>{process.exitCode=2},()=>{console.log('rejected safely');setTimeout(()=>{},100)})`;
 const child=spawn(binary,['-e',script,`http://127.0.0.1:${instance.address().port}`],{env:{...process.env,ASTOCK_HTTP_TRANSPORT:undefined,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);const timer=setTimeout(()=>child.kill(),5000);t.after(()=>clearTimeout(timer));
 const [code]=await once(child,'close');assert.equal(code,0,error);assert.match(output,/rejected safely/);
});
test('cancellation waits for the decompressor to close before releasing the request',async t=>{
 const {Transform}=require('node:stream');const descriptor=Object.getOwnPropertyDescriptor(zlib,'createGunzip');const filename=require.resolve('./native-http.cjs');
 let enter;const entered=new Promise(resolve=>enter=resolve);let physicallyClosed=false;
 Object.defineProperty(zlib,'createGunzip',{configurable:true,value:()=>new Transform({transform(_b,_e,_cb){enter();},destroy(error,callback){setTimeout(()=>{physicallyClosed=true;callback(error)},30);}})});
 delete require.cache[filename];const {fetchNative}=require(filename);t.after(()=>{Object.defineProperty(zlib,'createGunzip',descriptor);delete require.cache[filename];});
 const url=await server(t,(_req,res)=>{res.writeHead(200,{'content-encoding':'gzip'});res.end('compressed payload');});const controller=new AbortController();const pending=fetchNative(url,{signal:controller.signal},1024);
 const rejected=assert.rejects(pending,/cancelled/);await entered;controller.abort(new Error('cancelled'));await rejected;assert.equal(physicallyClosed,true);
});

test('跨域重定向不重发请求体、不降级 HTTPS、去掉 refresh_token', async () => {
  const http = require('node:http');
  const { fetchNative } = require('./native-http.cjs');
  const seen = [];
  const target = http.createServer((req, res) => { seen.push(req.headers); res.end('ok'); });
  await new Promise(r => target.listen(0, '127.0.0.1', r));
  const targetUrl = `http://localhost:${target.address().port}/x`;
  const source = http.createServer((req, res) => { res.writeHead(Number(req.url.slice(1)), { location: targetUrl }); res.end(); });
  await new Promise(r => source.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${source.address().port}`;
  try {
    await assert.rejects(fetchNative(`${base}/307`, { method: 'POST', body: 'token=secret' }), /不向其他站点重发请求体/);
    const res = await fetchNative(`${base}/302`, { headers: { refresh_token: 'r', 'x-access-token': 'a', 'api-key': 'k' } });
    assert.equal(await res.text(), 'ok');
    assert.equal(seen.length, 1);
    for (const name of ['refresh_token', 'x-access-token', 'api-key']) assert.equal(seen[0][name], undefined);
  } finally { source.close(); target.close(); }
});
