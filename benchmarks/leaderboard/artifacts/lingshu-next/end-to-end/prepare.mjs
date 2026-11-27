import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from './memory-store.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const sha = value => createHash('sha256').update(value).digest('hex');
const identity = (...values) => sha(JSON.stringify(values)).slice(0,32);
export const read = name => JSON.parse(fs.readFileSync(path.join(here,name),'utf8'));
export const measurement = read('measurement.json');
function loadPrompt(name,expectedHash) {
  const bytes=fs.readFileSync(path.join(here,name));
  const digest=sha(bytes);
  assert.equal(digest,expectedHash,'Prompt file changed: '+name);
  return {template:JSON.parse(bytes),digest};
}
const readerFile=loadPrompt('reader-prompt.json',measurement.reader_prompt_file_sha256);
const judgeFile=loadPrompt('judge-prompt.json',measurement.judge_prompt_file_sha256);
export const reader=readerFile.template;
export const judge=judgeFile.template;
export const readerFileSha256=readerFile.digest;
export const judgeFileSha256=judgeFile.digest;

// Stop the input stream on failure. Already-dispatched work retains its receipt.
export async function runConcurrent(openSource, concurrency, worker) {
  assert.ok(Number.isInteger(concurrency) && concurrency >= 1);
  const source = new AbortController();
  const active = new Set();
  try {
    for await (const row of openSource(source.signal)) {
      source.signal.throwIfAborted();
      const task = Promise.resolve().then(() => worker(row))
        .catch(error => source.abort(error))
        .finally(() => active.delete(task));
      active.add(task);
      if (active.size === concurrency) {
        await Promise.race(active);
        source.signal.throwIfAborted();
      }
    }
  } catch (error) {
    source.abort(error);
  } finally {
    await Promise.all(active);
  }
  source.signal.throwIfAborted();
}

export async function* project(dataset, mode, limit=500, signal) {
  const child = spawn(process.env.PYTHON || (process.platform==='win32'?'python':'python3'),
    ['-B',path.join(here,'project.py'),mode,path.resolve(dataset),String(limit)],
    {windowsHide:true,stdio:['ignore','pipe','inherit'],signal});
  const exit = new Promise((resolve,reject) => {child.once('error',reject);child.once('close',resolve);});
  exit.catch(()=>{});
  try {
    let count = 0;
    for await (const line of createInterface({input:child.stdout,crlfDelay:Infinity})) {
      const row = JSON.parse(line);
      assert.equal(row.ordinal,++count);
      yield row;
    }
    assert.equal(await exit,0,'projection failed');
    assert.equal(count,limit);
  } finally { if (child.exitCode===null) child.kill(); }
}

export async function validateData(dataset) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(dataset)) hash.update(bytes);
  assert.equal(hash.digest('hex'),measurement.dataset_sha256,'Expected the pinned, original LongMemEval-S file');
}

export function assemble(item) {
  const store = new MemoryStore(':memory:');
  try {
    store.setMemoryEnabled('personal',true);
    for (const h of item.histories.sort((a,b)=>a.at-b.at || a.ordinal-b.ordinal)) {
      const id = identity('next-track-b',item.ordinal,h.ordinal);
      const messages = h.messages.map(([role,text],i)=>({id:identity(id,i),role,text,at:h.at}));
      store.importSession({id,workspaceId:'personal',updatedAt:h.at,messages});
    }
    const candidates = store.retrieve({workspaceId:'personal',question:item.question,maxChars:24000}).sources;
    function pack(sources) {
      const groups = Map.groupBy(sources,source=>source.sessionId);
      const records = Array.from(groups.values()).flatMap(group => group.sort((a,b)=>a.at-b.at || a.position-b.position)
        .map(s=>({sourceId:s.sessionId+'/'+s.messageId,recordedAt:new Date(s.at).toISOString(),text:s.text})));
      return JSON.stringify({currentQuestion:item.question,questionDate:item.questionDate || null,
        conversation:[],sourceRecords:records,memoryFacts:[]});
    }
    const accepted=[];
    let prompt=pack([]);
    assert.ok(prompt.length<=8000);
    for (const source of candidates) {
      const trial=pack([...accepted,source]);
      // Three envelopes, 256 fixed bytes, and a 2048-token output reservation.
      const estimate=256+48+Buffer.byteLength(reader.system)-1+Buffer.byteLength(trial)+2048;
      if (trial.length<=8000 && estimate<=131072) { accepted.push(source); prompt=trial; }
    }
    return {prompt,sourceCount:accepted.length,sessionCount:new Set(accepted.map(s=>s.sessionId)).size,corpusCount:item.histories.length};
  } finally {store.close();}
}

export function judgePrompt(row, answer) {
  const category=row.questionId.includes('_abs')?'abstention':row.task;
  const template=judge.userTemplates[category];
  const fields={question:row.question,reference:row.answer,hypothesis:answer};
  return template.replace(/\{(question|reference|hypothesis)\}/g,(_,key)=>fields[key]);
}
