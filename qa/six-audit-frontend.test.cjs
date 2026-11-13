'use strict';
const {test,before,after}=require('node:test');const assert=require('node:assert/strict');
let server,browser,base;
before(async()=>{ const {createServer}=await import('vite');server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'}); await server.listen();base=`http://127.0.0.1:${server.httpServer.address().port}/qa/six-audit-frontend-harness.html`;browser=await require('playwright-core').chromium.launch({executablePath:process.env.QA_CHROMIUM_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
// 冷启动护栏：Vite 首次按需编译依赖图时会整页 reload。首个用例（P1-21）在冷缓存
// 且机器同时跑其它浏览器套件时，曾出现 5s 默认超时（随后连续两轮均通过）。
// 这里先用一页把依赖图编译一遍并等 fixture 就绪，避免把冷启动时间算进用例超时。
const warm=await browser.newPage();
try{ await warm.goto(base+'?mode=failed'); await warm.waitForFunction(()=>window.fixture?.ready===true,undefined,{timeout:60000}); await warm.locator('.puf-table-scroll tbody tr').first().waitFor({timeout:60000}); }
catch{ /* 预热只影响速度，断言仍由各用例自己负责 */ }
finally{ await warm.close(); }});
after(async()=>{await browser?.close();await server?.close();});
async function fixture(mode='app'){const page=await browser.newPage({viewport:{width:1480,height:940}});page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message)); await page.goto(base+'?mode='+mode);await page.waitForFunction(()=>window.fixture?.ready===true);if(mode==='app')await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');return {page,errors};}
test('P1-21 nullable industry search renders empty results without crash',async()=>{const {page,errors}=await fixture('failed');try{await page.locator('.puf-table-scroll tbody tr').first().waitFor();await page.locator('.puf-search input').fill('无此行业');await page.waitForTimeout(50);assert.deepEqual(errors,[]);assert.ok(await page.getByText(/当前搜索.*没有符合记录。/).isVisible());}finally{await page.close();}});
test('P1-23 degraded market containers and returns remain readable',async()=>{const {page,errors}=await fixture('review');try{await page.waitForFunction(()=>document.querySelector('.review-legacy-details'));await page.evaluate(()=>{window.fixture.reviewDegraded=true;});await page.getByRole('button',{name:'重新计算'}).click();await page.waitForTimeout(100);assert.deepEqual(errors,[]);assert.ok(await page.locator('.review-legacy-details').isVisible());}finally{await page.close();}});
test('P2 sector null returns and money stay neutral and IME Enter does not submit',async()=>{const {page,errors}=await fixture('sector');try{await page.getByRole('button',{name:'审计板块，展开个股',exact:true}).click();const row=page.locator('.member-row').filter({hasText:'缺值样本'});await row.waitFor();assert.doesNotMatch(await row.innerText(),/\+--/);assert.equal(await row.locator('.red,.green').count(),0);const input=page.getByPlaceholder('输入 PCB、CPO、机器人、算力、低空经济等');await input.fill('新能源');await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.kind==='sectorAnalyze').length),1);assert.deepEqual(errors,[]);}finally{await page.close();}});
test('P2 global suggestions close on an outside pointer and cannot reappear from pending result',async()=>{const {page,errors}=await fixture();try{const input=page.locator('#global-security-search');await input.fill('600');await page.locator('#global-security-suggestions').waitFor();await page.locator('.workspace-location').click();assert.equal(await page.locator('#global-security-suggestions').count(),0);assert.deepEqual(errors,[]);}finally{await page.close();}});
test('P1-22 review storage updates sync and save retains records written by another window',async()=>{const context=await browser.newContext();const first=await context.newPage();const second=await context.newPage();try{await first.goto(base+'?mode=review');await second.goto(base+'?mode=review');await first.getByText('记录你的条件判断',{exact:true}).waitFor();await second.evaluate(()=>{const key='a-stock-radar-professional-review-v1';localStorage.setItem(key,JSON.stringify([{id:'other',type:'market',title:'另一窗口',date:'2026-10-19',score:1,verdict:'观察',note:'外部',createdAt:new Date().toISOString(),snapshot:{market:{available:false},ecology:{}}}]));});await first.getByRole('tab',{name:'复盘档案 1'}).waitFor({timeout:3000});await first.getByRole('button',{name:/保存.*复盘|保存条件记录|保存本次判断/}).first().click();await first.getByText('本次市场复盘已保存',{exact:true}).waitFor();
// D2-07c：浏览器预览（harness 用 createPreviewApi）保存的复盘快照带 dataNature=preview，
// ProfessionalReview 会把这类快照写进隔离键 <archive>:preview，正式档案键保持干净
// （见 src/ProfessionalReview.tsx 的 persistArchive / isPreviewReviewSnapshot）。
// 原断言只读正式键并期待 2 条，属于「断言过期」：现在正式键里仍只有另一窗口写入的那条。
const stored=await first.evaluate(()=>{const read=key=>{try{return JSON.parse(localStorage.getItem(key)||'[]')}catch{return[]}};return{formal:read('a-stock-radar-professional-review-v1'),preview:read('a-stock-radar-professional-review-v1:preview')};});
const written=[...stored.preview,...stored.formal].filter(record=>record.id!=='other');
assert.equal(written.length,1,'本次复盘必须落盘（写入隔离键或正式键之一）');
assert.equal(written[0]?.snapshot?.dataNature,'preview','浏览器预览快照必须标记为 preview，才能与正式复盘档案隔离');
assert.ok(stored.formal.some(record=>record.id==='other'),'另一窗口写入的正式记录必须保留');
assert.equal(stored.formal.length,1,'正式复盘档案不得被预览快照污染');
assert.ok(stored.preview.some(record=>record.id===written[0]?.id),'预览快照应落在隔离键中');}finally{await context.close();}});
test('P1-33/34 light action tokens and semantic states are consistent',async()=>{const {page}=await fixture();try{const colors=await page.evaluate(()=>{const host=document.querySelector('.app-shell');host.insertAdjacentHTML('beforeend','<div class="timeline-node passed"><span id="audit-passed">通过</span></div>');const style=getComputedStyle(document.documentElement);return {passed:getComputedStyle(document.getElementById('audit-passed')).color,down:style.getPropertyValue('--down').trim(),indicator:style.getPropertyValue('--navigation-indicator').trim(),accent:style.getPropertyValue('--accent').trim(),fill:style.getPropertyValue('--action-fill').trim()};});assert.equal(colors.fill,'#2563EB');assert.equal(colors.indicator,colors.accent);assert.equal(colors.passed,'rgb(9, 112, 73)');}finally{await page.close();}});
test('P1-35 standalone review error fallback is styled without introducing a sidebar grid',async()=>{const {page}=await fixture('standalone');try{const card=page.locator('.app-crash-card');await card.waitFor();assert.equal(await page.locator('.app-crash-fallback').evaluate(el=>getComputedStyle(el).display),'grid');assert.ok(await card.evaluate(el=>el.getBoundingClientRect().width>=400));assert.notEqual(await page.locator('body').evaluate(el=>getComputedStyle(el).display),'grid');}finally{await page.close();}});

test("failed-board history refreshes the selected date and keeps its last good rows and filters", async () => {
  const { page, errors } = await fixture("failed-refresh");
  try {
    await page.getByRole("button", { name: "炸板观察", exact: true }).click();
    const board = page.getByRole("region", { name: "炸板股票数据，可横向滚动" });
    const refresh = page.getByRole("button", { name: "刷新", exact: true });
    await board.getByRole("row").nth(1).waitFor();
    await page.getByRole("tab", { name: "近五日炸板", exact: true }).click();
    const dayTabs = page.getByRole("tablist", { name: "选择炸板交易日" });
    assert.equal(await dayTabs.getByRole("tab").count(), 5);
    const chosen = dayTabs.getByRole("tab").nth(2);
    const date = await chosen.locator("span").innerText();
    await chosen.click();
    const sort = board.getByRole("button", { name: "开板次数" });
    const codes = () => board.locator("tbody .puf-stock-cell code").allTextContents();
    await sort.click();
    assert.deepEqual(await codes(), ["600003", "600002", "600001"]);
    await sort.click();
    assert.deepEqual(await codes(), ["600002", "600003", "600001"]);
    const search = page.getByRole("textbox", { name: "搜索名称、代码或行业" });
    await search.fill("排序两次");
    assert.deepEqual(await codes(), ["600003"]);
    await page.evaluate(() => { window.fixture.failedDateUnavailable = true; });
    await refresh.click();
    await page.getByText(/保留该日上次成功的数据/).waitFor();
    assert.match(await chosen.innerText(), /3 只.*旧快照/s);
    const options = await page.evaluate(() => window.fixture.calls.find(call => call.kind === "failed" && call.options.forceRefresh).options);
    assert.deepEqual(options, { forceRefresh: true, refreshDate: date });
    assert.deepEqual(await codes(), ["600003"]);
    await board.getByRole("button", { name: "分析", exact: true }).click();
    await page.getByRole("button", { name: "返回炸板观察", exact: true }).click();
    await page.getByText(/保留该日上次成功的数据/).waitFor();
    assert.equal(await chosen.getAttribute("aria-selected"), "true");
    assert.equal(await search.inputValue(), "排序两次");
    assert.deepEqual(await codes(), ["600003"]);
    await page.evaluate(() => { window.fixture.failedDateUnavailable = false; });
    await refresh.click();
    await page.getByText(new RegExp(date + "：刷新完成，3 只")).waitFor();
    assert.doesNotMatch(await chosen.innerText(), /旧快照/);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
