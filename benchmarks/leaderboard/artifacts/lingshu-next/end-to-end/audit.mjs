import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {here,sha,reader,measurement,project,validateData,assemble} from './prepare.mjs';

const dataset=process.argv[2];
assert.ok(dataset,'Usage: node audit.mjs DATASET');
await validateData(dataset);
const bytes=fs.readFileSync(path.join(here,'per-question.jsonl'));
assert.equal(sha(bytes),measurement.per_question_sha256);
const rows=bytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
assert.equal(rows.length,500);
assert.equal(sha(reader.system),measurement.reader_system_sha256);
assert.equal(sha(fs.readFileSync(path.join(here,'judge-prompt.json'))),measurement.judge_prompt_file_sha256);
let count=0;
for await (const item of project(dataset,'product')) {
  const row=rows[count++];
  const result=assemble(item);
  assert.equal(row.ordinal,item.ordinal);
  assert.equal(sha(result.prompt),row.reader_prompt_sha256,'reader prompt differs at ordinal '+item.ordinal);
  assert.equal(result.sourceCount,row.retrieval_source_count);
  assert.equal(result.sessionCount,row.retrieval_session_count);
  assert.equal(result.corpusCount,row.corpus_session_count);
}
const correct=rows.filter(r=>r.verdict==='yes').length;
assert.equal(correct,328);
console.log(JSON.stringify({matchedReaderPrompts:count,recordedCorrect:correct,modelCalls:0}));
