'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPreview, openView } = require('./frontend-v150.cjs');

test('full app T toolbox loads history, draws and persists lines independently of minute data', async () => {
  const app = await createPreview();
  const page = await app.browser.newPage({viewport:{width:1480,height:1000}});
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));page.setDefaultTimeout(8000);
  try {
    await page.goto(app.url+'?populated=1');await page.locator('.workspace-navigation').waitFor();
    await page.evaluate(() => {
      window.chartCalls=[];
      window.stockApi.getChart=async (stock,interval) => {
        window.chartCalls.push({code:stock.code,interval});
        if (interval==='time') throw Error('分时暂不可用');
        const rows=Array.from({length:90},(_,i)=>{const close=10+i/20+Math.sin(i/5);return {
          date:interval==='101'||interval==='102'?new Date(Date.UTC(2026,6,i+1)).toISOString().slice(0,10):`2026-11-10 ${String(9+Math.floor((30+i)/60)).padStart(2,'0')}:${String((30+i)%60).padStart(2,'0')}`,
          open:close-.1,high:close+.2,low:close-.2,close,volume:100+i,volumeUnit:'lots'};});
        return {rows,source:'工具箱测试源',adjustment:Number(interval)<100?'不复权':'前复权',updatedAt:'2026-11-11T03:00:00Z'};
      };
    });
    await openView(page,'t-assistant','做T助手');
    await page.getByRole('button',{name:'从持仓导入',exact:true}).click();
    const box=page.locator('.t-toolbox');await box.waitFor();
    await box.locator('svg.t-toolbox-chart').waitFor();
    assert.match(await box.innerText(),/工具箱测试源/);
    assert.match(await box.innerText(),/历史支撑|前20/);
    assert.ok(await box.locator('.toolbox-candle').count()>0);
    for (const label of ['MACD','KDJ','RSI']) await box.getByRole('button',{name:label,exact:true}).click();
    assert.equal(await box.locator('.toolbox-indicator-pane').count(),4);
    await box.getByLabel('水平线价格').fill('12.34');
    await box.getByRole('button',{name:'添加水平线',exact:true}).click();
    await box.locator('.toolbox-drawing').waitFor();
    assert.match(await box.locator('.toolbox-drawing-list').innerText(),/12.34/);
    await box.getByRole('button',{name:'趋势线',exact:true}).click();
    const svg=box.locator('svg.t-toolbox-chart');const bounds=await svg.boundingBox();
    await svg.click({position:{x:bounds.width*.3,y:bounds.height*.25}});
    assert.match(await box.locator('.toolbox-help').innerText(),/已选起点/);
    await svg.click({position:{x:bounds.width*.6,y:bounds.height*.3}});
    assert.equal(await box.locator('.toolbox-drawing').count(),2);
    await box.getByRole('button',{name:'撤销画线',exact:true}).click();
    assert.equal(await box.locator('.toolbox-drawing').count(),1);
    await box.getByRole('button',{name:'5分',exact:true}).click();
    await page.waitForFunction(()=>window.chartCalls.some(c=>c.interval==='5'));
    await box.getByText(/不复权/).first().waitFor();
    assert.equal(await box.locator('.toolbox-drawing').count(),0);
    await box.getByRole('button',{name:'日K',exact:true}).click();
    await box.locator('.toolbox-drawing').waitFor();
    await page.getByRole('button',{name:'板块强度',exact:true}).first().click();
    await openView(page,'t-assistant','做T助手');
    await box.locator('.toolbox-drawing').waitFor();
    assert.match(await box.locator('.toolbox-drawing-list').innerText(),/12.34/);
    assert.equal(await box.locator('.toolbox-indicator-pane').count(),4,'reopening the toolbox restores chosen indicators');
    await page.evaluate(()=>{const original=window.stockApi.getChart;window.stockApi.getChart=async (...args)=>{
      const response=await original(...args);const last=response.rows.at(-1);const day=new Date(last.date.slice(0,10)+'T00:00:00Z');day.setUTCDate(day.getUTCDate()+1);
      return {...response,source:response.source+' · 滚动核对',rows:[...response.rows.slice(1),{...last,date:day.toISOString().slice(0,10)}]};
    };});
    await box.getByRole('button',{name:'刷新K线',exact:true}).click();
    await box.locator('.toolbox-meta').getByText(/滚动核对/).waitFor();
    assert.equal(await box.locator('.toolbox-drawing').count(),1,'normal rolling history must preserve drawings');
    await box.getByRole('button',{name:'全部',exact:true}).click();
    assert.equal(await box.locator('.toolbox-candle').count(),90);
    await require('node:fs/promises').mkdir(require('node:path').resolve(__dirname,'../artifacts/t-toolbox-1659'),{recursive:true});
    await box.screenshot({path:require('node:path').resolve(__dirname,'../artifacts/t-toolbox-1659/toolbox-light.png')});
    await page.getByRole('button',{name:'黑夜',exact:true}).click();
    await box.screenshot({path:require('node:path').resolve(__dirname,'../artifacts/t-toolbox-1659/toolbox-dark.png')});
    await box.getByLabel('水平线价格').fill('12.54');
    await box.getByRole('button',{name:'添加水平线',exact:true}).click();
    await page.evaluate(()=>{const original=window.stockApi.getChart;window.stockApi.getChart=async (...args)=>{const response=await original(...args);return {...response,rows:response.rows.map(row=>({...row,open:row.open*.9,high:row.high*.9,low:row.low*.9,close:row.close*.9}))};};});
    await box.getByRole('button',{name:'刷新K线',exact:true}).click();
    await box.getByRole('alert').filter({hasText:'历史价格已修订'}).waitFor();
    assert.equal(await box.locator('.toolbox-drawing').count(),0);
    assert.equal(await box.getByRole('button',{name:'撤销画线',exact:true}).isDisabled(),true);
    assert.equal(await box.getByRole('button',{name:'删除选中',exact:true}).isDisabled(),true);
    await page.setViewportSize({width:780,height:1000});
    assert.ok(await box.evaluate(e=>e.scrollWidth<=e.clientWidth+2),'toolbox must fit narrow screens');
    assert.deepEqual(errors,[]);
  } finally {await page.close();await app.close();}
});

test('slow timeframe responses cannot overwrite the latest chart; retry preserves only the same context', async () => {
  const app=await createPreview();const page=await app.browser.newPage({viewport:{width:1480,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
  try {
    await page.goto(app.url+'?populated=1');await page.locator('.workspace-navigation').waitFor();
    await page.evaluate(()=>{
      window.cancelled=[]; window.stockApi.cancelServiceJob=async id=>{window.cancelled.push(id);return true;};
      window.stockApi.getChart=async (stock,frame,options)=>{
        if(frame==='time')throw Error('分时暂缺');
        if(frame==='101' && options.adjustment==='front' && window.failDaily)throw Error('日线背景源失败');
        if(frame==='5')await new Promise(resolve=>{window.finishFive=resolve;});
        if(frame==='15' && window.failFifteen)throw Error('十五分钟源断开');
        return {source:`测试-${frame}-${stock.code}`,adjustment:window.rawDaily&&frame==='101'?'不复权（备用通道）':Number(frame)<100||options.adjustment==='none'?'不复权':'前复权',rows:Array.from({length:70},(_,i)=>({
          date:new Date(Date.UTC(2026,6,i+1)).toISOString().slice(0,10)+(Number(frame)<100?' 10:00':''),open:10,high:11,low:9,close:10,volume:100,volumeUnit:'lots'
        }))};
      };
    });
    await openView(page,'t-assistant','做T助手');await page.getByRole('button',{name:'从持仓导入',exact:true}).click();
    const box=page.locator('.t-toolbox');await box.locator('svg').waitFor();
    await box.getByRole('button',{name:'5分',exact:true}).click();
    await page.waitForFunction(()=>typeof window.finishFive==='function');
    await box.getByRole('button',{name:'15分',exact:true}).click();
    await box.locator('.toolbox-meta').getByText(/测试-15-/).waitFor();
    await page.evaluate(()=>window.finishFive());
    assert.match(await box.locator('.toolbox-meta').innerText(),/测试-15-/);
    assert.doesNotMatch(await box.locator('.toolbox-meta').innerText(),/测试-5-/);
    assert.ok(await page.evaluate(()=>window.cancelled.length>0));
    await page.evaluate(()=>{window.failFifteen=true;});
    await box.getByRole('button',{name:'刷新K线',exact:true}).click();
    await box.getByRole('alert').filter({hasText:'十五分钟源断开'}).waitFor();
    assert.match(await box.locator('.toolbox-meta').innerText(),/测试-15-/);
    assert.ok(await box.locator('.toolbox-candle').count()>0);
    await box.getByRole('button',{name:'MACD',exact:true}).click();
    await box.getByRole('button',{name:'BOLL',exact:true}).click();
    await page.evaluate(()=>{window.failFifteen=false;});
    await page.locator('.t-assistant-row').nth(1).click();
    assert.equal(await box.getByRole('button',{name:'15分',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await box.getByRole('button',{name:'MACD',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await box.getByRole('button',{name:'BOLL',exact:true}).getAttribute('aria-pressed'),'true');
    await box.locator('.toolbox-meta').getByText(/测试-15-300750/).waitFor();
    await box.getByRole('button',{name:'日K',exact:true}).click();
    await box.locator('.toolbox-meta').getByText(/测试-101-300750/).waitFor();
    assert.equal(await box.locator('.toolbox-drawing').count(),0);
    await box.getByLabel('K线复权方式').selectOption('none');
    await box.locator('.toolbox-meta').getByText(/不复权/).waitFor();
    await page.evaluate(()=>{window.failDaily=true;});
    await box.getByRole('button',{name:'刷新K线',exact:true}).click();
    await box.getByRole('alert').filter({hasText:'日线背景源失败'}).waitFor();
    assert.match(await box.locator('.toolbox-reading').innerText(),/更新失败|待核对/);
    await page.evaluate(()=>{window.failDaily=false;window.rawDaily=true;});
    await box.getByRole('button',{name:'刷新K线',exact:true}).click();
    await box.getByRole('alert').filter({hasText:'日线背景实际为'}).waitFor();
    assert.match(await box.locator('.toolbox-summary > div').first().innerText(),/不复权/);

    assert.deepEqual(errors,[]);
  } finally {await page.close();await app.close();}
});

test('chart supports anchored wheel zoom, drag pan, reset and every timeframe while viewing history', async () => {
  const app=await createPreview();const page=await app.browser.newPage({viewport:{width:1480,height:1000}});
  page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.goto(app.url+'?populated=1');await page.locator('.workspace-navigation').waitFor();
    await page.evaluate(()=>{
      window.stockApi.getChart=async (stock,frame)=>{
        if(frame==='time')throw Error('分时暂缺');
        return {source:`缩放测试-${frame}`,adjustment:Number(frame)<100?'不复权':'前复权',rows:Array.from({length:200},(_,i)=>({date:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10)+(Number(frame)<100?' 10:00':''),open:10+i/100,high:11+i/100,low:9+i/100,close:10.5+i/100,volume:100,volumeUnit:'lots'}))};
      };
    });
    await openView(page,'t-assistant','做T助手');await page.getByRole('button',{name:'从持仓导入',exact:true}).click();
    const box=page.locator('.t-toolbox'),svg=box.locator('svg.t-toolbox-chart');await svg.waitFor();
    await svg.scrollIntoViewIfNeeded();let rect=await svg.boundingBox();
    const x=rect.x+rect.width*.55,y=rect.y+rect.height*.3;
    const scrollBefore=await svg.evaluate(e=>{const positions=[];for(let p=e.parentElement;p;p=p.parentElement)positions.push(p.scrollTop);return positions;});
    await page.mouse.move(x,y);await page.mouse.wheel(0,-160);
    await page.waitForFunction(()=>document.querySelectorAll('.toolbox-candle').length<60);
    const zoomCount=await box.locator('.toolbox-candle').count();assert.ok(zoomCount>=10);
    assert.deepEqual(await svg.evaluate(e=>{const positions=[];for(let p=e.parentElement;p;p=p.parentElement)positions.push(p.scrollTop);return positions;}),scrollBefore,'wheel must not scroll the enclosing page');
    await page.mouse.wheel(0,-1);
    await page.waitForFunction(n=>document.querySelectorAll('.toolbox-candle').length<n,zoomCount);
    await page.mouse.wheel(0,1);
    await page.waitForFunction(n=>document.querySelectorAll('.toolbox-candle').length===n,zoomCount);
    const before=await box.locator('.t-toolbox-window > span').innerText();
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+rect.width*.2,y,{steps:10});await page.mouse.up();
    assert.notEqual(await box.locator('.t-toolbox-window > span').innerText(),before,'drag must move the visible historical window');
    assert.equal(await box.locator('.toolbox-candle').count(),zoomCount);
    assert.equal(await box.locator('.toolbox-drawing').count(),0,'pan must not create drawings');
    await svg.dblclick({position:{x:rect.width*.5,y:rect.height*.3}});
    assert.equal(await box.locator('.toolbox-candle').count(),60);
    assert.equal(await box.getByRole('button',{name:'回到最新',exact:true}).isDisabled(),true);
    await box.getByRole('button',{name:'放大K线',exact:true}).click();assert.ok(await box.locator('.toolbox-candle').count()<60);
    await box.getByRole('button',{name:'缩小K线',exact:true}).click();
    await svg.focus();await page.keyboard.press('+');assert.ok(await box.locator('.toolbox-candle').count()<60);
    await page.keyboard.press('0');assert.equal(await box.locator('.toolbox-candle').count(),60);
    for(const [label,id] of [['1分','1'],['5分','5'],['15分','15'],['30分','30'],['60分','60'],['周K','102'],['日K','101']]) {
      await svg.scrollIntoViewIfNeeded();
      const switcher=box.getByRole('group',{name:'K线周期',exact:true});
      assert.ok(await switcher.evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<innerHeight;}),'timeframe switcher remains visible when chart is in view');
      await switcher.getByRole('button',{name:label,exact:true}).click();
      await box.locator('.toolbox-meta').getByText(new RegExp(`缩放测试-${id} ·`)).waitFor();
      assert.equal(await switcher.getByRole('button',{name:label,exact:true}).getAttribute('aria-pressed'),'true');
    }
    assert.deepEqual(errors,[]);
  } finally {await page.close();await app.close();}
});

test('T assistant answers AI questions inline, keeps followups and isolates stocks', async () => {
  const app=await createPreview();const page=await app.browser.newPage({viewport:{width:1480,height:1000}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.goto(app.url+'?populated=1');await page.locator('.workspace-navigation').waitFor();
    await page.evaluate(()=>{
      const threads=new Map(),runs=new Map();let seq=0;window.tAiCalls=[];
      const state=()=>({configured:true,profiles:[],conversations:[...threads.values()].map(c=>({...c,turns:c.messages.length})),tools:[],memory:'',skillIds:[]});
      window.stockApi.ai={...window.stockApi.ai,agent:{state:async()=>state(),settings:async()=>state(),conversation:async id=>structuredClone(threads.get(id)||null),
        start:async input=>{window.tAiCalls.push(input);const id=input.conversationId||`c${++seq}`,runId=`r${++seq}`;const at=new Date().toISOString();
          const c=threads.get(id)||{id,title:`${input.focus.name} · ${input.title}`,focus:input.focus,createdAt:at,updatedAt:at,messages:[]};c.messages.push({id:`u${seq}`,role:'user',content:input.message,at});threads.set(id,c);runs.set(runId,id);return {runId,conversationId:id};},
        poll:async runId=>{const c=threads.get(runs.get(runId));const message={id:runId,role:'assistant',content:`${c.focus.code} 工具箱内回答`,at:new Date().toISOString(),followUps:[]};if(!c.messages.some(m=>m.id===runId))c.messages.push(message);return {runId,conversationId:c.id,status:'done',steps:[],message};},cancel:async()=>null}};
    });
    await openView(page,'t-assistant','做T助手');await page.getByRole('button',{name:'从持仓导入',exact:true}).click();
    await page.getByRole('button',{name:'问 AI 做T思路',exact:true}).click();
    const panel=page.getByRole('region',{name:'做T AI分析',exact:true});await panel.waitFor();
    await panel.getByText('600519 工具箱内回答',{exact:true}).waitFor();
    assert.equal(await page.locator('.t-toolbox').count(),1,'chart and answer stay on the same page');
    assert.equal(await panel.getByRole('complementary',{name:'对话列表'}).count(),0);
    await panel.getByRole('textbox',{name:'向 AI 提问',exact:true}).fill('再说说量能');await panel.getByRole('button',{name:'发送',exact:true}).click();
    await page.waitForFunction(()=>window.tAiCalls.length===2);
    assert.equal(await page.evaluate(()=>window.tAiCalls[1].conversationId),'c1');
    await panel.getByRole('button',{name:'发送',exact:true}).waitFor();
    await page.getByRole('button',{name:'收起AI分析',exact:true}).click();await page.getByRole('button',{name:'问 AI 做T思路',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.tAiCalls.length),2,'reopening must not trigger another paid request');
    await page.locator('.t-assistant-row').nth(1).click();await page.getByRole('button',{name:'问 AI 做T思路',exact:true}).click();
    await panel.getByText('300750 工具箱内回答',{exact:true}).waitFor();
    assert.equal(await panel.getByText('600519 工具箱内回答',{exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.tAiCalls[2].conversationId),undefined);
    await page.locator('.t-assistant-row').first().click();await page.getByRole('button',{name:'问 AI 做T思路',exact:true}).click();
    await panel.getByText('600519 工具箱内回答',{exact:true}).first().waitFor();
    assert.equal(await page.evaluate(()=>window.tAiCalls.length),3,'returning to stock resumes its conversation');
    await page.setViewportSize({width:780,height:1000});
    assert.ok(await panel.evaluate(e=>e.scrollWidth<=e.clientWidth+2),'inline AI must fit narrow screens');
    await require('node:fs/promises').mkdir(require('node:path').resolve(__dirname,'../artifacts/t-toolbox-1660'),{recursive:true});
    await panel.screenshot({path:require('node:path').resolve(__dirname,'../artifacts/t-toolbox-1660/inline-ai.png')});
    assert.deepEqual(errors,[]);
  } finally {await page.close();await app.close();}
});
