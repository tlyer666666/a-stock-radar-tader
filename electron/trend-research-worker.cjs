'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {evaluateTrendStrategies}=require('./trend-strategy-evaluator.cjs');
const {validateTrendResearchRequest}=require('./trend-research-request.cjs');
try{parentPort.postMessage({ok:true,value:evaluateTrendStrategies(validateTrendResearchRequest(workerData))});}
catch(error){parentPort.postMessage({ok:false,error:error instanceof Error?error.message:String(error)});}
