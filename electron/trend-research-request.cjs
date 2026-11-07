'use strict';
function validateTrendResearchRequest(input) {
  const allowed=['requestId','dataset','from','to','splitDate','advancedStrategyId','advancedConfig','execution','account'];
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))throw new TypeError('研究参数对象无效或包含未知参数');
  const {requestId:_requestId,...request}=input;
  const json=JSON.stringify(request);
  if(Buffer.byteLength(json,'utf8')>16*1024*1024)throw new TypeError('研究数据超过16MiB，请分批评估或使用离线研究工具');
  const dataset=request.dataset;
  if(!dataset||!Array.isArray(dataset.calendar)||!Array.isArray(dataset.securities))throw new TypeError('研究数据须包含calendar与securities');
  if(dataset.securities.length>300)throw new TypeError('桌面研究每批最多300只证券');
  if(dataset.calendar.length>5000)throw new TypeError('桌面研究最多5000个历史日期');
  let rows=0;
  for(const security of dataset.securities)rows+=(security?.rawRows?.length||0)+(security?.adjustedRows?.length||0);
  if(rows>250000)throw new TypeError('桌面研究最多250000根原始及复权日线');
  if(dataset.calendar.filter(date=>date>=request.from&&date<=request.to).length>1500)throw new TypeError('桌面单轮研究最多1500个评估交易日');
  return request;
}
module.exports={validateTrendResearchRequest};
