import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';

const provider='deepseek-account';
const official=name=>'@deepseek-ai/'+name;
const packagePin='14cfd81c9135bf0afb89417543c94f9ecfe09266574452a9b106890c698725ae';
const executablePin='93e0e6e31a2db74eb2e4905b3c79e339537f2c7cc9c9ff72eac2ff5d226f6780';
async function hashFile(file) {
  const hash=createHash('sha256');
  for await(const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
export async function installation() {
  assert.equal(process.platform,'win32','The measured account SDK uses the Windows x64 desktop distribution');
  assert.ok(process.env.DSH_BENCH_INSTALL,'Set DSH_BENCH_INSTALL to the official 0.2.2-rc.3 installation directory');
  const exe=path.resolve(process.env.DSH_BENCH_INSTALL,'DeepSeek Harness.exe');
  const archive=path.resolve(process.env.DSH_BENCH_INSTALL,'resources','app.asar');
  assert.equal(await hashFile(exe),executablePin,'Wrong official executable');
  assert.equal(await hashFile(archive),packagePin,'Wrong official archive');
  return {exe,launcher:path.join(archive,'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')};
}

function profile(root,system,credentialStore) {
  const cwd=path.join(root,'cwd');
  const home=path.join(root,'home');
  const sessions=path.join(root,'sessions');
  const name='next-benchmark';
  const dir=path.join(home,'profiles',name);
  for (const location of [dir,cwd,sessions]) fs.mkdirSync(location,{recursive:true});
  const row=(id,name,config)=>({id,name:official(name),...(config?{config}:{})});
  const rows=[
    row('sdk-app-startup','dsh-sdk-app',{profile:name}),
    {...row('sdk-jsonrpc-server','dsh-sdk-jsonrpc-server',{maxTokensAsSuccess:false}),inject:['sdkAppStartup','loader']},
    row('timer','cordis-plugin-timer'),row('llm','dsh-llm'),row('session','dsh-session'),
    row('session-projection','dsh-session-projection'),row('system-prompt','dsh-system-prompt',
      {includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:system}),
    row('tools','dsh-tools'),row('tool-executor-native','dsh-tool-executor-native'),row('agent','dsh-agent'),
    row('agent-loop','dsh-agent-loop',{agents:[]}),row('filesystem','dsh-fs-local'),
    row('working-directory','dsh-working-directory',{defaultDirectory:cwd}),
    row('jobs','dsh-jobs-local'),row('token-meter','dsh-token-meter'),
    row('sessions','dsh-session-persistence-jsonl',{root:sessions,compression:'none'}),
    row('credentials','dsh-credentials-local',{path:credentialStore,watch:false}),
    row('authorization','dsh-authorization'),row('deepseek-account-platform','dsh-deepseek-account'),
    row('llm-deepseek-account','dsh-llm-deepseek-account'),
    row('account-webserver','dsh-host-webserver',{host:'127.0.0.1',port:0,compression:'none'})
  ];
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name,private:true,dependencies:{},
    dsh:{profile:{bundles:[],patchReload:'startup'}}}));
  fs.writeFileSync(path.join(dir,'cordis.patch.yml'),JSON.stringify([{insert:rows}]));
  return {home,cwd,name};
}

export async function invoke({install,root,model,system,prompt,maxTokens,credentialStore,probe=false,mark=()=>{}}) {
  const sessionId=randomUUID();
  const {home,cwd,name}=profile(root,system,credentialStore);
  const scratch={};
  for(const key of ['USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP']){
    scratch[key]=path.join(root,key);fs.mkdirSync(scratch[key],{recursive:true});
  }
  const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,ComSpec:process.env.ComSpec,
    PATH:path.join(process.env.SystemRoot,'System32'),...scratch,DSH_HOME:home,
    ELECTRON_RUN_AS_NODE:'1',DSH_TELEMETRY_DISABLED:'1'};
  const child=spawn(install.exe,['--disable-warning=ExperimentalWarning','--expose-internals',install.launcher,'--profile',name],
    {cwd,env,windowsHide:true,stdio:['pipe','pipe','ignore']});
  const pending=new Map();
  let next=0;
  let fatal;
  const messages={};
  const stages=['system','user','runtime-context','header','context','answer','completed'];
  let stage=0;
  function observeStage(name) {
    assert.equal(name,stages[stage], 'Unexpected SDK message order or count');
    stage++;
  }
  const events=new Map();
  function fail(reason) {
    fatal??=reason;
    for(const request of pending.values())request.reject(fatal);
    pending.clear();child.kill();
  }
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  closed.catch(()=>{});
  child.on('error',()=>fail(Error('SDK launch failed')));
  child.stdin.on('error',()=>fail(Error('SDK pipe closed')));
  child.on('close',()=>{if(pending.size)fail(Error('SDK closed before replying'));});
  function request(method,params) {
    if(fatal)throw fatal;
    const id=++next;
    return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
  }
  const seenEvent=(event)=>{
    if(events.has(event.seq)){assert.deepEqual(events.get(event.seq),event);return;}
    events.set(event.seq,event);
    const {data,type}=event;
    if(type==='user/message' && data.source?.kind==='runtime-context'){
      const ctx='<system-reminder>\nThe following information describes your current session:\n\nCurrent working directory: '+JSON.stringify(cwd)+'.\n</system-reminder>';
      observeStage('runtime-context');
      assert.deepEqual(data.content,[{type:'text',text:ctx}]);
      assert.equal(data.source.form,'snapshot');
      assert.deepEqual(data.source.sections,[{name:'working-directory:current',text:'Current working directory: '+JSON.stringify(cwd)+'.'}]);
      messages.cwd=true;
    } else if(type==='user/message'){
      observeStage('user');
      assert.deepEqual(data.source,{kind:'user'});assert.deepEqual(data.content,[{type:'text',text:prompt}]);messages.prompt=true;
    } else if(type==='system/message'){
      observeStage('system');
      assert.deepEqual(data.message.source,{kind:'system-prompt'});
      assert.deepEqual(data.message.content,[{type:'text',text:system}]);messages.system=true;
    } else if(type==='request/header'){
      observeStage('header');
      const h=data.header;assert.deepEqual(h.tools??[],[]);assert.equal(h.config.provider,provider);
      assert.equal(h.config.model,model);assert.equal(h.config.reasoningEffort,'off');
      assert.equal(h.config.maxTokens,maxTokens);assert.ok(!messages.header);messages.header=true;
    } else if(type==='request/context'){
      observeStage('context');assert.equal(data.provider,provider);assert.equal(data.model,model);
    } else if(type==='assistant/message'){
      observeStage('answer');
      assert.equal(data.message.source.provider,provider);assert.equal(data.message.source.model,model);
      assert.ok(!Object.hasOwn(messages,'text'));
      assert.ok(data.message.content.every(block=>block.type==='text'||block.type==='reasoning'));
      messages.text=data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('');
      messages.usage=data.usage??null;
    } else if(type==='turn/end'){
      observeStage('completed');assert.equal(data.reason.kind,'completed');messages.completed=true;
    } else {
      assert.ok(['agent/inbox/spliced','turn/start','step/start','working-directory/change','request/context','step/end'].includes(type),'Unexpected extra SDK activity');
    }
  };
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
  lines.on('line',line=>{
    try {
      const frame=JSON.parse(line);
      if(frame.method){
        assert.equal(frame.params.sessionId,sessionId);
        if(frame.method==='session.event')seenEvent(frame.params.event);
        else assert.equal(frame.method,'session.status');
      } else {
        const reply=pending.get(frame.id);assert.ok(reply);
        pending.delete(frame.id);
        if(frame.error)reply.reject(Error('Official SDK rejected the request'));
        else reply.resolve(frame.result);
      }
    } catch {fail(Error('SDK response or model-context validation failed'));}
  });
  const timer=setTimeout(()=>fail(Error('SDK response timed out')),120000);
  try {
    const initialized=await request('initialize',{cwd,provider,model,reasoningEffort:'off',maxTokens,approvalRequests:false});
    assert.equal(initialized.serverInfo.name,'deepseek-harness-sdk-runtime');
    if(!probe) {
      mark('dispatch');
      const receipt=await request('session/prompt',{sessionId,contentBlocks:[{type:'text',text:prompt}]});
      assert.ok(receipt.messageId);
      mark('ack');
      await request('session/wait',{sessionId});
      mark('wait');
      assert.ok(stage===stages.length && messages.cwd && messages.system && messages.prompt && messages.header && messages.completed && messages.text?.trim());
    }
    await request('shutdown',{});
    const exitCode=await closed;
    if(fatal)throw fatal;
    assert.equal(exitCode,0);
    return probe?{initialized:true,modelCalls:0}:{text:messages.text,usage:messages.usage};
  } finally {clearTimeout(timer);if(child.exitCode===null)child.kill();await closed.catch(()=>{});}
}
