'use strict';

const {describe,test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {views,createPreview,openView,theme,geometry} = require('./frontend-v150.cjs');

const output = path.resolve(__dirname,'../artifacts/frontend-v150/after');
const actions = {
  'trend-screener': {name:'扫描全 A 股'}, signals:{name:'重新推演复核'}, sectors:{name:'刷新目录'},
  dashboard:{name:'刷新涨停池'}, watchlist:{name:'观察池下一页'}, favorites:{name:'设置条件'},
  holdings:{name:'保存持仓'}, review:{name:'重新计算'}, compare:{name:'刷新全部分析'},
  backtest:{name:'从所选日期开始回测'}, news:{name:'立即刷新'}, settings:{name:'保存设置'}
};

describe('v1.5.0 actual App navigation and responsive workspace layout',()=>{
  let app;
  const records=[];
  before(async()=>{ app=await createPreview(); await fs.mkdir(output,{recursive:true}); });
  after(async()=>{ await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(records,null,2)); await app?.close(); });

  async function withPage(width,run) {
    const page=await app.browser.newPage({viewport:{width,height:960}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    // Browser context and preview API are synthetic and isolated from desktop storage.
    page.setDefaultTimeout(5000);
    await page.route('**/*',route=>/^https?:\/\/127\.0\.0\.1(?::\d+)?\//.test(route.request().url()) ? route.continue() : route.abort());
    try {
      await page.goto(app.url+'?populated=1');
      await page.locator('.workspace-navigation').waitFor({timeout:15000});
      await run(page);
      assert.deepEqual(errors,[],'renderer errors');
    } catch(error) {
      await page.screenshot({path:path.join(output,`failure-${width}.png`),animations:'disabled'});
      if(errors.length) error.message += `\nRenderer errors: ${errors.join('; ')}`;
      throw error;
    } finally {await page.close();}
  }

  async function actionBounds(page,locator) {
    await locator.scrollIntoViewIfNeeded();
    return locator.evaluate(el=>{
      const b=el.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2,top=document.elementFromPoint(x,y);
      return {label:el.getAttribute('aria-label')||el.textContent,width:b.width,height:b.height,left:b.left,right:b.right,top:b.top,bottom:b.bottom,visible:b.width>0&&b.height>0,unobscured:Boolean(top&&(top===el||el.contains(top)))};
    });
  }

  for(const width of [1024,1280,1480,1920]) test(`${width}px: all twelve pages navigate, respect viewport and expose primary actions in both themes`,async()=>withPage(width,async page=>{
    const failures=[];
    for(const appearance of ['light','dark']) {
      await theme(page,appearance);
      for(const [id,label]of views) {
        await openView(page,id,label);
        if(id==='sectors') {
          await page.locator('.sector-explorer-entry').first().click();
          await page.locator('.sector-explorer-detail').waitFor();
        }
        if(id==='review') {
          await page.getByRole('tab',{name:'个股复盘',exact:true}).click();
          await page.getByPlaceholder('搜索 A股、ETF、可转债（代码或名称）').fill('600519');
          await page.getByRole('button',{name:'开始复盘',exact:true}).click();
          await page.locator('.review-measurements').waitFor();
        }
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const measured=await geometry(page);
        const record={id,label,theme:appearance,width,...measured};
        if(measured.active!==id||measured.textLength<30) failures.push(`${id}/${appearance}: expected loaded page`);
        for(const root of measured.roots) {
          if(root.scrollWidth>root.width+2||root.left< -2||root.right>width+2) failures.push(`${id}/${appearance}: viewport overflow ${JSON.stringify(root)}`);
        }
        const screenshot=`${String(views.findIndex(view=>view[0]===id)+1).padStart(2,'0')}-${id}-${appearance}-${width}.png`;
        await page.screenshot({path:path.join(output,screenshot),fullPage:false,animations:'disabled'});
        record.screenshot=screenshot;
        const locator=page.locator('.main > .page').getByRole('button',{...actions[id],exact:true}).first();
        const bounds=await actionBounds(page,locator);
        record.primaryAction=bounds;
        if(!bounds.visible||bounds.width<20||bounds.height<20||bounds.left<0||bounds.right>width||bounds.top<0||bounds.bottom>960||!bounds.unobscured) failures.push(`${id}/${appearance}: primary action inaccessible ${JSON.stringify(bounds)}`);
        const nav=page.getByRole('button',{name:label,exact:true}).first();
        if(await nav.getAttribute('aria-current')!=='page') failures.push(`${id}/${appearance}: active navigation is not announced`);
        records.push(record);
      }
    }
    assert.deepEqual(failures,[],failures.join('\n'));
  }));

  test('compact navigation preserves all destinations and theme selection',async()=>withPage(1024,async page=>{
    const collapse=page.getByRole('button',{name:/收起导航|展开导航/});
    await collapse.click();
    for(const [id,label]of views) await openView(page,id,label);
    await theme(page,'dark');
    assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
    await theme(page,'light');
    assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
    const measure=await geometry(page);
    assert.ok(measure.roots.every(root=>root.scrollWidth<=root.width+2),JSON.stringify(measure));
  }));

  test('settings, portfolio mode, monitor editor and news tabs remain reachable',async()=>withPage(1280,async page=>{
    await openView(page,'sectors','板块强度');
    const sectorStock=page.getByRole('combobox',{name:'股票名称或代码'});
    await sectorStock.fill('贵州');
    await page.getByRole('option',{name:/贵州茅台/}).waitFor();
    await sectorStock.press('ArrowDown');
    await sectorStock.press('Enter');
    assert.equal(await sectorStock.inputValue(),'贵州茅台 600519');
    await page.getByRole('button',{name:'查行业',exact:true}).click();
    await page.locator('.sector-explorer-detail h3').waitFor();
    assert.equal(await page.locator('.sector-explorer-detail h3').innerText(),'白酒');
    assert.match(await page.locator('.sector-explorer-detail tbody tr').first().innerText(),/板块样本01/);
    await page.getByLabel('筛选成分股').fill('板块样本36');
    assert.equal(await page.locator('.sector-explorer-detail tbody tr').count(),1);
    await page.getByLabel('筛选成分股').fill('');
    assert.equal(await page.locator('.sector-explorer-detail tbody tr').count(),36);
    await openView(page,'favorites','自选板块');
    await page.getByRole('button',{name:'设置条件',exact:true}).first().click();
    await page.locator('.stock-monitor-editor').waitFor();
    await page.getByRole('button',{name:/添加条件/}).click();
    assert.equal(await page.locator('.stock-monitor-condition').count(),2);
    const monitorAction=await actionBounds(page,page.getByRole('button',{name:'保存条件',exact:true}));
    assert.ok(monitorAction.unobscured,JSON.stringify(monitorAction));
    await page.locator('.main > .page').evaluate(el=>{el.scrollTop=0;});
    await page.screenshot({path:path.join(output,'13-monitor-editor-light-1280.png'),animations:'disabled'});
    await openView(page,'backtest','回测中心');
    await page.getByRole('button',{name:'多股组合回测',exact:true}).click();
    await page.locator('.portfolio-backtest-view').waitFor();
    await page.screenshot({path:path.join(output,'14-portfolio-backtest-light-1280.png'),animations:'disabled'});
    let measured=await geometry(page);
    assert.ok(measured.roots.every(root=>root.scrollWidth<=root.width+2),JSON.stringify(measured));
    await page.getByRole('button',{name:'单股明细回放',exact:true}).click();
    await page.locator('[data-single-stock-backtest]').waitFor();
    assert.equal(await page.getByRole('button',{name:'从所选日期开始回测',exact:true}).isVisible(),true);
    await openView(page,'news','资讯中心');
    for(const label of ['市场资讯','公司公告','全部']) {
      const tab=page.getByRole('tab',{name:label,exact:true}); await tab.click();
      assert.equal(await tab.getAttribute('aria-selected'),'true');
    }
    await page.locator('.realtime-news-card').first().waitFor();
    const count=await page.locator('.realtime-news-card').count();
    const newsQuery=page.getByPlaceholder('搜索股票、板块、事件关键词');
    await newsQuery.fill('不存在的界面检查关键词');
    await page.getByRole('heading',{name:'当前范围暂无匹配资讯',exact:true}).waitFor();
    assert.equal(await page.locator('.realtime-news-card').count(),0);
    await newsQuery.fill('');
    await page.locator('.realtime-news-card').first().waitFor();
    assert.equal(await page.locator('.realtime-news-card').count(),count);
    await page.getByRole('button',{name:'正向',exact:true}).click();
    assert.match(await page.getByRole('button',{name:'正向',exact:true}).getAttribute('class'),/active/);
    assert.equal(await page.locator('.realtime-news-card:not(.positive)').count(),0);
    await openView(page,'settings','数据源设置');
    const token=page.getByPlaceholder('从同花顺超级命令或账号详情获取');
    await token.fill('QA-DRAFT-NOT-A-REAL-TOKEN');
    for(const [id,label]of [['monitoring','监控与提醒'],['execution','执行参数'],['strategies','策略组合'],['sources','行情连接']]) {
      const category=page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:label,exact:true});
      await category.click();
      assert.equal(await category.getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('.settings-card:visible').count(),1);
      assert.equal(await page.locator(`#settings-${id}`).isVisible(),true);
    }
    assert.equal(await token.inputValue(),'QA-DRAFT-NOT-A-REAL-TOKEN','unsaved connection form survives all category switches');
    await page.getByRole('button',{name:'保存设置',exact:true}).click();
    await page.getByRole('button',{name:'保存设置',exact:true}).waitFor();
    assert.equal(await page.evaluate(async()=>(await window.stockApi.getSettings()).refreshToken),'QA-DRAFT-NOT-A-REAL-TOKEN');
  }));
});
