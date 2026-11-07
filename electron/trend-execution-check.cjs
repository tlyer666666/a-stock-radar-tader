'use strict';
const { createTradingCalendar, shanghaiClock, validDate } = require('./trend-trading-calendar.cjs');
const { isBseAshareCode } = require('./price-limit-rules.cjs');
const finitePositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
function sourceTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).getTime();
  if (typeof value !== 'string') return NaN;
  if (/^\d{14}$/.test(value)) value = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(8,10)}:${value.slice(10,12)}:${value.slice(12,14)}+08:00`;
  // A date without a timezone is not an auditable quote timestamp.
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
}
function createTrendExecutionChecker({ fetchQuote, now = () => new Date(), calendar = createTradingCalendar() } = {}) {
  if (typeof fetchQuote !== 'function') throw new TypeError('交易前检查缺少行情读取器');
  return async function check({ security, signalDate } = {}) {
    const code=String(security?.code || ''), secid=String(security?.secid || '');
    const main=/^(?:000|001|002|003|600|601|603|605)\d{3}$/.test(code), star=/^(?:688|689)\d{3}$/.test(code), growth=/^(?:300|301|302)\d{3}$/.test(code), beijing=isBseAshareCode(code);
    const expectedSecid=`${/^(?:600|601|603|605|688|689)/.test(code)?1:0}.${code}`;
    if (!security || !(main||star||growth||beijing) || secid!==expectedSecid || !validDate(signalDate)) throw new TypeError('证券标识或信号日期无效');
    const current=()=>new Date(now()), first=current(), window=calendar.executionWindow(signalDate,first);
    const base={ checkedAt:first.toISOString(), signalDate, executionDate:window.executionDate, expectedSignalDate:window.expectedSignalDate,
      state:window.state, reasons:[window.reason], latest:null,upperLimit:null,lowerLimit:null,suspended:null,priceDate:null,source:'',
      minimumBuyQuantity:star?200:100,quantityStep:star||beijing?1:100,validUntil:window.validUntil };
    if(window.state!=='ready')return base;
    let quote;
    try { const input=await fetchQuote(security);quote=input?.quote||input; }
    catch(error){ return {...base,checkedAt:current().toISOString(),state:'unknown',reasons:[`交易前行情读取失败：${error instanceof Error?error.message:String(error)}`]}; }
    const checked=current(), finalWindow=calendar.executionWindow(signalDate,checked);
    if(finalWindow.state!=='ready')return {...base,...finalWindow,checkedAt:checked.toISOString(),reasons:[finalWindow.reason]};
    const quoteEpoch=sourceTime(quote?.quoteAt ?? quote?.updatedAt), age=checked.getTime()-quoteEpoch;
    const priceDate=Number.isFinite(quoteEpoch)?shanghaiClock(new Date(quoteEpoch)).date:null;
    const suspended=typeof quote?.suspended==='boolean'?quote.suspended:null;
    const latest=finitePositive(quote?.latest)?quote.latest:null;
    const upperLimit=finitePositive(quote?.limitUp ?? quote?.upperLimit)?(quote.limitUp ?? quote.upperLimit):null;
    const lowerLimit=finitePositive(quote?.limitDown ?? quote?.lowerLimit)?(quote.limitDown ?? quote.lowerLimit):null;
    const reasons=[];
    if(String(quote?.code||'')!==code || (quote?.secid && quote.secid!==secid))reasons.push('返回行情证券身份与请求不一致');
    if(!Number.isFinite(quoteEpoch)||age<0||age>60000||priceDate!==window.executionDate)reasons.push('缺少当日60秒内的源端报价时间，不能用请求时间代替');
    if(latest===null||upperLimit===null||lowerLimit===null||lowerLimit>=upperLimit||(latest!==null&&upperLimit!==null&&latest>upperLimit+.005)||(latest!==null&&lowerLimit!==null&&latest<lowerLimit-.005))reasons.push('实际价格或源端涨跌停价缺失/冲突');
    if(suspended===null)reasons.push('行情源未明确提供当前停牌状态，需接入可确认交易状态的数据');
    let state=reasons.length?'unknown':'ready';
    if(suspended===true || /ST|退市|退$/i.test(String(quote?.name||security.name||''))) {state='blocked';reasons.push('当前停牌或风险警示/退市状态不满足开仓条件');}
    if(latest!==null&&upperLimit!==null&&latest>=upperLimit-.005){state='blocked';reasons.push('当前报价处于涨停价格，不据此假设能够成交');}
    if(!reasons.length)reasons.push('报价、源端限价与交易状态检查通过；仍须核对账户权限、公告及公司行为');
    const validUntil=Number.isFinite(quoteEpoch)?new Date(Math.min(quoteEpoch+60000,Date.parse(window.validUntil))).toISOString():null;
    return {...base,checkedAt:checked.toISOString(),state,reasons,latest,upperLimit,lowerLimit,suspended,priceDate,source:String(quote?.source||'未标明行情来源'),validUntil,
      ...(Number.isFinite(quoteEpoch)?{quoteAt:new Date(quoteEpoch).toISOString()}:{})};
  };
}
module.exports={createTrendExecutionChecker,sourceTime};
