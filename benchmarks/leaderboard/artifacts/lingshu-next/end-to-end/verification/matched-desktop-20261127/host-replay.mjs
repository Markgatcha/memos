import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

import {judge, judgePrompt, project} from '../../prepare.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const here = path.dirname(fileURLToPath(import.meta.url));
const pins = {
  datasetSha256: '08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894',
  ingestionTreeSha256: '0f62525c261e079d599050156f485b4371f83287fd650e77611b53221f59c2d6',
  readerTreeSha256: 'd4bf1671bfc2a0eba4b897e2821669af93e1c2fb1a884a7a3bdd42ba1fab6417',
  judgeTreeSha256: 'eee9552ce02f98f7db2483dcc81d7f68e71255d571fb90f6e8100c34a9e8329e',
  judgePromptSha256: '50d4f70a1a66ef13e0ee932b825adfb232a3b366cdc1684b6532db100eb10be1',
  harnessExeSha256: '93e0e6e31a2db74eb2e4905b3c79e339537f2c7cc9c9ff72eac2ff5d226f6780',
  harnessArchiveSha256: '14cfd81c9135bf0afb89417543c94f9ecfe09266574452a9b106890c698725ae',
};
const providerRoute = 'deepseek-account';
const readerModel = 'deepseek-flash';
const judgeModel = 'deepseek-v4-pro';
const effort = 'off';
const harnessVersion = '0.2.2-rc.3';

async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const block of fs.createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

async function verifyDataset(dataset) {
  assert.equal(await fileHash(dataset), pins.datasetSha256, 'Dataset SHA-256 mismatch');
}

async function treeHash(root) {
  assert.ok(fs.lstatSync(root).isDirectory(), 'Expected a real frozen directory');
  const files = [];
  function collect(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes:true})) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) collect(name);
      else {
        assert.ok(entry.isFile(), 'Frozen tree contains a non-file entry');
        files.push(name);
      }
    }
  }
  collect('');
  const manifest = [];
  for (const name of files.sort()) {
    const file = path.join(root, name);
    manifest.push({path:name, bytes:fs.statSync(file).size, sha256:await fileHash(file)});
  }
  return sha(JSON.stringify(manifest));
}

function save(file, data) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', {flag:'wx', flush:true});
  fs.renameSync(temporary, file);
}

function writeJudgeFile(file, data) {
  const payload = JSON.stringify(data, null, 2) + '\n';
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = fs.openSync(temporary, 'wx');
  try {
    fs.writeFileSync(handle, payload);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.linkSync(temporary, file);
  } finally {
    fs.unlinkSync(temporary);
  }
}

const recoverable = error => error?.cause?.message === 'bad port' ||
  ['EADDRINUSE','EACCES','ECONNREFUSED','ECONNRESET'].includes(error?.code ?? error?.cause?.code) ||
  ['TimeoutError','AbortError'].includes(error?.name);

async function openNextHost(createHost, options) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let host;
    try {
      host = await createHost({...options, port:0});
      assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(host.origin), 'NEXT_HOST_NOT_LOOPBACK');
      const response = await fetch(host.origin, {signal:AbortSignal.timeout(15000)});
      const cookie = response.headers.getSetCookie().find(value => value.startsWith('next_desktop='))?.split(';')[0];
      await response.arrayBuffer();
      assert.ok(response.ok && cookie, 'NEXT_HOST_COOKIE_UNAVAILABLE');
      return {host, cookie};
    } catch (error) {
      await host?.close();
      if (!recoverable(error)) throw error;
      if (attempt === 3) throw new Error('NEXT_LOCAL_PORT_UNAVAILABLE', {cause:error});
    }
  }
}

const padded = ordinal => String(ordinal).padStart(3, '0');
const identity = (...parts) => sha(JSON.stringify(parts)).slice(0, 32);
const load = (root, name) => import(pathToFileURL(path.join(root, 'desktop', name)).href);
const publicPath = (output, stage, ordinal) => path.join(output, stage, padded(ordinal) + '.json');

async function* projectReader(dataset, limit) {
  const child = spawn(process.env.PYTHON || 'python', ['-B', path.join(here, 'host-project.py'), dataset, String(limit)],
    {windowsHide:true, stdio:['ignore', 'pipe', 'ignore']});
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  closed.catch(() => {});
  try {
    let count = 0;
    for await (const line of createInterface({input:child.stdout, crlfDelay:Infinity})) {
      const row = JSON.parse(line);
      assert.equal(row.ordinal, ++count);
      yield row;
    }
    assert.equal(await closed, 0, 'Reader input projection failed');
    assert.equal(count, limit);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

function prepareDatabase(MemoryStore, item, database) {
  const temporary = database + '.' + randomUUID() + '.tmp';
  const store = new MemoryStore(temporary);
  try {
    store.setMemoryEnabled('personal', true);
    for (const history of item.histories.sort((a, b) => a.at - b.at || a.ordinal - b.ordinal)) {
      const id = identity('next-track-b', item.ordinal, history.ordinal);
      const messages = history.messages.map(([role, text], index) => ({id:identity(id, index), role, text, at:history.at}));
      const imported = store.importSession({id, workspaceId:'personal', updatedAt:history.at, messages});
      const verified = store.readSession(id);
      assert.equal(verified.updatedAt, history.at);
      assert.deepEqual(verified.messages, messages);
      assert.equal(imported.messageCount, messages.length);
    }
    assert.equal(store.listSessions('personal').length, item.histories.length);
  } finally {
    store.close();
  }
  fs.renameSync(temporary, database);
}

async function generate(item, output, settings, desktop) {
  const readerFile = publicPath(output, 'reader', item.ordinal);
  if (fs.existsSync(readerFile)) return;
  const {createDesktopHost, DshDesktopProvider, RELEASE_PROFILE, DSH_BINDING, bindExecutionProfile} = desktop;
  const intentFile = publicPath(output, 'intent', item.ordinal);
  const stateDir = path.join(output, 'host', padded(item.ordinal));
  const template = path.join(output, 'memory', padded(item.ordinal) + '.sqlite');
  fs.mkdirSync(stateDir, {recursive:true});
  bindExecutionProfile(stateDir, RELEASE_PROFILE);
  const database = path.join(stateDir, 'memory.sqlite');
  if (!fs.existsSync(database)) fs.copyFileSync(template, database, fs.constants.COPYFILE_EXCL);
  if (fs.existsSync(intentFile)) {
    // A previous launch marked this attempt. A fresh model call is ambiguous.
    save(readerFile, {status:'interrupted-after-dispatch-marker', elapsedMs:null, result:null, answer:null,
      question_id:item.question_id, corpusSessionCount:item.corpusSessionCount});
    return;
  }
  const buildProvider = () => new DshDesktopProvider({
    installationDir:settings.install, stateDir:settings.account, allowInference:true, allowAuthorization:false,
  });
  let host;
  let provider;
  const begin = performance.now();
  try {
    const connected = await openNextHost(async options => {
      provider = buildProvider();
      try {
        return await createDesktopHost({...options, provider});
      } catch (error) {
        await provider.close();
        throw error;
      }
    }, {stateDir, executionProfile:RELEASE_PROFILE, allowInference:true, allowAuthorization:false,
      enableMemoryCapabilities:true, maxCalls:1, maxTokens:131072, maxPromptChars:8000,
      sleepPollMs:0, autoArchivePollMs:0, topicPollMs:0});
    ({host} = connected);
    const headers = {Cookie:connected.cookie, Origin:host.origin, 'Content-Type':'application/json', 'X-Next-Desktop':'1'};
    const post = async (route, payload) => {
      const res = await fetch(host.origin + route, {method:'POST', headers, body:JSON.stringify(payload), signal:AbortSignal.timeout(120000)});
      const body = await res.json();
      if (!res.ok) throw Error(body.error ?? 'NEXT_HTTP_REJECTED');
      return body;
    };
    const state = await provider.state();
    assert.ok(state.providerStatus.providers[0].providerRoute === providerRoute &&
      state.models.some(model => model.modelId === readerModel && model.thinking.values.includes(effort)), 'DSH_MODEL_UNAVAILABLE');
    const session = (await post('/api/history/desktop-create', {operationId:randomUUID()})).session;
    const intent = {run:1, ordinal:item.ordinal, question_id:item.question_id, sessionId:session.id,
      expectedRevision:session.revision, requestId:randomUUID(), time:new Date().toISOString()};
    save(intentFile, intent);
    const getRequest = () => host.audit.prepare('SELECT status,result FROM requests WHERE id=?').get(intent.requestId);
    let record = getRequest();
    if (!record) {
      await post('/api/chat', {id:intent.requestId, sessionId:intent.sessionId, bindingId:DSH_BINDING,
        modelId:readerModel, effort, expectedRevision:intent.expectedRevision, userText:item.question,
        questionDate:item.questionDate, noMemory:true});
      const stream = await fetch(host.origin + '/api/events?id=' + intent.requestId,
        {headers, signal:AbortSignal.timeout(180000)});
      assert.ok(stream.ok);
      await stream.text();
      record = getRequest();
    }
    assert.ok(record, 'MISSING_PRODUCT_AUDIT');
    const result = JSON.parse(record.result ?? '{}');
    const receipt = {...intent, status:record.status, at:new Date().toISOString(),
      elapsedMs:Math.round(performance.now() - begin), result,
      budget:host.audit.prepare('SELECT * FROM model_budget WHERE id=?').get(intent.requestId),
      events:host.audit.prepare('SELECT * FROM events WHERE request_id=? ORDER BY seq').all(intent.requestId)};
    save(publicPath(output, 'reader-receipt', item.ordinal), receipt);
    let answer = null;
    if (record.status === 'complete') {
      const history = (await post('/api/history/desktop-read', {id:intent.sessionId})).session;
      const assistant = history.messages.findLast(message => message.role === 'assistant');
      assert.equal(assistant.text, result.text);
      assert.ok(assistant.text.trim() && assistant.delivery === 'complete');
      assert.equal(result.harness.billingSource, providerRoute);
      assert.equal(result.harness.archiveSha256, pins.harnessArchiveSha256);
      assert.equal(result.harness.version, harnessVersion);
      assert.equal(result.model, readerModel);
      assert.ok(result.threadId && result.messageId && result.eventDigest);
      answer = assistant.text;
    }
    save(readerFile, {...receipt, answer, corpusSessionCount:item.corpusSessionCount});
    return record.status;
  } finally {
    try {
      await host?.close();
    } finally {
      await provider?.close();
    }
  }
}

async function judgeQuestion(item, rubric, output, settings, runtimeClass, activityClass) {
  const attemptPath = publicPath(output, 'judge-attempt', item.ordinal);
  const receiptPath = publicPath(output, 'judge', item.ordinal);
  if (fs.existsSync(receiptPath)) return;
  const expected = {run:1, ordinal:item.ordinal, question_id:item.questionId, category:item.task,
    abstention:item.questionId.includes('_abs'), hypothesisSha256:item.answerSha256, rubricSha256:rubric ? sha(rubric) : null};
  function unresolved(status) {
    writeJudgeFile(receiptPath, {...expected, status, verdict:null, usage:null});
  }
  if (fs.existsSync(attemptPath)) return unresolved('interrupted-after-dispatch-marker');
  if (rubric === null) return unresolved('generation-failed');
  if (Buffer.byteLength(rubric) > 8192) return unresolved('rubric-byte-limit');

  const runtime = await runtimeClass.open({installationDir:settings.install, stateDir:settings.account, allowAuthorization:false,
    allowCatalog:true, inference:{systemPrompt:judge.system}});
  const started = performance.now();
  const sessionId = randomUUID();
  let attempt;
  let stop;
  let receipt;
  let wireError;
  try {
    assert.equal(runtime.manifest.packageVersion, harnessVersion, 'TRACK_B_HARNESS_VERSION_MISMATCH');
    const catalog = await runtime.request('model.catalog');
    const model = catalog.models.find(value => value.id === judgeModel);
    assert.ok(catalog.provider === providerRoute && model?.efforts.includes(effort), 'TRACK_B_JUDGE_MODEL_UNAVAILABLE');
    const view = new activityClass({sessionId, provider:providerRoute, model:judgeModel, prompt:rubric,
      expectedSystemPromptSha256:sha(judge.system), expectedMaxTokens:64,
      cwd:runtime.cwd, contextWindow:model.contextWindow, effort, harnessVersion});
    stop = runtime.onNotification((method, params) => {
      if (wireError) return;
      try {
        view.observe(method, params);
      } catch (error) {
        wireError = error;
      }
    });
    await runtime.sdkRequest('initialize', {cwd:runtime.cwd, provider:providerRoute, model:judgeModel,
      approvalRequests:false, reasoningEffort:effort, maxTokens:64});

    attempt = {...expected, dispatchedAt:new Date().toISOString(), providerSessionId:sessionId,
      judgeModel, providerRoute, effort, temperature:null, harnessVersion,
      harnessExecutableSha256:runtime.manifest.executableSha256, harnessArchiveSha256:runtime.manifest.archiveSha256,
      runtimeContextSha256:sha(judge.runtimeContextTemplate.replace('{working_directory_json}', JSON.stringify(runtime.cwd)))};
    writeJudgeFile(attemptPath, attempt);
    const accepted = await runtime.sdkRequest('session/prompt', {sessionId, contentBlocks:[{type:'text', text:rubric}]});
    view.acceptPrompt(accepted);
    await runtime.sdkRequest('session/wait', {sessionId});
    const exit = await runtime.close();
    assert.ok(exit.shutdownConfirmed && exit.exitCode === 0, 'TRACK_B_JUDGE_SHUTDOWN_UNCONFIRMED');
    if (wireError) throw wireError;
    const result = view.confirmWait();
    const normalized = result.text.trim().toLowerCase();
    const verdict = ['yes', 'no'].includes(normalized) ? normalized : null;
    receipt = {...attempt, status:verdict ? 'judged' : 'invalid-verdict', verdict,
      rawJudgeResponse:result.text, rawJudgeResponseSha256:sha(result.text),
      messageId:result.messageId, eventDigest:result.eventDigest,
      usage:result.usageKnown && result.rawUsage.length === 1 ? result.rawUsage[0] : null,
      elapsedMs:Math.round(performance.now() - started)};
  } catch (error) {
    if (!attempt || !fs.existsSync(attemptPath)) throw error;
    receipt = {...attempt, status:'judge-runtime-failure', verdict:null, usage:null,
      elapsedMs:Math.round(performance.now() - started)};
  } finally {
    await runtime.close();
    stop?.();
  }
  writeJudgeFile(receiptPath, receipt);
  return receipt.status;
}

function publicRow(item, generation, judgement) {
  const result = generation.result ?? {};
  const sourceIds = result.sourceIds;
  const usage = judgement.usage;
  return {run:1, ordinal:item.ordinal, question_id:item.questionId, task:item.task, abstention:judgement.abstention,
    hypothesis_sha256:judgement.hypothesisSha256, generation_status:generation.status,
    reader_latency_ms:generation.elapsedMs, retrieval_source_count:sourceIds?.length ?? null,
    retrieval_session_count:sourceIds ? new Set(sourceIds.map(id => id.split('/')[0])).size : null,
    corpus_session_count:generation.corpusSessionCount ?? null, judge_status:judgement.status,
    verdict:judgement.verdict, judge_rubric_sha256:judgement.rubricSha256, judge_latency_ms:judgement.elapsedMs ?? null,
    reader_prompt_sha256:result.promptHash ?? null, reader_prompt_utf16:null,
    reader_tokens:result.usage?.totalTokens ?? null,
    judge_tokens:usage?.totalTokens ?? null};
}

async function preflight(settings) {
  assert.ok(process.platform === 'win32' && process.arch === 'x64', 'Windows x64 required');
  assert.equal(process.versions.node, '24.19.0', 'Expected the measured Node release');
  assert.equal(process.versions.sqlite, '3.53.3', 'Expected the measured SQLite release');
  for (const [name, observed] of [
    ['datasetSha256', await fileHash(settings.dataset)],
    ['ingestionTreeSha256', await treeHash(settings.ingestion)],
    ['readerTreeSha256', await treeHash(settings.reader)],
    ['judgeTreeSha256', await treeHash(settings.judge)],
    ['judgePromptSha256', await fileHash(path.join(here, '../../judge-prompt.json'))],
    ['harnessExeSha256', await fileHash(path.join(settings.install, 'DeepSeek Harness.exe'))],
    ['harnessArchiveSha256', await fileHash(path.join(settings.install, 'resources', 'app.asar'))],
  ]) assert.equal(observed, pins[name], name + ' mismatch');
}

async function main() {
  const {values, positionals} = parseArgs({allowPositionals:true, options:{
    dataset:{type:'string'}, ingestion:{type:'string'}, reader:{type:'string'}, judge:{type:'string'},
    install:{type:'string'}, account:{type:'string'}, output:{type:'string'}, limit:{type:'string', default:'500'},
    'allow-model-calls':{type:'boolean'},
  }});
  assert.equal(positionals.length, 1, 'Expected preflight, prepare, run or resume');
  const [mode] = positionals;
  assert.ok(['preflight', 'prepare', 'run', 'resume'].includes(mode), 'Expected preflight, prepare, run or resume');
  for (const name of ['dataset', 'ingestion', 'reader', 'judge', 'install']) {
    assert.ok(values[name], '--' + name + ' is required');
    values[name] = path.resolve(values[name]);
  }
  await preflight(values);
  if (mode === 'preflight') {
    console.log(JSON.stringify({mode, ...pins, modelCalls:0}, null, 2));
    return;
  }
  const limit = Number(values.limit);
  assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 500, 'Limit must be 1 through 500');
  assert.ok(values.output, '--output is required');
  const output = path.resolve(values.output);
  if (mode === 'prepare') {
    fs.mkdirSync(output);
    const {MemoryStore} = await load(values.ingestion, 'memory-store.mjs');
    for await (const item of projectReader(values.dataset, limit)) {
      prepareDatabase(MemoryStore, item, path.join(output, padded(item.ordinal) + '.sqlite'));
    }
    await verifyDataset(values.dataset);
    console.log(JSON.stringify({mode, questions:limit, modelCalls:0}));
    return;
  }
  assert.ok(values['allow-model-calls'] && values.account, 'Run and resume require --allow-model-calls and --account');
  values.account = fs.realpathSync(values.account);
  assert.ok(fs.lstatSync(path.join(values.account, 'next-account-credentials.yaml')).isFile(),
    'Sign in to a dedicated benchmark profile using the official account flow');
  const separate = (left, right) => {
    const relative = path.relative(left, right);
    return relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  };
  assert.ok(separate(values.account, output) && separate(output, values.account),
    '--output must be outside the benchmark account profile');
  const recipe = {limit, toolSha256:await fileHash(fileURLToPath(import.meta.url)), account:values.account, pins};
  if (mode === 'run') {
    fs.mkdirSync(output);
    for (const folder of ['host', 'input', 'intent', 'memory', 'reader', 'reader-receipt', 'judge', 'judge-attempt']) {
      fs.mkdirSync(path.join(output, folder));
    }
    save(path.join(output, 'recipe.json'), recipe);
  } else {
    assert.deepEqual(read(path.join(output, 'recipe.json')), recipe, 'Resume settings changed');
  }
  const lock = new DatabaseSync(path.join(output, 'owner.sqlite'), {timeout:0});
  try {
    lock.exec('BEGIN EXCLUSIVE');
    const snapshot = path.join(output, 'dataset.snapshot');
    if (!fs.existsSync(snapshot)) {
      const candidate = snapshot + '.' + randomUUID() + '.tmp';
      fs.copyFileSync(values.dataset, candidate, fs.constants.COPYFILE_EXCL);
      await verifyDataset(candidate);
      fs.renameSync(candidate, snapshot);
    }
    await verifyDataset(snapshot);
    const [{MemoryStore}, {createDesktopHost}, {DshDesktopProvider}, execution] = await Promise.all([
      load(values.ingestion, 'memory-store.mjs'),
      load(values.reader, 'host.mjs'),
      load(values.reader, 'dsh-desktop-provider.mjs'),
      load(values.reader, 'execution-profile.mjs'),
    ]);
    const preparation = path.join(output, 'prepared.json');
    if (!fs.existsSync(preparation)) {
      const items = [];
      for await (const item of projectReader(snapshot, limit)) {
        const database = path.join(output, 'memory', padded(item.ordinal) + '.sqlite');
        prepareDatabase(MemoryStore, item, database);
        const {ordinal, question_id, question, questionDate, histories} = item;
        const input = publicPath(output, 'input', ordinal);
        save(input, {ordinal, question_id, question, questionDate, corpusSessionCount:histories.length});
        items.push({ordinal, inputSha256:await fileHash(input), databaseSha256:await fileHash(database)});
      }
      await verifyDataset(snapshot);
      save(preparation, {items});
    }
    const {items} = read(preparation);
    assert.equal(items.length, limit);
    let failures = 0;
    for (const [index, prepared] of items.entries()) {
      const ordinal = index + 1;
      assert.equal(prepared.ordinal, ordinal);
      const input = publicPath(output, 'input', ordinal);
      const database = path.join(output, 'memory', padded(ordinal) + '.sqlite');
      assert.equal(await fileHash(input), prepared.inputSha256, 'Reader input changed after preparation');
      assert.equal(await fileHash(database), prepared.databaseSha256, 'Reader memory changed after preparation');
      const status = await generate(read(input), output, values, {createDesktopHost, DshDesktopProvider, ...execution});
      if (status !== undefined) failures = status === 'complete' ? 0 : failures + 1;
      assert.ok(failures < 3, 'THREE_CONSECUTIVE_FAILURES');
    }
    const [{DshAccountRuntime}, {DshActivityEvidence}] = await Promise.all([
      load(values.judge, 'dsh-runtime.mjs'), load(values.judge, 'dsh-activity.mjs'),
    ]);
    await verifyDataset(snapshot);
    const scoreInputs = [];
    for await (const item of project(snapshot, 'score', limit)) scoreInputs.push(item);
    await verifyDataset(snapshot);
    failures = 0;
    const rows = [];
    for (const item of scoreInputs) {
      const generated = read(publicPath(output, 'reader', item.ordinal));
      if (generated.question_id !== undefined) assert.equal(generated.question_id, item.questionId);
      const answer = generated.answer;
      item.answerSha256 = answer === null ? null : sha(answer);
      const rubric = answer === null ? null : judgePrompt(item, answer);
      const status = await judgeQuestion(item, rubric, output, values, DshAccountRuntime, DshActivityEvidence);
      if (status !== undefined) failures = status === 'judge-runtime-failure' ? failures + 1 : 0;
      assert.ok(failures < 3, 'TRACK_B_CONSECUTIVE_JUDGE_FAILURES_REVIEW_REQUIRED');
      const judged = read(publicPath(output, 'judge', item.ordinal));
      assert.equal(judged.hypothesisSha256, item.answerSha256);
      assert.equal(judged.rubricSha256, rubric === null ? null : sha(rubric));
      rows.push(publicRow(item, generated, judged));
    }
    const exportFile = path.join(output, 'per-question.jsonl');
    const payload = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    if (fs.existsSync(exportFile)) assert.equal(fs.readFileSync(exportFile, 'utf8'), payload, 'Published rows changed');
    else fs.writeFileSync(exportFile, payload, {flag:'wx', flush:true});
    console.log(JSON.stringify({mode, questions:rows.length, partial:limit < 500,
      correct:rows.filter(row => row.verdict === 'yes').length, unresolved:rows.filter(row => row.verdict === null).length}));
  } finally {
    lock.close();
  }
}

try {
  await main();
} catch (error) {
  // Keep model text, local account data and filesystem details outside the console.
  const safe = /^[A-Z0-9_-]+$/.test(error?.message) ? error.message :
    error?.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : 'Execution stopped. Check the command and private benchmark state.';
  console.error(safe);
  process.exitCode = 1;
}
