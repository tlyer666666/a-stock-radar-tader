'use strict';

// Independent consumer-boundary probes for the 2026-10-01 polish pass.
// All fixtures are synthetic; no real profile, provider request or old release is used.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BoundedCache } = require('../electron/bounded-cache.cjs');
const { createServiceRuntime } = require('../electron/service-runtime.cjs');
const root = path.resolve(__dirname, '..');

test('opening deeply damaged stock archive snapshots recovers a usable backup without rewriting stored evidence', async () => {
  const { createServer } = await import('vite');
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import Review, {stockReviewFromPayload} from '/src/ProfessionalReview.tsx';
    const key='a-stock-radar-professional-review-v1';
    window.stockApi={getProfessionalReview:()=>new Promise(()=>{}),search:()=>Promise.resolve([])};
    const snapshot=stockReviewFromPayload({security:{code:'600000',name:'合成证券',secid:'1.600000'},quote:{latest:10},analysis:{},history:[],updatedAt:'2026-10-01T01:00:00Z'});
    const good={id:'independent-good',type:'stock',title:'独立探针有效备份',date:'2026-10-01',score:50,verdict:'合成条件',note:'',createdAt:'2026-10-01T01:00:00Z',snapshot};
    const bad=JSON.parse(JSON.stringify(good));bad.id='independent-bad';bad.title='独立探针损坏主档';
    const variant=new URLSearchParams(location.search).get('variant');
    if(variant==='factor')bad.snapshot.factors=[null];
    if(variant==='checklist')bad.snapshot.checklist.confirmed=null;
    if(variant==='security')bad.snapshot.security.name={unexpected:'object'};
    window.originalPrimary=JSON.stringify([bad]);
    localStorage.setItem(key,window.originalPrimary);localStorage.setItem(key+':last-good',JSON.stringify([good]));
    createRoot(document.getElementById('root')).render(React.createElement(Review));
  </script></body></html>`;
  const server = await createServer({plugins:[{name:'independent-polish-fixture',configureServer(vite){vite.middlewares.use(async(request,response,next)=>{if(!request.url.startsWith('/__independent_polish__'))return next();try{response.setHeader('Content-Type','text/html');response.end(await vite.transformIndexHtml(request.url,html));}catch(error){next(error);}});}}],server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error'});
  let browser;
  const failures = [];
  try {
    await server.listen();
    browser = await require('playwright-core').chromium.launch({executablePath:process.env.QA_CHROMIUM_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    for (const variant of ['factor', 'checklist', 'security']) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(2000);
      try {
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__independent_polish__?variant=${variant}`);
        await page.getByRole('tab',{name:/复盘档案/}).click();
        const entry = page.locator('.review-archive-list > button').first();
        await entry.click();
        await page.waitForTimeout(50);
        assert.deepEqual(errors, [], `${variant} emitted a renderer error`);
        assert.equal(await page.getByRole('heading',{name:'专业复盘',exact:true}).count(), 1, `${variant} lost the workspace`);
        assert.equal(await page.evaluate(()=>localStorage.getItem('a-stock-radar-professional-review-v1')===window.originalPrimary),true,'recovery must leave source evidence intact');
        assert.equal(await page.locator('.review-stock').count() > 0 || await page.getByText('合成证券',{exact:false}).count() > 0,true,'a usable archived stock must open');
      } catch (error) { failures.push({variant,message:error.message,rendererErrors:errors}); }
      finally { await page.close(); }
    }
  } finally { await browser?.close(); await server.close(); }
  assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
});

test('serviceRuntime cache consumer reaccounts a force refresh, restores failed stale data, and evicts at the stale boundary', async () => {
  let now = 1000;
  const cache = new BoundedCache({maxEntries:2,maxBytes:600,now:()=>now});
  const runtime = createServiceRuntime({now:()=>now});
  let finish;
  try {
    const first = runtime.cached(cache,'stock',20,()=>Promise.resolve({source:'first'}),{staleTtlMs:80});
    assert.deepEqual(await first,{source:'first'});await first.drained;
    const storedBytes = cache.getDiagnostics().accountedBytes;
    assert.ok(storedBytes > 0);
    now = 1030;
    const pending = runtime.cached(cache,'stock',20,()=>new Promise(resolve=>{finish=resolve;}),{forceRefresh:true,staleTtlMs:80});
    const joined = runtime.cached(cache,'stock',20,()=>{throw Error('duplicate producer');});
    assert.equal(cache.getDiagnostics().pendingEntries,1);
    assert.equal(cache.getDiagnostics().completedEntries,0);
    assert.equal(cache.getDiagnostics().accountedBytes,0);
    await new Promise(resolve=>setImmediate(resolve));
    finish({source:'second'});
    assert.deepEqual(await Promise.all([pending,joined]),[{source:'second'},{source:'second'}]);
    await pending.drained;await joined.drained;
    assert.equal(cache.getDiagnostics().pendingEntries,0);
    assert.equal(cache.getDiagnostics().completedEntries,1);
    now = 1060;
    const failed = runtime.cached(cache,'stock',20,()=>Promise.reject(Error('fixture unavailable')),{forceRefresh:true});
    await assert.rejects(failed,/fixture unavailable/);await failed.drained;
    assert.deepEqual(cache.get('stock').value,{source:'second'});
    assert.equal(cache.getDiagnostics().pendingEntries,0);
    assert.ok(cache.getDiagnostics().accountedBytes > 0);
    now = 1110;
    assert.equal(cache.has('stock'),false);
    assert.equal(cache.getDiagnostics().completedEntries,0);
    assert.equal(cache.getDiagnostics().accountedBytes,0);
  } finally { await runtime.shutdown(); }
});

test('dependency gate actual CLI fails closed on malformed, truncated and command-failed audit responses', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'radar-independent-audit-'));
  try {
    const runner = path.join(temporary, 'audit-fixture.cjs');
    fs.writeFileSync(runner, "const fs=require('node:fs'),path=require('node:path');const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'response.json'),'utf8'));process.stdout.write(fixture.output);process.exit(fixture.exit);\n");
    fs.writeFileSync(path.join(temporary, 'pnpm'), `#!${process.execPath}\nrequire(${JSON.stringify(runner)});\n`, {mode:0o755});
    fs.writeFileSync(path.join(temporary, 'pnpm.cmd'), `@"${process.execPath}" "${runner}" %*\r\n`);
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
    const clean = JSON.stringify({advisories:{},metadata:{vulnerabilities:{info:0,low:0,moderate:0,high:0,critical:0}}});
    for (const fixture of [
      {name:'malformed',output:'registry unavailable',exit:1,expected:/invalid JSON/},
      {name:'truncated',output:'{"advisories":',exit:0,expected:/invalid JSON/},
      {name:'command failed despite clean payload',output:clean,exit:2,expected:/audit command exit 2/}
    ]) {
      fs.writeFileSync(path.join(temporary, 'response.json'), JSON.stringify(fixture));
      const run = spawnSync(process.execPath,[path.join(root,'qa/verify-dependencies.cjs'),'--audit'],{cwd:root,env:{...process.env,[pathKey]:`${temporary}${path.delimiter}${process.env[pathKey] || ''}`},encoding:'utf8',timeout:30000});
      assert.equal(run.error,undefined,fixture.name);
      assert.equal(run.status,1,fixture.name);
      assert.match(run.stderr,fixture.expected,fixture.name);
      assert.equal(run.stdout,'',`${fixture.name} must not emit a success report`);
    }
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
});
