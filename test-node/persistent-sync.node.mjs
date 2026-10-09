import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SyncObjectStore, blobKey, commitKey } from '../src/sync/object-store.ts';
import { SqliteSyncLedger } from '../src/sync/sqlite-ledger.ts';
import { makeGenesis, makeCommit, hashCanonical, SafeSyncError } from '../src/sync/protocol.ts';

// Real SQLite transactional behavior without Cloudflare or network access.
class DbAdapter {
  constructor(db=new DatabaseSync(':memory:')){this.db=db;this.sql={exec:(query,...args)=>{
    const q=query.trim();
    const stmt=db.prepare(q);
    if(/^SELECT\b/i.test(q))return {toArray:()=>stmt.all(...args),rowsWritten:0};
    const r=stmt.run(...args);
    return {toArray:()=>[],rowsWritten:Number(r.changes)};
  }};}
  transactionSync(fn){this.db.exec('BEGIN IMMEDIATE');try{const x=fn();this.db.exec('COMMIT');return x;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
class FakeR2 {
  constructor(map=new Map()){this.data=map;this.failPutAt=0;this.writes=0;this.failReadAt=0;this.reads=0;}
  async put(key,value,opts){
    this.writes++;
    if(this.failPutAt===this.writes)throw Error('R2 connection lost');
    if(this.data.has(key))return null;
    assert.equal(opts?.onlyIf?.get('If-None-Match'),'*');
    this.data.set(key,value);
    return {etag:'synthetic'};
  }
  async get(key){this.reads++;if(this.reads===this.failReadAt)throw Error('R2 get failed');
    return this.data.has(key)?{text:async()=>this.data.get(key)}:null;}
}
const A='INSES/M00-关系总览.md';
const B='INSES/P21-Dense-X-Retrieval.md';
const C='INSES/P08-HotpotQA.md';
const base={[A]:'edge original R-P21-01',[B]:'evidence original R-P21-01',[C]:'dataset original'};
const relation={id:'R-P21-01',paths:[A,B]};
const dataset={id:'independent-dataset',paths:[C]};
const msg='Synthetic data only';
const make=()=>{const db=new DbAdapter(),bucket=new FakeR2();return {db,bucket,ledger:new SqliteSyncLedger(db,new SyncObjectStore(bucket))};};
async function genesis(system,files=base){return (await system.ledger.bootstrap(files)).headId;}
async function push(system,{baseId,expectedHead,files,groups=[relation],actor='agent'}={}){
  return system.ledger.push({baseId,expectedHead,localFiles:files,groups,actor,message:msg});
}
async function rejectCode(f,code){await assert.rejects(f,e=>e instanceof SafeSyncError && e.code===code);}

test('bootstrap creates a persistent SQLite ref and isolated immutable R2 blobs/tree/commit',async()=>{
  const x=make(),g=await genesis(x);
  assert.equal(x.ledger.headId(),g);
  assert.ok(x.bucket.data.has(commitKey(g)));
  assert.ok(x.bucket.data.has(blobKey(await hashCanonical(base[A]))));
  assert.deepEqual((await x.ledger.head()).files,base);
  assert.equal(await x.ledger.fileAt(g,A),base[A]);
  assert.equal(await x.ledger.fileAt(g,'INSES/missing.md'),null);
});
test('SQLite rows survive re-instantiating the gateway and simulated R2 process restart',async()=>{
  const x=make(),g=await genesis(x);
  const recreated=new SqliteSyncLedger(x.db,new SyncObjectStore(new FakeR2(x.bucket.data)));
  assert.equal(recreated.headId(),g);
  assert.equal((await recreated.get(g)).id,g);
});
test('same genesis is idempotent, different snapshot or later history cannot reset HEAD',async()=>{
  const x=make(),g=await genesis(x);
  assert.deepEqual(await x.ledger.bootstrap(base),{status:'already_initialized',headId:g});
  await rejectCode(()=>x.ledger.bootstrap({...base,[A]:'changed'}),'ALREADY_INITIALIZED');
  await push(x,{baseId:g,expectedHead:g,files:{...base,[C]:'agent update'},groups:[dataset]});
  await rejectCode(()=>x.ledger.bootstrap(base),'ALREADY_INITIALIZED');
});
test('an entire multi-note relation change publishes as one revision',async()=>{
  const x=make(),g=await genesis(x),files={...base,[A]:'new semantics',[B]:'new supporting evidence'};
  const r=await push(x,{baseId:g,expectedHead:g,files});
  assert.equal(r.status,'published');
  assert.equal(x.ledger.headId(),r.headId);
  assert.equal((await x.ledger.head()).changes.length,2);
  assert.equal((await x.ledger.head()).files[B],files[B]);
  assert.equal((await x.ledger.history()).length,2);
});
test('conflicts in the same file or cross-note semantic group block publication',async()=>{
  const x=make(),g=await genesis(x);
  const first=await push(x,{baseId:g,expectedHead:g,files:{...base,[B]:'Agent evidence edit'}});
  const second=await push(x,{baseId:g,expectedHead:first.headId,files:{...base,[A]:'Mac edge edit'},actor:'local'});
  assert.equal(second.status,'conflict');
  assert.ok(second.preview.conflicts.some(c=>c.reason==='SEMANTIC_GROUP_OVERLAP'));
  assert.equal(x.ledger.headId(),first.headId);
  const same=await push(x,{baseId:g,expectedHead:first.headId,files:{...base,[B]:'Mac other evidence'},actor:'local'});
  assert.equal(same.status,'conflict');
  assert.ok(same.preview.conflicts.some(c=>c.reason==='SAME_FILE_DIVERGED'));
});
test('diverged commits affecting unrelated files merge safely',async()=>{
  const x=make(),g=await genesis(x);
  const remote=await push(x,{baseId:g,expectedHead:g,files:{...base,[C]:'remote'},groups:[dataset]});
  const merged=await push(x,{baseId:g,expectedHead:remote.headId,files:{...base,[B]:'local'},actor:'local'});
  assert.equal(merged.status,'published');
  const body=(await x.ledger.head()).files;
  assert.equal(body[B],'local');assert.equal(body[C],'remote');
});
test('remote changes across multiple revisions use full ancestry of semantic groups',async()=>{
  const x=make(),g=await genesis(x);
  const one=await push(x,{baseId:g,expectedHead:g,files:{...base,[B]:'agent evidence'}});
  const two=await push(x,{baseId:one.headId,expectedHead:one.headId,files:{...base,[B]:'agent evidence',[C]:'agent independent'},groups:[dataset]});
  const collide=await push(x,{baseId:g,expectedHead:two.headId,files:{...base,[A]:'local relation'}});
  assert.equal(collide.status,'conflict');
});
test('stale remote head prevents overwrites, no commit row is created',async()=>{
  const x=make(),g=await genesis(x);
  const head=await push(x,{baseId:g,expectedHead:g,files:{...base,[C]:'new'},groups:[dataset]});
  const r=await push(x,{baseId:g,expectedHead:g,files:{...base,[A]:'old head edit'}});
  assert.equal(r.status,'remote_advanced');
  assert.equal(x.ledger.headId(),head.headId);
  assert.equal((await x.ledger.history()).length,2);
});
test('concurrent async upload stages cannot both CAS HEAD',async()=>{
  const x=make(),g=await genesis(x);
  const first=push(x,{baseId:g,expectedHead:g,files:{...base,[C]:'writer1'},groups:[dataset]});
  const second=push(x,{baseId:g,expectedHead:g,files:{...base,[B]:'writer2'},actor:'local'});
  const results=await Promise.all([first,second]);
  assert.equal(results.filter(r=>r.status==='published').length,1);
  assert.equal(results.filter(r=>r.status==='remote_advanced').length,1);
  assert.equal((await x.ledger.history()).length,2);
});
test('R2 crash before staged objects finish leaves old HEAD',async()=>{
  const x=make(),g=await genesis(x),before=x.ledger.headId();
  x.bucket.failPutAt=x.bucket.writes+2;
  await assert.rejects(push(x,{baseId:g,expectedHead:g,files:{...base,[B]:'crashing commit'}}));
  assert.equal(x.ledger.headId(),before);
  assert.equal((await x.ledger.history()).length,1);
  assert.deepEqual((await x.ledger.head()).files,base);
});
test('an orphaned immutable object cannot create a published commit',async()=>{
  const x=make(),g=await genesis(x);
  const commit=await makeCommit({parent:await x.ledger.head(),files:{...base,[B]:'orphan'},actor:'agent',message:msg});
  await new SyncObjectStore(x.bucket).putRevision(commit);
  assert.equal(x.ledger.headId(),g);
  await rejectCode(()=>x.ledger.get(commit.id),'UNKNOWN_REVISION');
});
test('immutable object corruption is detected on read, never silently returned',async()=>{
  const x=make(),g=await genesis(x);
  x.bucket.data.set(commitKey(g),'{}');
  await rejectCode(()=>x.ledger.get(g),'COMMIT_INTEGRITY_ERROR');
});
test('a content-addressed collision is rejected rather than overwritten',async()=>{
  const x=make();
  x.bucket.data.set(blobKey(await hashCanonical(base[A])),'different bytes');
  await rejectCode(()=>x.ledger.bootstrap(base),'IMMUTABLE_OBJECT_CONFLICT');
  assert.equal(x.ledger.headId(),null);
});
test('unknown ancestry refuses merge instead of guessing common parent',async()=>{
  const x=make(),g=await genesis(x);
  const unrelated=await makeGenesis({[A]:'other repo'});
  await rejectCode(()=>push(x,{baseId:unrelated.id,expectedHead:g,files:base}),'UNKNOWN_REVISION');
});
test('commit identifier proves entire note bytes and parent before publishing',async()=>{
  const x=make(),g=await genesis(x),c=await makeCommit({parent:await x.ledger.head(),files:{...base,[C]:'new'},actor:'agent',message:msg,groups:[dataset]});
  const staged=await new SyncObjectStore(x.bucket).putRevision(c);
  assert.equal(staged.commitId,c.id);
  assert.equal(x.ledger.headId(),g);
  assert.ok(staged.treeId.match(/^[a-f0-9]{64}$/));
});