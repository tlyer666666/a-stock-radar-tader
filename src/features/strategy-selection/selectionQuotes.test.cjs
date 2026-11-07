'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {registerTypeScript}=require('../../../qa/register-typescript.cjs');
let restore,data;
before(()=>{restore=registerTypeScript();data=require('./selectionQuoteData.ts');});
after(()=>restore?.());
const security={code:'600501',secid:'1.600501',name:'航天晨光',assetType:'stock'};
const sample=(patch={})=>({quote:{code:'600501',latest:16.12,changePct:-2.18,turnover:6.865,amount:483313100,quoteAt:'2026-10-26T07:14:00Z',missingFields:[],...patch},actualProvider:'ths_free',updatedAt:'2026-10-26T07:14:23Z'});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('snapshot normalization exposes actual turnover and keeps missing fields distinct from zero',()=>{
 const quote=data.normalizeSelectionQuote(security,sample());
 assert.equal(quote.turnover,6.865);assert.equal(quote.amount,483313100);assert.equal(quote.latest,16.12);
 assert.equal(quote.source,'同花顺免费行情');assert.equal(quote.quoteAt,'2026-10-26T07:14:00.000Z');
 const zero=data.normalizeSelectionQuote(security,sample({turnover:0,amount:0,changePct:0}));
 assert.equal(zero.turnover,0);assert.equal(zero.amount,0);assert.equal(zero.changePct,0);
 for(const value of [null,undefined,'',' ',false,'-',Infinity,-1]){
  const result=data.normalizeSelectionQuote(security,sample({turnover:value,amount:value}));
  assert.equal(result.turnover,null);assert.equal(result.amount,null);
 }
 const marked=data.normalizeSelectionQuote(security,sample({turnover:0,amount:0,missingFields:['turnover','amount']}));
 assert.equal(marked.turnover,null);assert.equal(marked.amount,null);
});

test('a quote for another security or without a valid latest price is rejected',()=>{
 assert.throws(()=>data.normalizeSelectionQuote(security,sample({code:'000887'})),/代码/);
 for(const value of [null,'',0,-1,'invalid'])assert.throws(()=>data.normalizeSelectionQuote(security,sample({latest:value})),/最新价/);
 const noTime=data.normalizeSelectionQuote(security,sample({quoteAt:''}));
 assert.equal(noTime.quoteAt,'');assert.equal(noTime.fetchedAt,'2026-10-26T07:14:23.000Z');
});

test('quote feed bounds in-flight calls, deduplicates a shared stock, and drops detached queued work',async()=>{
 const requests=[],pending=[];
 const feed=data.createSelectionQuoteFeed({fetchQuote:item=>{requests.push(item.code);const next=deferred();pending.push(next);return next.promise;}});
 const stop=[];let first,shared;
 stop.push(feed.subscribe(security,(q)=>{first=q;}));
 stop.push(feed.subscribe(security,(q)=>{shared=q;}));
 for(const code of ['600002','600003','600004'])stop.push(feed.subscribe({...security,code,secid:`1.${code}`},()=>{}));
 assert.deepEqual(requests,['600501','600002','600003']);
 stop.at(-1)();pending[0].resolve(sample());await flush();
 assert.equal(first.turnover,6.865);assert.equal(shared.turnover,6.865);
 assert.deepEqual(requests,['600501','600002','600003'],'detached fourth quote is never sent');
 stop.forEach(fn=>fn());pending[1].resolve(sample({code:'600002'}));pending[2].resolve(sample({code:'600003'}));await flush();
});

test('cached quotes expire and a failed refresh leaves the cache recoverable without inventing new data',async()=>{
 let now=1000,calls=0;const jobs=[];
 const feed=data.createSelectionQuoteFeed({now:()=>now,fetchQuote:()=>{calls++;const d=deferred();jobs.push(d);return d.promise;}});
 let observed,error;
 feed.subscribe(security,(q,e)=>{observed=q;error=e;});jobs[0].resolve(sample());await flush();
 assert.equal(observed.turnover,6.865);
 feed.subscribe(security,q=>{observed=q;});assert.equal(calls,1);
 now+=16000;feed.subscribe(security,(q,e)=>{observed=q;error=e;});jobs[1].reject(Error('network down'));await flush();
 assert.equal(error,'行情更新失败，请稍后重试');
 let old;const stop=feed.subscribe(security,q=>{old=q;});assert.equal(calls,3);stop();jobs[2].resolve(sample());await flush();assert.equal(old,undefined,'unsubscribed views cannot receive late results');
});

test('a timestamp rollback is rejected instead of replacing a newer quote',async()=>{
 const jobs=[];const feed=data.createSelectionQuoteFeed({fetchQuote:()=>{const d=deferred();jobs.push(d);return d.promise;}});
 let initial,old,error;feed.subscribe(security,q=>{initial=q;});jobs[0].resolve(sample());await flush();
 feed.subscribe(security,(q,e)=>{old=q;error=e;},true);jobs[1].resolve(sample({latest:15,quoteAt:'2026-10-23T07:00:00Z'}));await flush();
 assert.equal(initial.latest,16.12);assert.equal(old,null);assert.match(error,/时间倒退/);
 let cached;feed.subscribe(security,q=>{cached=q;});assert.equal(cached.latest,16.12);
});

test('quote cache evicts old securities instead of growing without bound',async()=>{
 let calls=0;const feed=data.createSelectionQuoteFeed({fetchQuote:async item=>{calls++;return sample({code:item.code});}});
 for(let i=0;i<101;i++){const code=String(600100+i);feed.subscribe({...security,code,secid:`1.${code}`},()=>{});await flush();}
 feed.subscribe({...security,code:'600100',secid:'1.600100'},()=>{});await flush();assert.equal(calls,102);
});

function mountQuotes(t,{securities=[security],live=true,fetchQuote=async()=>sample(),hidden=false,clock}={}){
 const {createHookHarness}=require('../../../qa/research-hook-harness.cjs');
 const originalWindow=global.window,originalDocument=global.document;
 const timers=new Map(),events=new Map();let id=0,calls=0;
 global.window={stockApi:{getQuoteSnapshot:item=>{calls++;return fetchQuote(item);}},setInterval:(fn,ms)=>{const timer=clock?clock.setInterval(fn,ms):++id;timers.set(timer,fn);return timer;},clearInterval:timer=>{timers.delete(timer);clock?.clearInterval(timer);}};
 global.document={hidden,addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:(name,fn)=>{if(events.get(name)===fn)events.delete(name);}};
 const props={securities,live,refreshSeconds:15};
 // A fresh singleton captures this fixture's virtual Date.now, just as it does
 // when the application starts. Keep other tests' module instances intact.
 const modulePaths=clock?['./useSelectionQuotes.ts','./selectionQuoteData.ts'].map(name=>require.resolve(name)):[];
 const cachedModules=modulePaths.map(name=>require.cache[name]);modulePaths.forEach(name=>delete require.cache[name]);
 const hook=require('./useSelectionQuotes.ts').useSelectionQuotes;
 modulePaths.forEach((name,index)=>{if(cachedModules[index])require.cache[name]=cachedModules[index];else delete require.cache[name];});
 const harness=createHookHarness(input=>hook(input.securities,input.live,input.refreshSeconds),{props});
 t.after(()=>{harness.dispose();global.window=originalWindow;global.document=originalDocument;});
 return Object.assign(harness,{props,timers,events,calls:()=>calls});
}

test('visible-page quotes refresh independently, retain last successful data on failure, and release the timer',async t=>{
 let fail=false;const local={...security,code:'600502',secid:'1.600502'};
 const h=mountQuotes(t,{securities:[local],fetchQuote:async()=>{if(fail)throw Error('network');return sample({code:'600502'});}});
 h.render();await h.flush();assert.equal(h.tree.entries['600502'].quote.turnover,6.865);assert.equal(h.tree.loading,false);assert.equal(h.timers.size,1);
 fail=true;h.tree.refresh();h.render();await h.flush();
 assert.equal(h.tree.entries['600502'].quote.latest,16.12);assert.equal(h.tree.entries['600502'].error,'行情更新失败，请稍后重试');
 h.dispose();assert.equal(h.timers.size,0);assert.equal(h.events.size,0);
});

test('hidden pages make no initial or interval calls and resume once visible; paused live mode has no interval',async t=>{
 const local={...security,code:'600503',secid:'1.600503'};
 const h=mountQuotes(t,{securities:[local],hidden:true,fetchQuote:async()=>sample({code:'600503'})});h.render();await h.flush();assert.equal(h.calls(),0);
 for(const tick of h.timers.values())tick();assert.equal(h.calls(),0);
 global.document.hidden=false;h.events.get('visibilitychange')();await h.flush();assert.equal(h.calls(),1);assert.equal(h.tree.entries['600503'].quote.turnover,6.865);
 h.props.live=false;h.render();await h.flush();assert.equal(h.timers.size,0);
});

test('changing pages cannot render the previous page quote and detaching drops unsent rows',async t=>{
 const pending=[];const securities=Array.from({length:20},(_,i)=>({...security,code:String(601100+i),secid:`1.${601100+i}`}));
 const h=mountQuotes(t,{securities,fetchQuote:item=>{const d=deferred();pending.push({item,...d});return d.promise;}});
 h.render();assert.equal(h.calls(),3);
 h.props.securities=[];h.render();assert.deepEqual(h.tree.entries,{});
 for(const job of pending)job.resolve(sample({code:job.item.code}));await h.flush();assert.equal(h.calls(),3);assert.deepEqual(h.tree.entries,{});
});

test('quote cells show live values and source time without replacing the selection close; failures stay explicit',()=>{
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
 const {SelectionQuotePrice,SelectionQuoteLiquidity}=require('./SelectionQuoteCells.tsx');
 const entry={quote:data.normalizeSelectionQuote(security,sample()),error:''};
 const html=renderToStaticMarkup(React.createElement(SelectionQuotePrice,{entry,selectionClose:16.48}));
 assert.match(html,/>16\.12<\/b>/);assert.match(html,/-2\.18%/);assert.match(html,/选股收盘 16\.48/);assert.match(html,/同花顺免费行情/);assert.match(html,/15:14:00/);assert.doesNotMatch(html,/15:14:23/,'fetch time is not passed off as market quote time');
 const liquidity=renderToStaticMarkup(React.createElement(SelectionQuoteLiquidity,{entry}));assert.match(liquidity,/6\.87%/);assert.match(liquidity,/4\.83 亿/);
 const failed=renderToStaticMarkup(React.createElement(SelectionQuotePrice,{entry:{...entry,error:'行情更新失败，请稍后重试'},selectionClose:16.48}));assert.match(failed,/上次行情/);assert.match(failed,/更新失败/);
 const missing=renderToStaticMarkup(React.createElement(SelectionQuoteLiquidity,{entry:{quote:data.normalizeSelectionQuote(security,sample({turnover:null})),error:''}}));assert.match(missing,/换手 暂缺/);assert.equal((missing.match(/暂缺/g)||[]).length,1,'the gap is stated once, in place');assert.doesNotMatch(missing,/0\.00%/);
});

test('a paused page first opened in the background still loads once when it first becomes visible',async t=>{
 const local={...security,code:'600504',secid:'1.600504'};
 const h=mountQuotes(t,{securities:[local],live:false,hidden:true,fetchQuote:async()=>sample({code:'600504'})});
 h.render();assert.equal(h.calls(),0);global.document.hidden=false;h.events.get('visibilitychange')();await h.flush();
 assert.equal(h.tree.entries['600504'].quote.turnover,6.865);assert.equal(h.calls(),1);assert.equal(h.timers.size,0);
 h.events.get('visibilitychange')();await h.flush();assert.equal(h.calls(),1);
});

test('queued quotes stop when hidden and can resume without releasing occupied slots early',async()=>{
 let visible=true;const jobs=[];
 const feed=data.createSelectionQuoteFeed({isVisible:()=>visible,fetchQuote:item=>{const d=deferred();jobs.push({item,...d});return d.promise;}});
 const stops=[];for(let i=0;i<5;i++)stops.push(feed.subscribe({...security,code:String(602100+i),secid:`1.${602100+i}`},()=>{}));
 assert.equal(jobs.length,3);visible=false;
 jobs[0].resolve(sample({code:jobs[0].item.code}));await flush();assert.equal(jobs.length,3);
 visible=true;feed.resume();assert.equal(jobs.length,4);feed.resume();assert.equal(jobs.length,4,'the two original in-flight slots stay occupied');
 stops.forEach(stop=>stop());for(const job of jobs.slice(1))job.resolve(sample({code:job.item.code}));await flush();
});

test('pausing realtime during an unfinished page read preserves the request and restores the refresh control',async t=>{
 const pending=[];const securities=Array.from({length:4},(_,i)=>({...security,code:String(603100+i),secid:`1.${603100+i}`}));
 const h=mountQuotes(t,{securities,fetchQuote:item=>{const d=deferred();pending.push({item,...d});return d.promise;}});
 h.render();assert.equal(h.calls(),3);h.props.live=false;h.render();assert.equal(h.timers.size,0);
 for(const job of pending.slice(0,3))job.resolve(sample({code:job.item.code}));await h.flush();
 assert.equal(h.calls(),4,'the already requested page completes while automatic polling is paused');
 pending[3].resolve(sample({code:pending[3].item.code}));await h.flush();
 assert.equal(h.tree.loading,false);assert.equal(Object.keys(h.tree.entries).length,4);
 h.tree.refresh();h.render();assert.equal(h.calls(),7,'manual refresh remains available after pausing');
 h.dispose();for(const job of pending.slice(4))job.resolve(sample({code:job.item.code}));await flush();
});

// The real hook/feed still own all scheduling decisions. Only elapsed time and
// the external IPC promise are virtual, so multi-minute races run offline.
function virtualClock(){
 const original={setTimeout:global.setTimeout,clearTimeout:global.clearTimeout,now:Date.now};
 let now=0,id=0;const scheduled=new Map();
 const schedule=(fn,ms,repeat=0)=>{const timer=++id;scheduled.set(timer,{at:now+ms,fn,repeat});return timer;};
 global.setTimeout=(fn,ms)=>schedule(fn,ms);global.clearTimeout=timer=>scheduled.delete(timer);Date.now=()=>now;
 return {now:()=>now,setInterval:(fn,ms)=>schedule(fn,ms,ms),clearInterval:timer=>scheduled.delete(timer),
  async advance(to){
   while(true){let at=Infinity,timer;for(const [key,job]of scheduled)if(job.at<at){at=job.at;timer=key;}
    if(at>to)break;now=at;const job=scheduled.get(timer);if(job.repeat)job.at+=job.repeat;else scheduled.delete(timer);
    job.fn();await flush();
   }now=to;await flush();
  },restore(){Object.assign(global,{setTimeout:original.setTimeout,clearTimeout:original.clearTimeout});Date.now=original.now;}
 };
}

test('15-second polling lets every row of a 20-stock page finish with 8-second quotes before starting another round',async t=>{
 const clock=virtualClock(),requested=[];
 const securities=Array.from({length:20},(_,i)=>({...security,code:String(604100+i),secid:`1.${604100+i}`}));
 const h=mountQuotes(t,{securities,clock,fetchQuote:item=>{
  requested.push(item.code);return new Promise(resolve=>setTimeout(()=>resolve(sample({code:item.code})),8000));
 }});
 try{
  h.render();await clock.advance(56000);h.render();
  assert.deepEqual(Object.keys(h.tree.entries).sort(),securities.map(item=>item.code),'the last five rows must not starve');
  assert.equal(h.tree.loading,false,'manual refresh is available when the complete page has finished');
  assert.equal(requested.length,20,'a pending page is not restarted on interval ticks');
  await clock.advance(300000);h.render();
  assert.equal(Object.keys(h.tree.entries).length,20);
 }finally{h.dispose();await clock.advance(400000);clock.restore();}
});

test('10-second feedback does not free a quote slot before its 25-second IPC promise physically settles',async()=>{
 const clock=virtualClock();let active=0,peak=0;const requested=[],observed=[],stops=[];
 const feed=data.createSelectionQuoteFeed({now:clock.now,isVisible:()=>true,fetchQuote:item=>{
  requested.push(item.code);active++;peak=Math.max(peak,active);
  return new Promise(resolve=>setTimeout(()=>{active--;resolve(sample({code:item.code}));},25000));
 }});
 try{
  for(let i=0;i<12;i++)stops.push(feed.subscribe({...security,code:String(604300+i),secid:`1.${604300+i}`},(quote,error)=>observed.push({quote,error,at:clock.now()})));
  await clock.advance(10000);
  assert.equal(observed.length,3);assert.ok(observed.every(item=>item.at===10000&&/超时/.test(item.error)),'timeout remains prompt');
  assert.equal(requested.length,3,'timed-out IPC promises still occupy all three physical slots');
  let retry;stops.push(feed.subscribe({...security,code:'604300',secid:'1.604300'},(quote,error)=>{retry={quote,error};},true));
  assert.match(retry.error,/超时/,'a refresh joining a draining task receives its completed logical result');
  await clock.advance(100000);
  assert.equal(peak,3);assert.equal(active,0);assert.equal(requested.length,12);
  assert.equal(observed.length,12,'late physical results cannot replace timeout feedback or notify twice');
 }finally{stops.forEach(stop=>stop());await clock.advance(200000);clock.restore();}
});

test('unmounting during timeout drain discards unsent rows and cleans polling and visibility handlers',async t=>{
 const clock=virtualClock(),requested=[];
 const securities=Array.from({length:20},(_,i)=>({...security,code:String(604500+i),secid:`1.${604500+i}`}));
 const h=mountQuotes(t,{securities,clock,fetchQuote:item=>{
  requested.push(item.code);return new Promise(resolve=>setTimeout(()=>resolve(sample({code:item.code})),25000));
 }});
 try{
  h.render();await clock.advance(10000);h.render();h.props.live=false;h.render();
  assert.equal(h.timers.size,0);
  global.document.hidden=true;h.events.get('visibilitychange')();
  h.dispose();await clock.advance(50000);
  assert.equal(requested.length,3);assert.equal(h.events.size,0);assert.equal(h.timers.size,0);
 }finally{h.dispose();await clock.advance(100000);clock.restore();}
});

test('provider response timestamps are not rendered as security quote times', () => {
  const raw = { ...sample({ quoteAt: '2026-10-31T06:00:00Z' }), actualProvider: 'fuyao', updatedAt: '2026-10-31T06:00:02Z' };
  const q = data.normalizeSelectionQuote(security, raw);
  assert.equal(q.quoteAt, ''); assert.equal(q.fetchedAt, '2026-10-31T06:00:02.000Z');
  const React = require('react'), {renderToStaticMarkup} = require('react-dom/server');
  const {SelectionQuotePrice} = require('./SelectionQuoteCells.tsx');
  const html = renderToStaticMarkup(React.createElement(SelectionQuotePrice, {entry:{quote:q,error:''}}));
  assert.match(html, /获取/); assert.match(html, /源未提供行情时间/);
  assert.equal(data.normalizeSelectionQuote(security, {...raw, quote:{...raw.quote,quoteAtIsTradeTime:true}}).quoteAt,'2026-10-31T06:00:00.000Z');
  assert.equal(data.normalizeSelectionQuote(security,sample({quoteAtIsTradeTime:false})).quoteAt,'');
});

test('a weekend Fuyao response clock cannot block fallback with a real Friday quote time', async () => {
  const responses = [{ ...sample({ quoteAt:'2026-10-31T06:00:00Z' }), actualProvider:'fuyao' }, sample({ latest:17, quoteAt:'2026-10-30T07:00:00Z' })];
  const feed = data.createSelectionQuoteFeed({ fetchQuote:async()=>responses.shift() });
  let result,error;
  feed.subscribe(security,(q,e)=>{result=q;error=e;}); await flush();
  feed.subscribe(security,(q,e)=>{result=q;error=e;},true); await flush();
  assert.equal(error,''); assert.equal(result.latest,17); assert.equal(result.quoteAt,'2026-10-30T07:00:00.000Z');
});

test('an unknown quote time preserves the last known trade time until its cache entry is evicted', async () => {
  const responses = [sample({ quoteAt:'2026-10-30T07:00:00Z' }),
    {...sample({latest:17,quoteAt:'2026-10-31T06:00:00Z'}),actualProvider:'fuyao'},
    sample({latest:15,quoteAt:'2026-10-30T06:00:00Z'}),
    sample({latest:18,quoteAt:'2026-11-02T02:00:00Z'})];
  const feed = data.createSelectionQuoteFeed({fetchQuote:async item=>responses.shift() || sample({code:item.code})});
  let result,error;
  const read = async (item=security,force=true) => { feed.subscribe(item,(q,e)=>{result=q;error=e;},force); await flush(); };
  await read(); await read();
  assert.equal(result.latest,17); assert.equal(result.quoteAt,'');
  await read(); assert.equal(result,null); assert.match(error,/时间倒退/);
  await read(security,false); assert.equal(result.latest,17); assert.equal(result.quoteAt,'');
  await read(); assert.equal(result.latest,18); assert.equal(error,'');
  for(let i=0;i<100;i++) { const code=String(600100+i); await read({...security,code,secid:`1.${code}`}); }
  await read();
  assert.equal(error,''); assert.equal(result.latest,16.12,'eviction removes the timestamp watermark with the quote');
});
