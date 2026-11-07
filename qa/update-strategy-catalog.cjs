'use strict';
const fs=require('node:fs'),path=require('node:path');
const {ALL_STRATEGY_DEFINITIONS:STRATEGY_DEFINITIONS}=require('../electron/strategy-signal-engine.cjs');
const catalog=STRATEGY_DEFINITIONS.map(({matches:_matches,reasons:_reasons,componentEvidence:_evidence,...metadata})=>metadata);
fs.writeFileSync(path.resolve(__dirname,'../config/strategy-signal-catalog.json'),JSON.stringify(catalog,null,2)+'\n');
console.log(`Updated ${catalog.length} strategy metadata entries; functions remain in the Electron engine.`);
