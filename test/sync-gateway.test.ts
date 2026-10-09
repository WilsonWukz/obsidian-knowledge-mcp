import {env} from 'cloudflare:test';
import {describe,it,expect} from 'vitest';
import {handleGuardedSync} from '../src/sync/gateway';
import {makeGenesis} from '../src/sync/protocol';
import {syncRpc} from '../src/sync/rpc';
import {planVersionedChanges,applyVersionedChanges} from '../src/sync/reviewed';
import {planStoreCall,type StoredPlan} from '../src/review/store';
import AuthHandler from '../src/auth/handler';
import {makeReadableVault} from '../src/sync/read-vault';
import {buildVaultConfig} from '../src/config';
const token='synthetic-test-token-0123456789-abcdef-0123456789';
const M='INSES/M00-关系总览.md',P='INSES/P21-Evidence.md',D='INSES/Benchmark.md';
const initial={[M]:'- [[P21#^R-P21-01]]：旧关系',[P]:'### R-P21-01\n初始证据',[D]:'Dataset old'};
function config(other:Record<string,unknown>={}):Env{
 return {...env,ENABLE_GUARDED_SYNC:'true',ENABLE_GUARDED_SYNC_API:'true',
  GUARDED_SYNC_CUTOVER:'false',ENABLE_SYNC_ADOPTION:'false',
  SYNC_OWNER_TOKEN:token,...other} as unknown as Env;
}
function request(op:string,fields:Record<string,unknown>={},bearer=token,url='https://vault.test/sync/v1'){
 return new Request(url,{method:'POST',headers:{'content-type':'application/json',
  authorization:'Bearer '+bearer},body:JSON.stringify({op,...fields})});
}
async function send(op:string,fields:Record<string,unknown>={},bearer=token,e=config()){
 const result=await handleGuardedSync(request(op,fields,bearer),e);
 return {status:result.status,body:await result.json() as Record<string,unknown>,headers:result.headers};
}
describe('owner authenticated guarded sync gateway',()=>{
 it('is default-closed, rejects wrong token and plaintext, omits caching',async()=>{
  expect((await send('status',{},token,config({ENABLE_GUARDED_SYNC_API:'false'}))).status).toBe(404);
  expect((await send('status',{},'invalid')).status).toBe(401);
  const plain=await handleGuardedSync(request('status',{},token,'http://vault.test/sync/v1'),config());
  expect(plain.status).toBe(403);
  const ok=await send('status');
  expect(ok.status).toBe(200);
  expect(ok.body.mode).toBe('isolated_test');
  expect(ok.headers.get('cache-control')).toBe('no-store');
  // Exercise the actual default OAuth fallback route, not only the helper.
  const routed=await AuthHandler.fetch(request('status'),config());
  expect(routed.status).toBe(200);
  expect((await routed.json() as {mode:string}).mode).toBe('isolated_test');
  expect(()=>makeReadableVault(config({GUARDED_SYNC_CUTOVER:'true',
    ENABLE_GUARDED_SYNC:'false'}),buildVaultConfig(config()))).toThrow();
 });
 it('denies direct public bootstrap, privileged file read and adoption unless explicitly enabled',async()=>{
  expect((await send('bootstrap',{files:initial})).status).toBe(403);
  expect((await send('read_file',{id:'0'.repeat(64),path:M})).status).toBe(403);
  expect((await send('adopt_legacy_vault',{expectedGenesisId:'0'.repeat(64),ack:'I_HAVE_DISABLED_LEGACY_WRITERS'})).status).toBe(403);
 });
 it('publishes Mac actor only and rejects stale HEAD and hidden semantic conflicts',async()=>{
  const e=config(),genesis=await makeGenesis(initial);
  const start=await syncRpc<{headId:string}>(e,'bootstrap',{files:initial});
  expect(start.headId).toBe(genesis.id);
  const mac=await send('push',{input:{baseId:genesis.id,expectedHead:genesis.id,
    localFiles:{...initial,[D]:'Mac fixed dataset'},actor:'agent',
    groups:[{id:'fake',paths:[D]}],message:'Mac synthetic commit'}});
  expect(mac.body.status).toBe('published');
  const fetched=await send('get',{id:mac.body.headId});
  expect((fetched.body.commit as {actor:string}).actor).toBe('local');
  const stale=await send('push',{input:{baseId:genesis.id,expectedHead:genesis.id,
    localFiles:{...initial,[P]:'### R-P21-01\nstale evidence'},message:'outdated'}});
  expect(stale.body.status).toBe('remote_advanced');
  const agent=await syncRpc<{headId:string;status:string}>(e,'push',{input:{
   baseId:mac.body.headId,expectedHead:mac.body.headId,
   localFiles:{...initial,[D]:'Mac fixed dataset',[P]:'### R-P21-01\nAgent revised evidence'},
   actor:'agent',groups:[{id:'false',paths:[P]}],message:'synthetic Agent',
  }});
  expect(agent.status).toBe('published');
  const conflict=await send('push',{input:{baseId:mac.body.headId,expectedHead:agent.headId,
    localFiles:{...initial,[D]:'Mac fixed dataset',
      [M]:'- [[P21#^R-P21-01]]：Mac changed meaning'},
    groups:[{id:'fake-incomplete',paths:[M]}],message:'semantic disjoint-file conflict'}});
  expect(conflict.body.status).toBe('conflict');
  expect((conflict.body.preview as {conflicts:Array<{reason:string}>}).conflicts
   .some(x=>x.reason==='SEMANTIC_GROUP_OVERLAP')).toBe(true);
 });
 it('Agent cannot publish without separate approval; approved plan commits atomically and idempotently',async()=>{
  const e=config({GUARDED_SYNC_CUTOVER:'true'});
  const before=(await syncRpc<{headId:string}>(e,'status')).headId;
  const plan=await planVersionedChanges(e,[{
   action:'patch_note',path:D,old_text:'Mac fixed dataset',new_text:'Owner-approved dataset',
  }]);
  expect(plan.status).toBe('pending');
  await expect(applyVersionedChanges(e,plan.plan_id,plan.digest))
   .rejects.toMatchObject({code:'OWNER_APPROVAL_REQUIRED'});
  const approved=await planStoreCall<StoredPlan>(e,'approve',{id:plan.plan_id,digest:plan.digest});
  expect(approved.status).toBe('approved');
  const applied=await applyVersionedChanges(e,plan.plan_id,plan.digest);
  expect(applied.status).toBe('applied');
  const after=(await syncRpc<{headId:string}>(e,'status')).headId;
  expect(after).not.toBe(before);
  const note=await syncRpc<{commit:{files:Record<string,string>}}>(e,'get',{id:after});
  expect(note.commit.files[D]).toBe('Owner-approved dataset');
  expect((await applyVersionedChanges(e,plan.plan_id,plan.digest)).status).toBe('applied');
  // Even a valid owner token cannot delete a managed paper by omitting it
  // from the full-tree payload. Deletion requires a separate future protocol.
  const { [D]:removed, ...withoutDataset }=note.commit.files;
  const denied=await send('push',{input:{baseId:after,expectedHead:after,
    localFiles:withoutDataset,message:'malicious or accidental deletion'}});
  expect(denied.status).toBe(409);
  expect(denied.body.error).toBe('DELETE_NEEDS_MANUAL_REVIEW');
 });
});
