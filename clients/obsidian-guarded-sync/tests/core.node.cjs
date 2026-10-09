'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SyncError,hash,genesis,commit,threeWay,groupsForChanges,LocalEngine,diff,verifyCommit}=require('../src/core.js');
const A='INSES/M00-关系总览.md',B='INSES/P21-Dense-X-Retrieval.md',C='INSES/P08-HotpotQA.md';
const initial={[A]:'R-P21-01 link: old meaning',[B]:'### R-P21-01\nold evidence',[C]:'old dataset'};
function fakeVault(files){const x={...files},writes=[];return {files:x,writes,async remove(p,expected){if((x[p]??null)!==expected)throw new Error('WORKTREE_CHANGED_DURING_RECOVERY');delete x[p];writes.push({p,body:null});},async snapshot(){return structuredClone(x)},async write(p,body,expected){if(expected!==undefined&&(x[p]??null)!==expected)throw new Error('WORKTREE_CHANGED_DURING_APPLY');if(body===null)delete x[p];else x[p]=body;writes.push({p,body})}};}
function memoryStore(){let data=null;return {async read(){return data?structuredClone(data):null},async write(v){data=structuredClone(v);}};}
class Remote {
 constructor(files=initial){const g=genesis(files);this.commits={[g.id]:g};this.headId=g.id;this.calls=[];}
 async status(){return {headId:this.headId};}
 async get(id){if(!this.commits[id])throw new Error('unknown');return structuredClone(this.commits[id]);}
 async push(input){this.calls.push(input);if(input.expectedHead!==this.headId)return {status:'remote_advanced',headId:this.headId};
  const base=this.commits[input.baseId],head=this.commits[this.headId];
  const view=threeWay(base.files,input.localFiles,head.files,input.groups,[]);
  if(view.disposition==='blocked')return {status:'conflict',headId:this.headId,preview:view};
  if(!diff(head.files,view.merged).length)return {status:'already_current',headId:this.headId,preview:view};
  const next=commit(head,view.merged,input.actor,input.message,input.groups);
  this.commits[next.id]=next;this.headId=next.id;return {status:'published',headId:next.id,preview:view};
 }
 // An Agent write directly in the simulated isolated revision ledger.
 agentChange(updates,groups){const old=this.commits[this.headId];const next=commit(old,{...old.files,...updates},'agent','simulated agent review',groups);
 this.commits[next.id]=next;this.headId=next.id;return next;}
}
async function setup(files=initial){const vault=fakeVault(files),store=memoryStore(),remote=new Remote(files),client=new LocalEngine({vault,store,remote,vaultId:'test-vault'});await client.load();await client.initialize();return {client,vault,store,remote};}
const group=[{id:'relation:R-P21-01',paths:[A,B]}];

test('canonical local genesis agrees with server snapshot model',async()=>{
 const {makeGenesis}=await import('../../../src/sync/protocol.ts');
 assert.equal(genesis(initial).id,(await makeGenesis(initial)).id);
});
test('canonical local commit agrees with Phase A protocol',async()=>{
 const {makeCommit}=await import('../../../src/sync/protocol.ts');
 const parent=genesis(initial),files={...initial,[C]:'improved benchmark'},date='2026-10-09T09:00:00.000Z';
 const local=commit(parent,files,'local','test',[{id:'file:'+C,paths:[C]}],date);
 const remote=await makeCommit({parent,files,actor:'local',message:'test',groups:[{id:'file:'+C,paths:[C]}],createdAt:date});
 assert.equal(local.id,remote.id);assert.equal(hash(Object.fromEntries(Object.entries(local).filter(([k])=>k!=='id'))),local.id);
});
test('local initialization stores genesis outside remote without mutation',async()=>{const {client,remote,vault}=await setup();assert.equal(client.state.remoteHeadId,null);assert.equal(client.head().id,remote.headId);assert.deepEqual(vault.writes,[]);});
test('status records unstaged work without modifying HEAD',async()=>{
 const {client,vault}=await setup();vault.files[C]='new offline note';
 const status=await client.status();assert.deepEqual(status.unstaged.map(c=>c.path),[C]);
 assert.equal(status.staged.length,0);assert.equal(client.head().files[C],initial[C]);
});
test('stage snapshots exact bytes at staging time; later edits remain unstaged',async()=>{
 const {client,vault}=await setup();vault.files[C]='stage one';await client.stage([C]);vault.files[C]='stage two';
 const status=await client.status();assert.equal(status.staged[0].after,'stage one');
 assert.equal(status.unstaged[0].after,'stage two');
 const saved=await client.commit('capture first draft');assert.equal(saved.files[C],'stage one');
 await assert.rejects(()=>client.preparePush(),{code:'WORKTREE_DIRTY'});
});
test('no stage → no commit; invalid paths denied',async()=>{
 const {client}=await setup();await assert.rejects(()=>client.commit('not possible'),{code:'NOTHING_STAGED'});
 await assert.rejects(()=>client.stage(['../../secret.md']),{code:'INVALID_PATH'});
});
test('semantic relation groups link M00 and P21 across files',async()=>{
 const {client,vault}=await setup();vault.files[A]='R-P21-01 link: better relation';
 vault.files[B]='### R-P21-01\nupdated evidence';await client.stage([A,B]);
 const c=await client.commit('correct relationship',{...[]}.length?[]:['R-P21-01']);
 assert.ok(c.groups.some(g=>g.id==='relation:R-P21-01'&&g.paths.includes(A)&&g.paths.includes(B)));
 assert.ok(c.groups.some(g=>g.id.startsWith('batch:')));
});
test('unscoped edit under relation section fails closed rather than infer false independence',async()=>{
 const {client,vault}=await setup();vault.files[B]='### R-P21-01\nrewritten evidence body';
 // This line includes relation ID in unchanged heading; manually supplied ID needed.
 await client.stage([B]);await assert.rejects(()=>client.commit('unclear edit'),{code:'SEMANTIC_SCOPE_REQUIRED'});
 assert.equal(client.state.headId,genesis(initial).id);
 const saved=await client.commit('bounded review',['R-P21-01']);assert.equal(saved.groups[0].id,'relation:R-P21-01');
});
test('Fetch does not touch Obsidian working files',async()=>{
 const {client,vault,remote}=await setup();remote.agentChange({[C]:'cloud update'},[{id:'file:'+C,paths:[C]}]);
 const pre=structuredClone(vault.files),preview=await client.fetch();
 assert.deepEqual(vault.files,pre);assert.equal(preview.disposition,'fast_forward_remote');
});
test('Pull clean remote version with durable journal, includes checked readback',async()=>{
 const {client,vault,remote}=await setup();remote.agentChange({[C]:'cloud update'},[{id:'file:'+C,paths:[C]}]);await client.fetch();
 const next=await client.pull();assert.equal(next,remote.headId);assert.equal(vault.files[C],'cloud update');assert.equal(client.state.journal,null);
});
test('Pull always rejects dirty worktree, keeping every draft',async()=>{
 const {client,vault,remote}=await setup();remote.agentChange({[C]:'cloud update'},[{id:'file:'+C,paths:[C]}]);
 await client.fetch();vault.files[C]='unsaved local research';await assert.rejects(()=>client.pull(),{code:'WORKTREE_DIRTY'});
 assert.equal(vault.files[C],'unsaved local research');
});
test('Pull never accepts automatic remote deletion',async()=>{
 const {client,vault,remote}=await setup();const newFiles={...initial};delete newFiles[C];
 const next=commit(remote.commits[remote.headId],newFiles,'agent','delete',{...[]}.length?[]:[{id:'file:'+C,paths:[C]}]);
 remote.commits[next.id]=next;remote.headId=next.id;await client.fetch();
 await assert.rejects(()=>client.pull(),{code:'DELETE_NEEDS_MANUAL_REVIEW'});assert.equal(vault.files[C],initial[C]);
});
test('dirty fetch + remote advances causes same-file conflict with base/local/remote evidence',async()=>{
 const {client,vault,remote}=await setup();vault.files[C]='my new benchmark';await client.stage([C]);await client.commit('local');
 remote.agentChange({[C]:'agent new benchmark'},[{id:'file:'+C,paths:[C]}]);
 const view=await client.fetch();assert.equal(view.disposition,'blocked');
 assert.equal(view.conflicts[0].reason,'SAME_FILE_DIVERGED');assert.equal(view.conflicts[0].base[C],initial[C]);
 assert.equal(view.conflicts[0].local[C],'my new benchmark');assert.equal(view.conflicts[0].remote[C],'agent new benchmark');
 await assert.rejects(()=>client.merge(),{code:'MERGE_CONFLICT'});
});
test('cross-file same relation conflict even though files differ',async()=>{
 const {client,vault,remote}=await setup();vault.files[A]='R-P21-01 local relation fix';await client.stage([A]);await client.commit('relation fix');
 remote.agentChange({[B]:'### R-P21-01\nagent evidence'},group);
 const view=await client.fetch();assert.equal(view.disposition,'blocked');
 assert.ok(view.conflicts.some(c=>c.reason==='SEMANTIC_GROUP_OVERLAP'));
});
test('independent changes can be merged only by explicit user action',async()=>{
 const {client,vault,remote}=await setup();vault.files[C]='offline revision';await client.stage([C]);await client.commit('local');
 remote.agentChange({[A]:'R-P21-01 cloud relation'},group);
 const view=await client.fetch();assert.equal(view.disposition,'merge_ready');assert.equal(vault.files[A],initial[A]);
 // The merge changes only the independent local dataset relative to remote.
 const newHead=await client.merge();assert.equal(client.state.headId,newHead);
 assert.equal(vault.files[A],'R-P21-01 cloud relation');assert.equal(vault.files[C],'offline revision');
 assert.ok(client.state.commits[newHead].parents.includes(remote.headId));
});
test('Push requires review and no unstaged changes, then publishes with CAS',async()=>{
 const {client,vault,remote}=await setup();await client.fetch();vault.files[C]='my commit';
 await client.stage([C]);await client.commit('write local');
 await assert.rejects(()=>client.push('fake'),{code:'PUSH_REVIEW_REQUIRED'});
 const pre=await client.preparePush();assert.equal(pre.status,'ready');
 const result=await client.push(pre.key);assert.equal(result.status,'published');
 assert.equal(remote.commits[remote.headId].files[C],'my commit');assert.equal(client.state.headId,remote.headId);
});
test('Push rejects a remote HEAD changed since preview (no stale publish)',async()=>{
 const {client,vault,remote}=await setup();await client.fetch();vault.files[C]='mine';await client.stage([C]);await client.commit('local');
 const pre=await client.preparePush();remote.agentChange({[A]:'R-P21-01 newer'},group);
 await assert.rejects(()=>client.push(pre.key),{code:'REMOTE_ADVANCED_FETCH_FIRST'});
 assert.equal(remote.commits[remote.headId].files[C],initial[C]);
});
test('Push disallows staging of stale working copy after commit',async()=>{
 const {client,vault}=await setup();await client.fetch();vault.files[C]='old draft';await client.stage([C]);
 await client.commit('committed');vault.files[C]='future draft';
 await assert.rejects(()=>client.preparePush(),{code:'WORKTREE_DIRTY'});
});
test('copy never overwrites unstaged files on fetch (not even different paths)',async()=>{
 const {client,vault,remote}=await setup();vault.files[B]='offline uncommitted note';
 remote.agentChange({[C]:'cloud update'},[{id:'file:'+C,paths:[C]}]);await client.fetch();
 assert.deepEqual(vault.writes,[]);assert.equal(vault.files[B],'offline uncommitted note');
});
test('partial pull leaves durable journal and blocks later operations until recovery',async()=>{
 const {client,vault,remote}=await setup();remote.agentChange({[A]:'R-P21-01 cloud fix',[C]:'cloud bench'},[{id:'batch:cloud',paths:[A,C]},{id:'relation:R-P21-01',paths:[A,B]}]);
 await client.fetch();const original=vault.write;let call=0;
 vault.write=async(p,c)=>{if(++call===2)throw new Error('synthetic_disk_error');return original(p,c)};
 await assert.rejects(()=>client.pull(),{code:'RECOVERY_REQUIRED'});
 assert.ok(client.state.journal);await assert.rejects(()=>client.stage([C]),{code:'RECOVERY_REQUIRED'});
 vault.write=original;
 await client.rollbackJournal();assert.equal(client.state.journal,null);
 assert.deepEqual(vault.files,initial);
});
test('journal survives simulated restart and can finish forward if all bytes match',async()=>{
 const {client,vault,store,remote}=await setup();remote.agentChange({[C]:'cloud bench'},[{id:'file:'+C,paths:[C]}]);
 await client.fetch();const prior=client.persist.bind(client);let skipped=false;
 client.persist=async()=>{if(client.state?.journal===null&&!skipped){skipped=true;throw new Error('simulated fsync after apply');}return prior();};
 // The simulated failure occurs before the state clears; the stored journal remains.
 await assert.rejects(()=>client.pull(),{code:'RECOVERY_REQUIRED'});
 const restarted=new LocalEngine({vault,store,remote,vaultId:'test-vault'});await restarted.load();
 assert.ok(restarted.state.journal);const head=await restarted.finalizeJournal();assert.equal(head,remote.headId);
});
test('journal refuses unsafe rollback over foreign in-flight work',async()=>{
 const {client,vault,remote}=await setup();remote.agentChange({[A]:'R-P21-01 cloud',[C]:'cloud'},[{id:'batch:cloud',paths:[A,C]},{id:'relation:R-P21-01',paths:[A,B]}]);await client.fetch();
 let count=0;const original=vault.write;vault.write=async(p,c)=>{if(++count>1)throw new Error('fail');return original(p,c)};
 await assert.rejects(()=>client.pull(),{code:'RECOVERY_REQUIRED'});vault.files[A]='foreign author overwrote after failure';
 await assert.rejects(()=>client.rollbackJournal(),{code:'JOURNAL_EXTERNAL_CHANGE'});
});
test('remote history missing common genesis aborts without corrupting working copy',async()=>{
 const {client,vault,remote}=await setup();remote.commits={};const unrelated=genesis({[C]:'some other seed'});remote.commits[unrelated.id]=unrelated;remote.headId=unrelated.id;
 await assert.rejects(()=>client.fetch(),{code:'UNRELATED_HISTORY'});
 assert.equal(client.state.remoteHeadId,null);assert.deepEqual(vault.files,initial);
});
test('no HTTP token is ever included in the local state schema',async()=>{
 const {client}=await setup();assert.deepEqual(Object.keys(client.state).sort(),['commits','headId','journal','remoteHeadId','review','schema','staged','vaultId'].sort());
});

test('interrupted pull that created a new note can safely trash that note only in owner-reviewed recovery',async()=>{
 const {client,vault,remote}=await setup();const N='INSES/NEW-RESEARCH.md';
 const originalRemote=remote.commits[remote.headId];
 const incoming=commit(originalRemote,{...originalRemote.files,[N]:'# brand new', [C]:'remote dataset'},'agent','new with second file',
 [{id:'batch:new',paths:[N,C]}]);
 remote.commits[incoming.id]=incoming;remote.headId=incoming.id;await client.fetch();
 const ordinary=vault.write;let count=0;
 vault.write=async(p,body,expected)=>{if(++count===2)throw Error('disk failure');return ordinary(p,body,expected)};
 await assert.rejects(()=>client.pull(),{code:'RECOVERY_REQUIRED'});
 assert.equal(vault.files[N],'# brand new');
 // The new file was created before the second write failed. The manual
 // recovery path must trash it only if its exact contents still match.
 vault.write=ordinary;await client.rollbackJournal();assert.deepEqual(vault.files,initial);
});
