'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const views = [
  ['trend-screener', '涨停趋势'], ['signals', '策略信号'], ['sectors', '板块强度'],
  ['dashboard', '涨停监控'], ['watchlist', '观察池'], ['favorites', '自选板块'],
  ['holdings', '持仓股'], ['review', '专业复盘'], ['compare', '多股同列'],
  ['backtest', '回测中心'], ['news', '资讯中心'], ['settings', '数据源设置']
];

async function createPreview() {
  const { createServer } = await import('vite');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
    import { createPreviewApi } from '/src/previewApi.ts';
    window.stockApi = createPreviewApi();
    const samples = await window.stockApi.search('');
    const now = new Date().toISOString();
    await window.stockApi.saveWatchlist(samples.map((security,index) => ({ ...security, createdAt: now, favorite: true, favoriteAddedAt: now, observationNode: 'T+' + (index + 1), tradingDaysSince: index + 1, limitDate: '2026-09-29', consecutiveBoards: 1 })));
    await window.stockApi.saveHoldings(samples.slice(0,2).map((security,index) => ({ ...security, shares: (index + 1) * 100, costPrice: index ? 220 : 1500, createdAt: now, updatedAt: now, note: '隔离预览样本' })));
    if (new URLSearchParams(location.search).has('populated')) {
      localStorage.setItem('a-stock-radar:compare-selection',JSON.stringify([...samples,{code:'688981',name:'中芯国际',secid:'1.688981',thscode:'688981.SH',assetType:'stock'},{code:'002371',name:'北方华创',secid:'0.002371',thscode:'002371.SZ',assetType:'stock'},{code:'603501',name:'韦尔股份',secid:'1.603501',thscode:'603501.SH',assetType:'stock'}]));
      const dates=['2026-09-29','2026-09-28','2026-09-25','2026-09-24','2026-09-23','2026-09-22','2026-09-21','2026-09-18','2026-09-17','2026-09-16'];
      window.stockApi.discoverRecentLimitUps=async()=>Array.from({length:398},(_,index)=>({code:String(600001+index),name:'观察样本'+String(index+1).padStart(3,'0'),secid:'1.'+(600001+index),thscode:(600001+index)+'.SH',assetType:'stock',limitDate:dates[index%10],tradingDaysSince:index%10+1,consecutiveBoards:index%9===0?2:1}));
      const getLimitUps=window.stockApi.discoverLimitUps.bind(window.stockApi);
      window.stockApi.discoverLimitUps=async(options)=>{const result=await getLimitUps(options);return {...result,rows:result.rows.map((row,index)=>({...row,consecutiveBoards:[7,4,3][index]}))};};
      const entries = ['半导体','新能源电池','汽车整车','电子元件','软件服务','通信设备','工业机械','电力设备','消费电子','医药制造','白酒','光伏设备','计算机应用','数字经济','机器人'].map((name,index) => ({ id: 'qa-sector-' + index, code: String(index), name, kind: 'industry', level: null, path: [], classification: '合成界面样本', sourceUrl: 'https://example.invalid/qa-sector-' + index }));
      const classification = {...entries.find(entry=>entry.name==='白酒'),id:'qa-classification-white-wine',kind:'classification',level:3,path:['食品饮料','白酒']};
      const coverage = { loaded: entries.length,total:entries.length,complete:true,scope:'隔离界面样本' };
      window.stockApi.getSectorCatalog = async () => ({status:'ready',entries,fetchedAt:now,asOf:null,sources:[],warnings:[],coverage});
      window.stockApi.getSectorClassifications = async () => ({status:'ready',entries:[classification],fetchedAt:now,asOf:null,sources:[],warnings:[],coverage:{...coverage,loaded:1,total:1}});
      window.stockApi.getSectorDetail = async request => ({status:'ready',entry:[...entries,classification].find(entry => entry.id === (request.entry?.id || request.id)) || entries[0],fetchedAt:now,asOf:'2026-09-30',reportDate:null,
        members:Array.from({length:36},(_,index)=>({...samples[index%samples.length],code:String(600001+index),name:'板块样本'+String(index+1).padStart(2,'0'),latest:25.4+index,changePercent:index%3 ? 2.67 : -1.23,turnover:2.8+index/10,amount:180000000+index*1500000})),
        coverage:{loaded:36,declared:36,excluded:0,invalid:0,pagesLoaded:1,pagesTotal:1,complete:true,scope:'隔离界面样本'},metrics:{changePercent:2.67,amount:1800000000,rising:24,falling:12},sources:[],warnings:[],evidence:[],relatedTerms:[]});
    }
    await import('/src/main.tsx');
  </script></body></html>`;
  const server = await createServer({
    plugins: [{ name: 'frontend-v150-preview', configureServer(vite) {
      vite.middlewares.use(async (request,response,next) => {
        if (request.url?.split('?')[0] !== '/__frontend_v150__') return next();
        try { response.setHeader('Content-Type','text/html'); response.end(await vite.transformIndexHtml(request.url,html)); }
        catch (error) { next(error); }
      });
    } }],
    server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error'
  });
  await server.listen();
  const browser = await require('playwright-core').chromium.launch({
    executablePath: process.env.QA_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true
  });
  return { server, browser, url: `http://127.0.0.1:${server.httpServer.address().port}/__frontend_v150__`,
    async close() { await browser.close(); await server.close(); } };
}

async function openView(page,id,label) {
  await page.getByRole('button',{ name: label, exact: true }).first().click();
  await page.locator(`.app-shell[data-workspace="${id}"]`).waitFor();
  await page.locator('.main > .page').waitFor();
  await page.locator('.main > .page').evaluate(el => { el.scrollTop = 0; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function theme(page,value) {
  await page.getByRole('button',{ name: value === 'light' ? '白天' : '黑夜', exact: true }).click();
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme,value);
}

async function geometry(page) {
  return page.evaluate(() => {
    const roots = ['html','body','.app-shell','.main','.main > .page'];
    return {
      viewport: {width:innerWidth,height:innerHeight},
      roots: roots.map(selector => { const el = document.querySelector(selector), box = el.getBoundingClientRect(); return {selector,width:el.clientWidth,scrollWidth:el.scrollWidth,left:box.left,right:box.right}; }),
      headings: [...document.querySelectorAll('.main h1,.main h2')].filter(el => el.getBoundingClientRect().height).map(el => el.textContent),
      active: document.querySelector('.app-shell').dataset.workspace,
      textLength: document.querySelector('.main > .page').innerText.length
    };
  });
}

async function capture(phase = 'before', widths = [1480], ids = views.map(view=>view[0]), populated = false) {
  const fixture = await createPreview();
  const output = path.resolve(__dirname,`../artifacts/frontend-v150/${phase}`);
  await fs.mkdir(output,{recursive:true});
  const page = await fixture.browser.newPage({viewport:{width:1480,height:960}});
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  const records = [];
  try {
    await page.goto(fixture.url+(populated?'?populated=1':''));
    await page.locator('.workspace-navigation').waitFor();
    for (const width of widths) {
      await page.setViewportSize({width,height:960});
      for (const [id,label] of views.filter(view=>ids.includes(view[0]))) {
        await openView(page,id,label);
        if(populated&&id==='sectors') {await page.locator('.sector-explorer-entry').first().click();await page.locator('.sector-explorer-detail').waitFor();}
        // Let the deterministic preview promises finish before recording page contents.
        await page.waitForTimeout(100);
        for (const appearance of ['light','dark']) {
          await theme(page,appearance);
          const filename = `${String(views.findIndex(view => view[0] === id) + 1).padStart(2,'0')}-${id}-${appearance}-${width}.png`;
          await page.screenshot({path:path.join(output,filename),fullPage:false,animations:'disabled'});
          records.push({id,label,theme:appearance,width,screenshot:filename,...await geometry(page)});
        }
      }
    }
    await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify({errors,records},null,2));
    process.stdout.write(JSON.stringify({output,screenshots:records.length,errors,overflow:records.filter(row => row.roots.some(root => root.scrollWidth > root.width + 2)).map(row => `${row.id}/${row.theme}/${row.width}`)},null,2)+'\n');
  } finally { await fixture.close(); }
}

module.exports = { views,createPreview,openView,theme,geometry,capture };
if (require.main === module) capture(process.argv[2] || 'before',process.argv[3] ? process.argv[3].split(',').map(Number) : [1480]).catch(error => { console.error(error);process.exitCode=1; });
