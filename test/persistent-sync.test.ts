import {env} from 'cloudflare:test';
import {describe,it,expect} from 'vitest';

/** These calls reach the isolated DO binding only; no user-facing HTTP route. */
async function rpc(name:string,op:string,fields:Record<string,unknown>={}){
  const id=env.SYNC_LEDGER.idFromName(name);
  const stub=env.SYNC_LEDGER.get(id);
  const res=await stub.fetch('https://internal.sync.test/rpc',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({op,...fields}),
  });
  return {status:res.status,data:await res.json() as Record<string,unknown>};
}
const noteA='INSES/M00-关系总览.md';
const noteB='INSES/P21-Dense-X-Retrieval.md';
const noteC='INSES/P08-HotpotQA.md';
const initial={[noteA]:'old relation R-P21-01',[noteB]:'old evidence R-P21-01',[noteC]:'old dataset'};
const rel=[{id:'R-P21-01',paths:[noteA,noteB]}];
const other=[{id:'separate',paths:[noteC]}];
const serial=()=>`test-${crypto.randomUUID().replaceAll('-','')}`;
function proposed(baseId:string,expectedHead:string,localFiles:Record<string,string>,groups:unknown,actor='agent'){
  return {baseId,expectedHead,localFiles,groups,actor,message:'synthetic revision'};
}

describe('isolated SQLite Durable Object and immutable R2 sync objects',()=>{
  it('bootstraps, persists both documents atomically and returns exact committed evidence',async()=>{
    const name=serial();
    const empty=await rpc(name,'status');
    expect(empty.status).toBe(200);expect(empty.data.headId).toBe(null);
    const created=await rpc(name,'bootstrap',{files:initial});
    if(created.status!==200)throw new Error(`Bootstrap returned ${JSON.stringify(created)}`);
    expect(created.status).toBe(200);
    const genesis=created.data.headId as string;
    expect(genesis).toMatch(/^[a-f0-9]{64}$/);
    const uploaded=await rpc(name,'push',{input:proposed(genesis,genesis,
      {...initial,[noteA]:'new relation',[noteB]:'new evidence'},rel)});
    expect(uploaded.status).toBe(200);
    expect(uploaded.data.status).toBe('published');
    const headId=uploaded.data.headId as string;
    const head=await rpc(name,'get',{id:headId});
    const commit=head.data.commit as {files:Record<string,string>;parents:string[]};
    expect(commit.parents).toEqual([genesis]);
    expect(commit.files[noteA]).toBe('new relation');
    expect(commit.files[noteB]).toBe('new evidence');
    const read=await rpc(name,'read_file',{id:headId,path:noteB});
    expect(read.status).toBe(200);expect(read.data.body).toBe('new evidence');
    const history=await rpc(name,'history');
    expect((history.data.history as unknown[]).length).toBe(2);
  });
  it('returns remote_advanced on old expected HEAD, with no pointer overwrite',async()=>{
    const name=serial();
    const genesis=(await rpc(name,'bootstrap',{files:initial})).data.headId as string;
    const newer=await rpc(name,'push',{input:proposed(genesis,genesis,{...initial,[noteC]:'updated'},other)});
    expect(newer.data.status).toBe('published');
    const stale=await rpc(name,'push',{input:proposed(genesis,genesis,{...initial,[noteA]:'wrong head'},rel,'local')});
    expect(stale.data.status).toBe('remote_advanced');
    expect((await rpc(name,'status')).data.headId).toBe(newer.data.headId);
  });
  it('protects related but distinct files with a semantic conflict',async()=>{
    const name=serial();
    const g=(await rpc(name,'bootstrap',{files:initial})).data.headId as string;
    const remote=await rpc(name,'push',{input:proposed(g,g,{...initial,[noteB]:'agent revised evidence'},rel)});
    const attempt=await rpc(name,'push',{input:proposed(g,remote.data.headId as string,{...initial,[noteA]:'local revised relation'},rel,'local')});
    expect(attempt.data.status).toBe('conflict');
    expect((await rpc(name,'status')).data.headId).toBe(remote.data.headId);
  });
  it('refuses a second genesis with different content and cannot reset history',async()=>{
    const name=serial();
    const first=await rpc(name,'bootstrap',{files:initial});
    expect(first.data.status).toBe('initialized');
    expect((await rpc(name,'bootstrap',{files:initial})).data.status).toBe('already_initialized');
    const bad=await rpc(name,'bootstrap',{files:{...initial,[noteA]:'malicious change'}});
    expect(bad.status).toBe(409);expect(bad.data.error).toBe('ALREADY_INITIALIZED');
  });
  it('never exposes live notebook through arbitrary non-POST or unrelated HTTP routes',async()=>{
    const name=serial();
    const stub=env.SYNC_LEDGER.get(env.SYNC_LEDGER.idFromName(name));
    const res=await stub.fetch('https://internal.sync.test/rpc',{method:'GET'});
    expect(res.status).toBe(405);
    const tooLarge=await stub.fetch('https://internal.sync.test/rpc',{method:'POST',body:'a'.repeat(750_000)});
    expect(tooLarge.status).toBe(413);
  });
  it('two concurrent R2 stages cannot both atomically publish over the same HEAD',async()=>{
    const name=serial();const genesis=(await rpc(name,'bootstrap',{files:initial})).data.headId as string;
    const submissions=await Promise.all([
      rpc(name,'push',{input:proposed(genesis,genesis,{...initial,[noteB]:'writer A'},rel)}),
      rpc(name,'push',{input:proposed(genesis,genesis,{...initial,[noteC]:'writer B'},other,'local')}),
    ]);
    expect(submissions.filter(r=>r.data.status==='published')).toHaveLength(1);
    expect(submissions.filter(r=>r.data.status==='remote_advanced')).toHaveLength(1);
    const hist=await rpc(name,'history');
    expect((hist.data.history as unknown[]).length).toBe(2);
  });
});