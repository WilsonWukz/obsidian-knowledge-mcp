import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  SafeSyncError,validateManagedPath,validateSnapshot,validateGroups,
  makeGenesis,makeCommit,verifyCommit,hashCanonical,threeWayMerge,
  diffSnapshots,previewPush,MAX_NOTE_BYTES,
} from '../src/sync/protocol.ts';
import {ReferenceLedger} from '../src/sync/reference-ledger.ts';
const A='INSES/M00-关系总览.md';
const B='INSES/P21-Dense-X-Retrieval.md';
const C='INSES/P22-Iterative-Retrieval.md';
const D='INSES/Notes/Extra.md';
const base={[A]:'R-P21: used as retrieval background\n',[B]:'Original evidence quote\n',[C]:'Unrelated baseline\n'};
const relation={id:'R-P21-01',paths:[A,B]};
const other={id:'R-P22-01',paths:[C]};
const date='2026-10-09T07:33:00.000Z';

function errCode(fn,code){assert.throws(fn,e=>e?.code===code);}
async function rejected(promise,code){await assert.rejects(promise,e=>e?.code===code);}

test('scope rejects hidden files, traversal, encoded separators, percent slash and other subtrees',()=>{
  for(const p of ['Graph.md','Other/N.md','INSES/../a.md','INSES/.obsidian/key.md','INSES/a//b.md',
      'INSES/a%2fb.md','INSES/a\\b.md','INSES/a.md/','INSES/a.txt', 'INSES/\u0001.md',
      'INSES/./b.md'])errCode(()=>validateManagedPath(p),'INVALID_PATH');
  assert.doesNotThrow(()=>validateManagedPath(B));
});
test('prevents huge notes and unsafe bodies',()=>{
  errCode(()=>validateSnapshot({[B]:'a'.repeat(MAX_NOTE_BYTES+1)}),'INVALID_CONTENT');
  errCode(()=>validateSnapshot({[B]:42}),'INVALID_CONTENT');
});
test('snapshot diff preserves create/edit/delete exact before and after',()=>{
  const changes=diffSnapshots({[A]:'before',[B]:'deleted'},{[A]:'after',[C]:'new'});
  assert.deepEqual(changes,[{path:A,before:'before',after:'after'},{path:B,before:'deleted',after:null},{path:C,before:null,after:'new'}]);
});
test('initial adoption hashes existing vault without modifying files or 5-file limit',async()=>{
  const files=Object.fromEntries(Array.from({length:30},(_,i)=>[`INSES/P${String(i+1).padStart(2,'0')}.md`,'# Paper']));
  const copy=JSON.stringify(files),g=await makeGenesis(files,date);
  assert.equal(Object.keys(g.files).length,30);
  assert.equal(g.changes.length,0);
  assert.equal(g.parents.length,0);
  assert.equal(JSON.stringify(files),copy);
  await verifyCommit(g,null);
});
test('makes stable content-addressed commits with exact parent and path group',async()=>{
  const initial=await makeGenesis(base,date);
  const files={...base,[A]:'R-P21: interpretation corrected',[B]:'Evidence adjusted'};
  const args={parent:initial,files,actor:'local',message:'Correct relationship semantics',groups:[relation],createdAt:date};
  const commit=await makeCommit(args);
  assert.equal(commit.id,(await makeCommit(args)).id);
  assert.deepEqual(commit.parents,[initial.id]);
  assert.equal(commit.changes.length,2);
  assert.deepEqual(commit.groups,[relation]);
  await verifyCommit(commit,initial);
  const changed=structuredClone(commit);changed.files[A]='malicious silent rewrite';
  await rejected(verifyCommit(changed,initial),'COMMIT_INTEGRITY_ERROR');
});
test('two-file change without semantic group cannot commit',async()=>{
  const parent=await makeGenesis(base);
  await rejected(makeCommit({parent,files:{...base,[A]:'new',[B]:'new'},actor:'local',message:'multi file'}),'GROUP_REQUIRED');
});
test('rejects unrelated or duplicate groups; guards path scope of group members',()=>{
  errCode(()=>validateGroups([{id:'R-P21',paths:[D]}],[B]),'UNTOUCHED_GROUP');
  errCode(()=>validateGroups([{id:'R',paths:[B]},{id:'R',paths:[B]}],[B]),'DUPLICATE_GROUP');
  errCode(()=>validateGroups([{id:'R',paths:['../secret.md']}],[B]),'INVALID_PATH');
});
test('commit limits prevent large mass mutation and accidental no-op revision',async()=>{
  const g=await makeGenesis({});
  const many=Object.fromEntries(Array.from({length:6},(_,i)=>[`INSES/P${i}.md`,'new']));
  await rejected(makeCommit({parent:g,files:many,actor:'local',message:'mass',groups:[{id:'R',paths:Object.keys(many)}]}),'TOO_MANY_FILES');
  await rejected(makeCommit({parent:g,files:{},actor:'local',message:'empty'}),'NO_OP');
});
test('same-file Mac/Agent changes block with exact base/ours/theirs, never overwrite',()=>{
  const local={...base,[A]:'Mac relation explanation'};
  const remote={...base,[A]:'Agent relation explanation'};
  const preview=threeWayMerge(base,local,remote,[relation],[relation]);
  assert.equal(preview.disposition,'blocked');assert.equal(preview.merged,null);
  assert.equal(preview.conflicts[0].reason,'SAME_FILE_DIVERGED');
  assert.equal(preview.conflicts[0].base[A],base[A]);
  assert.equal(preview.conflicts[0].local[A],local[A]);
  assert.equal(preview.conflicts[0].remote[A],remote[A]);
});
test('different files within the SAME relation group must also block',()=>{
  const local={...base,[A]:'Mac updates the semantic relation edge'};
  const remote={...base,[B]:'Agent updates its corresponding evidence note'};
  const preview=threeWayMerge(base,local,remote,[relation],[relation]);
  assert.equal(preview.disposition,'blocked');assert.equal(preview.merged,null);
  assert.ok(preview.conflicts.some(c=>c.reason==='SEMANTIC_GROUP_OVERLAP'&&c.groupId==='R-P21-01'));
  assert.deepEqual(preview.conflicts.find(c=>c.groupId==='R-P21-01').paths,[A,B]);
});
test('independent changes to independent groups can be merged without losing either',()=>{
  const local={...base,[B]:'Mac revision'};
  const remote={...base,[C]:'Agent version'};
  const preview=threeWayMerge(base,local,remote,[relation],[other]);
  assert.equal(preview.disposition,'merge_ready');
  assert.equal(preview.merged[B],'Mac revision');assert.equal(preview.merged[C],'Agent version');
  assert.equal(preview.merged[A],base[A]);
});
test('semantically overlapping paths block even if relation IDs differ',()=>{
  const local={...base,[A]:'local'};
  const remote={...base,[B]:'remote'};
  const preview=threeWayMerge(base,local,remote,[relation],[{id:'review-2026',paths:[A,B]}]);
  assert.equal(preview.disposition,'blocked');
});
test('both sides making an IDENTICAL edit to same file is safe',()=>{
  const current={...base,[A]:'identical update'};
  const preview=threeWayMerge(base,current,current,[relation],[relation]);
  assert.notEqual(preview.disposition,'blocked');
  assert.deepEqual(preview.merged,current);
});
test('delete-modify conflict blocks instead of reviving stale content',()=>{
  const local={...base};delete local[B];
  const remote={...base,[B]:'Agent replacement'};
  const preview=threeWayMerge(base,local,remote,[relation],[relation]);
  assert.equal(preview.disposition,'blocked');assert.equal(preview.conflicts[0].local[B],null);
});
test('both sides delete the same file is unambiguous',()=>{
  const local={...base};delete local[B];
  const preview=threeWayMerge(base,local,local,[relation],[relation]);
  assert.equal(preview.disposition,'merge_ready');
  assert.ok(!(B in preview.merged));
});
test('never mutates caller inputs while checking a merge',()=>{
  const a=JSON.stringify(base),local={...base,[B]:'text'},r=JSON.stringify(local);
  threeWayMerge(base,local,base,[relation],[]);
  assert.equal(JSON.stringify(base),a);assert.equal(JSON.stringify(local),r);
});
test('no-change and pull-only cases are distinguished',()=>{
  assert.equal(threeWayMerge(base,base,base).disposition,'unchanged');
  assert.equal(threeWayMerge(base,base,{...base,[C]:'cloud'}).disposition,'fast_forward_remote');
  assert.equal(threeWayMerge(base,{...base,[B]:'local'},base).disposition,'fast_forward_local');
});
test('a push preview must know the full remote lineage, not just latest commit group',async()=>{
  const g=await makeGenesis(base);
  const a=await makeCommit({parent:g,files:{...base,[C]:'first'},actor:'agent',message:'cloud one'});
  const b=await makeCommit({parent:a,files:{...a.files,[B]:'second'},actor:'agent',message:'cloud two'});
  const local=await makeCommit({parent:g,files:{...base,[A]:'Mac'},actor:'local',message:'Mac edit'});
  errCode(()=>previewPush({base:g,local,remote:b}),'REMOTE_LINEAGE_UNVERIFIED');
});
test('reference gateway publishes one atomic commit for two changed files',async()=>{
  const ledger=await ReferenceLedger.bootstrap(base),before=ledger.head();
  const outcome=await ledger.push({baseId:before.id,expectedHead:before.id,
    localFiles:{...base,[A]:'corrected relationship',[B]:'corrected evidence'},
    groups:[relation],actor:'local',message:'Update relationship and evidence together'});
  assert.equal(outcome.status,'published');assert.equal(ledger.size,2);
  assert.equal(ledger.head().changes.length,2);
  assert.equal(ledger.head().files[A],'corrected relationship');
  assert.equal(ledger.head().files[B],'corrected evidence');
});
test('cloud change between read and push returns remote_advanced and preserves head',async()=>{
  const ledger=await ReferenceLedger.bootstrap(base),initial=ledger.head();
  await ledger.push({baseId:initial.id,expectedHead:initial.id,
    localFiles:{...base,[C]:'agent changed'},groups:[other],actor:'agent',message:'Agent update'});
  const actual=ledger.head();
  const result=await ledger.push({baseId:initial.id,expectedHead:initial.id,
    localFiles:{...base,[B]:'Mac edit'},groups:[relation],actor:'local',message:'offline change'});
  assert.equal(result.status,'remote_advanced');
  assert.equal(ledger.head().id,actual.id);
});
test('cloud multiple commits since base: accumulated semantic groups prevent unrecognized conflict',async()=>{
  const ledger=await ReferenceLedger.bootstrap(base),g=ledger.head();
  const first=await ledger.push({baseId:g.id,expectedHead:g.id,
    localFiles:{...base,[B]:'Agent changed original evidence'},groups:[relation],actor:'agent',message:'Agent evidence'});
  assert.equal(first.status,'published');
  const firstHead=ledger.head();
  const second=await ledger.push({baseId:firstHead.id,expectedHead:firstHead.id,
    localFiles:{...firstHead.files,[C]:'Other unrelated agent edit'},groups:[other],actor:'agent',message:'Agent unrelated'});
  assert.equal(second.status,'published');
  const before=ledger.head().id;
  const local=await ledger.push({baseId:g.id,expectedHead:before,
    localFiles:{...base,[A]:'Mac relation semantic edit'},groups:[relation],actor:'local',message:'Mac change'});
  assert.equal(local.status,'conflict');
  assert.equal(ledger.head().id,before);
  assert.ok(local.preview.conflicts.some(c=>c.reason==='SEMANTIC_GROUP_OVERLAP'));
});
test('reference gateway merges disjoint offline changes while preserving both',async()=>{
  const ledger=await ReferenceLedger.bootstrap(base),g=ledger.head();
  const r=await ledger.push({baseId:g.id,expectedHead:g.id,
    localFiles:{...base,[C]:'Agent revised C'},groups:[other],actor:'agent',message:'Cloud revision'});
  assert.equal(r.status,'published');
  const expected=ledger.head().id;
  const m=await ledger.push({baseId:g.id,expectedHead:expected,
    localFiles:{...base,[B]:'Mac revised B'},groups:[relation],actor:'local',message:'Local revision'});
  assert.equal(m.status,'published');
  assert.equal(ledger.head().files[B],'Mac revised B');
  assert.equal(ledger.head().files[C],'Agent revised C');
  assert.equal(m.preview.disposition,'merge_ready');
});
test('stale push cannot override a newer unrelated commit',async()=>{
  const ledger=await ReferenceLedger.bootstrap(base),g=ledger.head();
  const p1=ledger.push({baseId:g.id,expectedHead:g.id,
    localFiles:{...base,[B]:'writer1'},groups:[relation],actor:'local',message:'Writer1'});
  const p2=ledger.push({baseId:g.id,expectedHead:g.id,
    localFiles:{...base,[C]:'writer2'},groups:[other],actor:'agent',message:'Writer2'});
  const [one,two]=await Promise.all([p1,p2]);
  assert.equal([one.status,two.status].filter(s=>s==='published').length,1);
  assert.equal([one.status,two.status].filter(s=>s==='remote_advanced').length,1);
  assert.equal(ledger.size,2);
});
test('reference gateway refuses unrelated history before publishing',async()=>{
  const ledger=await ReferenceLedger.bootstrap(base),head=ledger.head();
  const otherBranch=await makeGenesis({[D]:'unrelated'});
  await rejected(ledger.push({baseId:otherBranch.id,expectedHead:head.id,
    localFiles:{...base,[B]:'local'},groups:[relation],actor:'local',message:'edit'}),'UNKNOWN_REVISION');
});
test('id hash does not change when object key insertion order changes',async()=>{
  assert.equal(await hashCanonical({a:1,b:2}),await hashCanonical({a:1,b:2}));
});