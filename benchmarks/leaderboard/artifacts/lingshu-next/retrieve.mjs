import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here=fileURLToPath(new URL('.',import.meta.url));
const [dataset, memoryModule, resultPath, startArg='1', stopArg='500']=process.argv.slice(2);
assert.ok(dataset&&memoryModule&&resultPath,'Usage: node retrieve.mjs DATASET NEXT_MEMORY_MODULE OUTPUT [START STOP]');
const start=Number(startArg), stop=Number(stopArg);
assert.ok(Number.isInteger(start)&&Number.isInteger(stop)&&start>=1&&stop<=500&&start<=stop);
const { MemoryStore }=await import(pathToFileURL(path.resolve(memoryModule)).href);
const sha=value=>createHash('sha256').update(value).digest('hex');
const identity=(...fields)=>sha(JSON.stringify(fields)).slice(0,32);
const k=20;
const maxChars=24000;
const input=spawn('python',['-s',path.join(here,'project-data.py'),'product',path.resolve(dataset)],{windowsHide:true,stdio:['ignore','pipe','ignore']});
const getExit=new Promise((resolve,reject)=>{input.once('error',reject);input.once('close',resolve);});
const results=fs.openSync(resultPath,'wx');
const stream=createInterface({input:input.stdout,crlfDelay:Infinity});
let count=0, observed=0;
try {
  for await(const raw of stream){
    const item=JSON.parse(raw);
    observed++;
    assert.equal(item.ordinal,observed,'TRACK_A_CASE_ORDER_CHANGED');
    if(item.ordinal<start||item.ordinal>stop)continue;
    const workspaceId=identity('next-public-track-a',item.ordinal);
    const store=new MemoryStore(':memory:');
    try {
      const ingestStart=performance.now();
      store.setMemoryEnabled(workspaceId,true);
      const sessionMapping=new Map();
      const histories=item.histories.sort((a,b)=>a.at-b.at||a.ordinal-b.ordinal);
      assert.ok(histories.length>k,'TRACK_A_TOP_K_NOT_SMALLER_THAN_CORPUS');
      const historyDigest=createHash('sha256');
      let messageCount=0;
      for(const history of histories){
        const id=identity(workspaceId,history.ordinal);
        const messages=history.messages.map(([role,text],index)=>({id:identity(id,index),role,text,at:history.at}));
        const session={id,workspaceId,updatedAt:history.at,messages};
        const stored=store.importSession(session);
        assert.equal(stored.messageCount,messages.length);
        sessionMapping.set(id,history.ordinal);
        messageCount+=messages.length;
        historyDigest.update(JSON.stringify(session));
      }
      assert.equal(store.listSessions(workspaceId).length,histories.length);
      const indexMs=performance.now()-ingestStart;
      const searchStart=performance.now();
      const retrieval=store.retrieve({workspaceId,question:item.question,maxChars});
      const retrievalMs=performance.now()-searchStart;
      const rankedSessionOrdinals=[];
      const rankedSeen=new Set();
      for(const result of retrieval.sources){
        const ordinal=sessionMapping.get(result.sessionId);
        assert.ok(Number.isInteger(ordinal),'TRACK_A_RETURNED_UNIMPORTED_SOURCE');
        if(rankedSeen.has(ordinal))continue;
        rankedSeen.add(ordinal);
        rankedSessionOrdinals.push(ordinal);
        if(rankedSessionOrdinals.length===k)break;
      }
      const row={ordinal:item.ordinal,sessionCount:histories.length,messageCount,rankedSessionOrdinals,
        normalNextSourceCount:retrieval.sources.length,queryDigest:sha(item.question),historyDigest:historyDigest.digest('hex'),
        elapsedIndexMs:indexMs,elapsedRetrievalMs:retrievalMs};
      fs.writeSync(results,JSON.stringify(row)+'\n');
      count++;
      if(count%50===0)console.log(JSON.stringify({casesCompleted:count,ordinal:item.ordinal,modelsCalled:0}));
    } finally {store.close();}
  }
  assert.equal(await getExit,0,'TRACK_A_INPUT_PROJECTION_FAILED');
  assert.equal(observed,500);
  assert.equal(count,stop-start+1);
} finally {fs.closeSync(results);}
console.log(JSON.stringify({count,observed,output:resultPath,modelsCalled:0}));
