import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {installation,invoke} from './harness.mjs';
import {assemble,judge,judgePrompt,measurement,project,reader,readerFileSha256,judgeFileSha256,sha,validateData} from './prepare.mjs';

const [mode,dataset,directory,limitArg='500']=process.argv.slice(2);
const limit=Number(limitArg);
const concurrency=Number(process.env.DSH_BENCH_CONCURRENCY??'1');
assert.ok(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=4,'Invalid DSH_BENCH_CONCURRENCY');
assert.ok(['probe','run','resume'].includes(mode)&&dataset&&directory&&Number.isInteger(limit)&&limit>=1&&limit<=500,
  'Usage: node run.mjs probe|run|resume DATASET PRIVATE_OUTPUT [QUESTION_COUNT]');
const output=path.resolve(directory);
const install=await installation();
if(mode==='probe')await validateData(dataset);
const credentialStore=mode==='probe'?path.join(output,'probe-unused.yaml'):process.env.DSH_BENCH_ACCOUNT_STORE;
assert.ok(credentialStore && path.isAbsolute(credentialStore),'Set DSH_BENCH_ACCOUNT_STORE to your benchmark account store');
if(mode!=='probe')assert.ok(fs.statSync(credentialStore).isFile(),'SDK account store missing');
if(mode==='resume')assert.ok(fs.statSync(output).isDirectory(),'Private run folder missing');
else fs.mkdirSync(output);
const dir=name=>{const dest=path.join(output,name);fs.mkdirSync(dest,{recursive:true});return dest;};
const scratch=dir('sdk');
const snapshot=path.join(output,'dataset.snapshot');
const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const writeAtomic=(file,bytes)=>{
  const tmp=file+'.'+randomUUID()+'.tmp';
  fs.writeFileSync(tmp,bytes,{flag:'wx',flush:true});fs.renameSync(tmp,file);
};
const save=(file,obj)=>writeAtomic(file,JSON.stringify(obj)+'\n');

async function runPhase(view,worker) {
  let batch=[];
  const flush=async()=>{
    const results=await Promise.allSettled(batch.map(worker));
    batch=[];
    const failure=results.find(result=>result.status==='rejected');
    if(failure)throw failure.reason;
  };
  for await(const row of project(snapshot,view,limit)){
    batch.push(row);
    if(batch.length===concurrency)await flush();
  }
  if(batch.length)await flush();
}

async function call(phase,ordinal,model,system,prompt,maxTokens) {
  const parent=path.join(scratch,phase+'-'+ordinal);
  fs.mkdirSync(parent,{recursive:true});
  const unknown={status:'dispatch-unconfirmed',text:null,usage:null,elapsed:null};
  // The original runner recorded process startup, without recording provider dispatch separately.
  if(fs.existsSync(path.join(parent,'attempt.started')))return {...unknown,status:'legacy-dispatch-unconfirmed'};
  const attempts=fs.readdirSync(parent).filter(name=>/^attempt-[1-9]\d*$/.test(name));
  if(attempts.some(name=>fs.existsSync(path.join(parent,name,'dispatch'))))return unknown;
  for(let i=0;i<2;i++){
    const root=path.join(parent,'attempt-'+String(attempts.length+i+1));
    fs.mkdirSync(root);
    const mark=name=>fs.writeFileSync(path.join(root,name),'1',{flag:'wx',flush:true});
    mark('started');
    const begin=performance.now();
    try {
      const result=await invoke({install,root,model,system,prompt,maxTokens,credentialStore,mark});
      return {...result,status:'complete',elapsed:Math.round(performance.now()-begin)};
    } catch(error) {
      if(fs.existsSync(path.join(root,'dispatch'))){
        mark('unconfirmed');
        return {...unknown,elapsed:Math.round(performance.now()-begin)};
      }
      mark('pre-dispatch-failed');
      if(i===1)throw Error(phase+' startup failed twice before dispatch at ordinal '+ordinal+': '+error.message);
      await delay(1200);
    }
  }
}

function uninitialized() {
  return fs.readdirSync(output,{withFileTypes:true}).every(entry=>{
    if(entry.isDirectory())return ['sdk','answers-private','judge-rows'].includes(entry.name) &&
      fs.readdirSync(path.join(output,entry.name)).length===0;
    return entry.isFile() && (/^owner\.sqlite(?:-journal)?$/.test(entry.name) ||
      /^run-config\.json\.[0-9a-f-]{36}\.tmp$/.test(entry.name));
  });
}

async function freezeDataset() {
  if(fs.existsSync(snapshot)){
    assert.ok(fs.lstatSync(snapshot).isFile(),'Expected a private dataset snapshot');
    await validateData(snapshot);
    return;
  }
  const tmp=snapshot+'.'+randomUUID()+'.tmp';
  try {
    fs.copyFileSync(dataset,tmp,fs.constants.COPYFILE_EXCL);
    await validateData(tmp);
    fs.chmodSync(tmp,0o444);
    fs.renameSync(tmp,snapshot);
  } finally {
    if(fs.existsSync(tmp)){fs.chmodSync(tmp,0o600);fs.unlinkSync(tmp);}
  }
}

async function run() {
  const cfgFile=path.join(output,'run-config.json');
  const cfg={format:2,questions:limit,datasetSha256:measurement.dataset_sha256,
    productTreeSha256:measurement.product_tree_sha256,readerSystemSha256:sha(reader.system),
    readerPromptFileSha256:readerFileSha256,judgePromptFileSha256:judgeFileSha256,concurrency};
  if(fs.existsSync(cfgFile)){
    const stored=readJSON(cfgFile);
    // v2 originally omitted the complete reader-file digest. Only the original
    // published reader template can migrate a checkpoint with that field absent.
    if(!Object.hasOwn(stored,'readerPromptFileSha256')){
      stored.readerPromptFileSha256='646418a66dd8e9282ebd5c0f228336db7511fd57f130a98047770c62ef4901cf';
    }
    assert.deepEqual(stored,cfg,'Run configuration differs');
  } else if(mode==='resume' && !uninitialized()){
    const prior=path.join(output,'measurement.json');
    assert.ok(fs.existsSync(prior),'Unconfigured output contains prior or unknown work');
    const old=readJSON(prior);
    assert.equal(old.questions,limit);assert.equal(old.concurrency,concurrency);
    assert.equal(old.originalAccuracy,measurement.accuracy);
    assert.equal(readerFileSha256,'646418a66dd8e9282ebd5c0f228336db7511fd57f130a98047770c62ef4901cf');
    assert.equal(judgeFileSha256,'50d4f70a1a66ef13e0ee932b825adfb232a3b366cdc1684b6532db100eb10be1');
  }
  save(cfgFile,cfg);
  await freezeDataset();
  const seals=dir('answers-private');
  const receipts=dir('judge-rows');
  const records=new Map();

  const verified=[];
  let completed=false;
  try {
    await runPhase('product',async item=>{
      const {prompt,sourceCount,sessionCount,corpusCount}=assemble(item);
      const expected={reader_prompt_sha256:sha(prompt),reader_prompt_utf16:prompt.length,
        retrieval_source_count:sourceCount,retrieval_session_count:sessionCount,corpus_session_count:corpusCount};
      const file=path.join(seals,item.ordinal+'.json');
      let seal;
      if(fs.existsSync(file)){
        seal=readJSON(file);
        for(const [key,val] of Object.entries(expected))assert.equal(seal.meta[key],val,'Question identity changed');
        assert.equal(seal.text===null?null:sha(seal.text),seal.meta.hypothesis_sha256);
      } else {
        const reply=await call('reader',item.ordinal,'deepseek-flash',reader.system,prompt,2048);
        seal={text:reply.text,meta:{...expected,generation_status:reply.status,
          hypothesis_sha256:reply.text===null?null:sha(reply.text),reader_tokens:reply.usage?.totalTokens??null,
          reader_latency_ms:reply.elapsed}};
        save(file,seal);
      }
      records.set(item.ordinal,seal.meta);
    });
    assert.equal(records.size,limit);
    await validateData(snapshot);
    await runPhase('score',async row=>{
      const file=path.join(receipts,row.ordinal+'.json');
      const meta=records.get(row.ordinal);
      const base={run:1,ordinal:row.ordinal,question_id:row.questionId,task:row.task,
        abstention:row.questionId.includes('_abs'),generation_status:'complete',...meta};
      const {text:hypothesis}=readJSON(path.join(seals,row.ordinal+'.json'));
      assert.equal(hypothesis===null?null:sha(hypothesis),meta.hypothesis_sha256,'Reader seal changed before judging');
      const rubric=hypothesis===null?null:judgePrompt(row,hypothesis);
      const rubricHash=rubric===null?null:sha(rubric);
      const skip=rubric===null?'generation-unconfirmed':
        Buffer.byteLength(rubric)>8192?'skipped-rubric-limit':null;
      let result;
      if(fs.existsSync(file)){
        result=readJSON(file);
        for(const [key,val] of Object.entries(base))assert.equal(result[key],val);
        assert.equal(result.judge_rubric_sha256,rubricHash);
        const fields=[...Object.keys(base),'judge_status','verdict','judge_rubric_sha256','judge_latency_ms','judge_tokens'];
        assert.deepEqual(Object.keys(result).sort(),fields.sort(),'Unexpected judge receipt fields');
        if(skip){
          assert.equal(result.judge_status,skip);
          assert.equal(result.judge_tokens,null);
          assert.equal(result.judge_latency_ms,null);
        } else {
          assert.ok(['judged','invalid-verdict','dispatch-unconfirmed','legacy-dispatch-unconfirmed'].includes(result.judge_status));
        }
        if(result.judge_status==='judged')assert.ok(['yes','no'].includes(result.verdict));
        else assert.equal(result.verdict,null);
        for(const metric of [result.judge_tokens,result.judge_latency_ms]){
          assert.ok(metric===null || (Number.isSafeInteger(metric) && metric>=0));
        }
      } else {
        let status=skip,verdict=null,usage=null,latency=null;
        if(skip===null){
          const reply=await call('judge',row.ordinal,'deepseek-v4-pro',judge.system,rubric,64);
          const normalized=reply.text?.trim().toLowerCase();
          verdict=['yes','no'].includes(normalized)?normalized:null;
          status=reply.status==='complete'?(verdict?'judged':'invalid-verdict'):reply.status;
          usage=reply.usage?.totalTokens??null;latency=reply.elapsed;
        }
        result={...base,judge_status:status,verdict,judge_rubric_sha256:rubricHash,judge_latency_ms:latency,judge_tokens:usage};
        save(file,result);
      }
      verified.push(result);
    });
    assert.equal(verified.length,limit);
    completed=true;
  } finally {
    const rows=verified.sort((a,b)=>a.ordinal-b.ordinal);
    writeAtomic(path.join(output,'per-question.jsonl'),rows.map(row=>JSON.stringify(row)+'\n').join(''));
    const correct=rows.filter(row=>row.verdict==='yes').length;
    const judged=rows.filter(row=>row.judge_status==='judged').length;
    const summary={questions:limit,reader_terminal:records.size,
      generated:[...records.values()].filter(meta=>(meta.generation_status??'complete')==='complete').length,
      rows:rows.length,judged,correct,unresolved:rows.length-judged,accuracy:completed && limit===500?correct/500:null,
      ...(limit<500?{sampleAccuracy:completed?correct/limit:null}:{}),
      provisional:true,partial:!completed||limit!==500,concurrency,originalAccuracy:measurement.accuracy};
    save(path.join(output,'measurement.json'),summary);
    console.log(JSON.stringify(summary));
  }
}
if(mode==='probe'){
  console.log(JSON.stringify(await invoke({install,root:scratch,system:reader.system,model:'deepseek-flash',maxTokens:2048,credentialStore,probe:true})));
} else {
  const owner=new DatabaseSync(path.join(output,'owner.sqlite'),{timeout:0});
  try{owner.exec('BEGIN EXCLUSIVE');await run();}finally{owner.close();}
}
