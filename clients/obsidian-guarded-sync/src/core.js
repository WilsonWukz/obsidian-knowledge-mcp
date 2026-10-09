/* Evidence-safe local Obsidian workflow. Pure JavaScript, no Obsidian or network runtime. */
'use strict';
const {createHash} = require('node:crypto');
const PROTOCOL=1;
const PREFIX='INSES/';
const MAX_COMMIT_BYTES=650_000;
const MAX_NOTE_BYTES=96_000;
const MAX_FILES=5;
const MAX_GROUPS=12;
const MAX_HISTORY=500;
const SNAPSHOT_LIMIT=2000;
class SyncError extends Error {constructor(code,detail=''){super(code+(detail?': '+detail:''));this.code=code;}}
const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const clone=o=>JSON.parse(JSON.stringify(o));
const hash=o=>createHash('sha256').update(JSON.stringify(o),'utf8').digest('hex');
const size=o=>Buffer.byteLength(typeof o==='string'?o:JSON.stringify(o),'utf8');
function validPath(path){
  if(typeof path!=='string'||path.length<PREFIX.length+4||path.length>220||!path.startsWith(PREFIX)||!path.endsWith('.md')||
  path.includes('\\')||path.includes('//')||/[\x00-\x1f\x7f]/.test(path)||
  path.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.'))||/%(?:2e|2f|5c)/i.test(path))throw new SyncError('INVALID_PATH');
}
function checkSnapshot(files){
  if(!files||typeof files!=='object'||Array.isArray(files)||Object.keys(files).length>SNAPSHOT_LIMIT)throw new SyncError('INVALID_SNAPSHOT');
  for(const [p,v] of Object.entries(files)){validPath(p);if(typeof v!=='string'||size(v)>MAX_NOTE_BYTES)throw new SyncError('INVALID_NOTE_CONTENT',p);}
}
function sortedSnapshot(files){checkSnapshot(files);return Object.fromEntries(Object.keys(files).sort().map(k=>[k,files[k]]));}
const at=(o,k)=>has(o,k)?o[k]:null;
function diff(a,b){checkSnapshot(a);checkSnapshot(b);return [...new Set([...Object.keys(a),...Object.keys(b)])].sort()
  .filter(p=>at(a,p)!==at(b,p)).map(path=>({path,before:at(a,path),after:at(b,path)}));}
function validateGroups(groups,changed){
  if(!Array.isArray(groups)||groups.length>MAX_GROUPS)throw new SyncError('INVALID_GROUPS');
  const ids=new Set(),out=[];
  for(const g of groups){
    if(!g||typeof g.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9:_./-]{0,119}$/.test(g.id)||
      !Array.isArray(g.paths)||!g.paths.length||g.paths.length>25||ids.has(g.id))throw new SyncError('INVALID_GROUP');
    ids.add(g.id);for(const p of g.paths)validPath(p);
    const paths=[...new Set(g.paths)].sort();
    if(!paths.some(p=>changed.includes(p)))throw new SyncError('UNTOUCHED_GROUP');
    out.push({id:g.id,paths});
  }
  if(changed.length>1&&!out.some(g=>changed.every(p=>g.paths.includes(p))))throw new SyncError('GROUP_REQUIRED');
  if(changed.length===1&&!out.length)out.push({id:'file:'+changed[0],paths:changed.slice()});
  return out.sort((a,b)=>a.id.localeCompare(b.id));
}
function genesis(files){
  const raw={protocol:PROTOCOL,parents:[],createdAt:'1970-01-01T00:00:00.000Z',actor:'migration',
    message:'Adopt existing vault snapshot; no notes written',files:sortedSnapshot(files),changes:[],groups:[]};
  return {...raw,id:hash(raw)};
}
function commit(parent,files,actor,message,groups,createdAt){
  if(!parent||!parent.id||!['local','agent','merge','migration'].includes(actor))throw new SyncError('INVALID_PARENT_OR_ACTOR');
  if(typeof message!=='string'||!message.trim()||message.length>300)throw new SyncError('INVALID_MESSAGE');
  const clean=sortedSnapshot(files),changes=diff(parent.files,clean);
  if(!changes.length)throw new SyncError('NO_OP');
  if(changes.length>MAX_FILES)throw new SyncError('TOO_MANY_FILES');
  const stamp=createdAt||new Date().toISOString();if(!Number.isFinite(Date.parse(stamp)))throw new SyncError('INVALID_DATE');
  const raw={protocol:PROTOCOL,parents:[parent.id],createdAt:stamp,actor,message:message.trim(),
    files:clean,changes,groups:validateGroups(groups||[],changes.map(c=>c.path))};
  if(size(raw)>MAX_COMMIT_BYTES)throw new SyncError('COMMIT_TOO_LARGE');
  return {...raw,id:hash(raw)};
}
function verifyCommit(record){
  if(!record||record.protocol!==1||typeof record.id!=='string'||!/^[a-f0-9]{64}$/.test(record.id)||
    !Array.isArray(record.parents)||record.parents.length>1||!record.files||!Array.isArray(record.groups)||!Array.isArray(record.changes))throw new SyncError('INVALID_REVISION');
  checkSnapshot(record.files);
  const {id,...raw}=record;if(hash(raw)!==id)throw new SyncError('COMMIT_INTEGRITY');
  return record;
}
function threeWay(base,local,remote,localGroups=[],remoteGroups=[]){
  checkSnapshot(base);checkSnapshot(local);checkSnapshot(remote);
  const lc=diff(base,local).map(c=>c.path),rc=diff(base,remote).map(c=>c.path);
  const files={},conflicts=[];
  for(const p of [...new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)])].sort()){
    const b=at(base,p),l=at(local,p),r=at(remote,p),left=l!==b,right=r!==b;
    if(left&&right&&l!==r){conflicts.push({reason:'SAME_FILE_DIVERGED',paths:[p],base:{[p]:b},local:{[p]:l},remote:{[p]:r}});continue;}
    const value=left?l:r;if(value!==null)files[p]=value;
  }
  for(const a of localGroups){if(!a.paths.some(p=>lc.includes(p)))continue;
    for(const b of remoteGroups){if(!b.paths.some(p=>rc.includes(p)))continue;
      if(a.id!==b.id&&!a.paths.some(p=>b.paths.includes(p)))continue;
      const paths=[...new Set([...a.paths,...b.paths])].sort();
      if(paths.every(p=>at(local,p)===at(remote,p)))continue;
      if(paths.length===1&&conflicts.some(c=>c.reason==='SAME_FILE_DIVERGED'&&c.paths[0]===paths[0]))continue;
      if(conflicts.some(c=>c.reason==='SEMANTIC_GROUP_OVERLAP'&&c.paths.join('|')===paths.join('|')))continue;
      const values=x=>Object.fromEntries(paths.map(p=>[p,at(x,p)]));
      conflicts.push({reason:'SEMANTIC_GROUP_OVERLAP',paths,groupId:a.id===b.id?a.id:a.id+' × '+b.id,
        base:values(base),local:values(local),remote:values(remote)});
    }
  }
  return {disposition:conflicts.length?'blocked':!lc.length&&!rc.length?'unchanged':!lc.length?'fast_forward_remote':!rc.length?'fast_forward_local':'merge_ready',
    merged:conflicts.length?null:sortedSnapshot(files),localChanged:lc,remoteChanged:rc,conflicts};
}
function createState(vaultId,base){verifyCommit(base);return {schema:1,vaultId,headId:base.id,remoteHeadId:null,
  commits:{[base.id]:clone(base)},staged:{},journal:null,review:null};}
function checkState(state,vaultId){
  if(!state||state.schema!==1||state.vaultId!==vaultId||!state.commits||!state.headId||!state.commits[state.headId]||
    !state.staged||Array.isArray(state.staged))throw new SyncError('STATE_MISMATCH');
  verifyCommit(state.commits[state.headId]);
  if(state.remoteHeadId&&state.commits[state.remoteHeadId])verifyCommit(state.commits[state.remoteHeadId]);
  if(state.journal&&(!Array.isArray(state.journal.changes)||!state.journal.targetId))throw new SyncError('JOURNAL_INVALID');
}
function scanRelations(body){return new Set((body.match(/\bR-[A-Za-z0-9-]+\b/g)||[]).filter(s=>s.length<=110));}
function changedLines(before,after){
  const counts=new Map();for(const l of before.split(/\r?\n/))counts.set(l,(counts.get(l)||0)+1);
  const added=[];for(const l of after.split(/\r?\n/)){const n=counts.get(l)||0;if(n)counts.set(l,n-1);else added.push(l);}
  const removed=[];for(const [l,n] of counts)for(let i=0;i<n;i++)removed.push(l);
  return added.concat(removed);
}
function groupsForChanges(before,after,changes,relationIds=[]){
  const paths=changes.map(c=>c.path),given=new Set(relationIds.map(s=>s.trim()).filter(Boolean));
  for(const id of given)if(!/^R-[A-Za-z0-9-]+$/.test(id))throw new SyncError('INVALID_RELATION_ID');
  const joined={...before,...after};const touchedRelations=new Set();
  for(const c of changes){
    const old=at(before,c.path)||'',updated=at(after,c.path)||'';
    const ids=new Set([...scanRelations(old),...scanRelations(updated)]);
    if(!ids.size)continue;
    const lineIds=new Set(changedLines(old,updated).flatMap(line=>[...scanRelations(line)]));
    if(!lineIds.size&&!given.size)throw new SyncError('SEMANTIC_SCOPE_REQUIRED',c.path);
    for(const id of (given.size?given:lineIds)){
      if(!ids.has(id))throw new SyncError('RELATION_ID_NOT_IN_CHANGED_NOTE',id);
      touchedRelations.add(id);
    }
  }
  if(touchedRelations.size>MAX_GROUPS-1)throw new SyncError('SEMANTIC_SCOPE_TOO_WIDE');
  const groups=[];
  for(const id of touchedRelations){
    const members=Object.keys(joined).filter(p=>scanRelations(joined[p]).has(id));
    if(members.length>25)throw new SyncError('SEMANTIC_GROUP_TOO_WIDE');
    groups.push({id:'relation:'+id,paths:members});
  }
  if(paths.length>1)groups.push({id:'batch:'+hash(paths).slice(0,32),paths});
  if(!groups.length&&paths.length===1)groups.push({id:'file:'+paths[0],paths:[paths[0]]});
  return validateGroups(groups,paths);
}
function ancestors(state,id,max=MAX_HISTORY){
  const out=[],seen=new Set();let cursor=id;
  while(cursor){
    if(out.length>=max||seen.has(cursor)||!state.commits[cursor])throw new SyncError('HISTORY_INCOMPLETE');
    seen.add(cursor);const c=state.commits[cursor];verifyCommit(c);out.push(c);
    cursor=c.parents[0]||null;
  }
  return out;
}
function commonBase(state,a,b){
  const local=new Set(ancestors(state,a).map(c=>c.id));
  return ancestors(state,b).find(c=>local.has(c.id))||null;
}
function groupsSince(state,ancestor,id){
  const out=[];let cursor=id;let k=0;
  while(cursor!==ancestor){if(++k>MAX_HISTORY)throw new SyncError('HISTORY_INCOMPLETE');const commit=state.commits[cursor];if(!commit)throw new SyncError('HISTORY_INCOMPLETE');out.push(...commit.groups);cursor=commit.parents[0];if(!cursor)throw new SyncError('UNRELATED_HISTORY');}
  return out;
}
const same=(a,b)=>diff(a,b).length===0;
class LocalEngine {
 constructor({vault,store,remote=null,vaultId}){this.vault=vault;this.store=store;this.remote=remote;this.vaultId=vaultId;this.state=null;}
 async load(){this.state=await this.store.read();if(this.state)checkState(this.state,this.vaultId);return this.state;}
 requireState(){if(!this.state)throw new SyncError('LOCAL_NOT_INITIALIZED');if(this.state.journal)throw new SyncError('RECOVERY_REQUIRED');return this.state;}
 async persist(){
  checkState(this.state,this.vaultId);
  try { await this.store.write(this.state); }
  catch(error){
    // An interrupted fsync cannot be treated as a successful commit. Reload
    // the durable state and retain any recovery journal rather than operating
    // against an optimistic in-memory state.
    this.state=await this.store.read();
    if(this.state)checkState(this.state,this.vaultId);
    throw error;
  }
}
 async initialize(){if(this.state)throw new SyncError('ALREADY_INITIALIZED');const files=await this.vault.snapshot();this.state=createState(this.vaultId,genesis(files));await this.persist();return this.state.headId;}
 head(){const s=this.requireState();return s.commits[s.headId];}
 async status(){const s=this.requireState();const working=await this.vault.snapshot(),head=this.head();
  const all=diff(head.files,working),staged=Object.keys(s.staged).sort().map(path=>({path,before:at(head.files,path),after:s.staged[path]}));
  const unstaged=all.filter(c=>!has(s.staged,c.path)||s.staged[c.path]!==c.after);
  return {headId:s.headId,remoteHeadId:s.remoteHeadId,staged,unstaged,working,
    journal:s.journal?clone(s.journal):null};
 }
 async stage(paths){const s=this.requireState();if(!Array.isArray(paths)||!paths.length)throw new SyncError('NO_PATHS');
  const working=await this.vault.snapshot(),head=this.head(),candidate={...s.staged};
  for(const p of paths){validPath(p);
    if(at(working,p)===at(head.files,p))delete candidate[p];
    else candidate[p]=at(working,p);
  }
  if(Object.keys(candidate).length>MAX_FILES)throw new SyncError('STAGE_LIMIT');
  s.staged=candidate;await this.persist();return Object.keys(s.staged);
 }
 async unstage(paths){const s=this.requireState();for(const p of paths){validPath(p);delete s.staged[p];}await this.persist();return Object.keys(s.staged);}
 async commit(message,relationIds=[]){const s=this.requireState();const entries=Object.entries(s.staged);if(!entries.length)throw new SyncError('NOTHING_STAGED');
  const parent=this.head(),next={...parent.files};for(const [p,body] of entries){if(body===null)delete next[p];else next[p]=body;}
  const changes=diff(parent.files,next);if(!changes.length)throw new SyncError('NO_OP');
  const groups=groupsForChanges(parent.files,next,changes,relationIds);
  const result=commit(parent,next,'local',message,groups);
  s.commits[result.id]=result;s.headId=result.id;s.staged={};s.review=null;await this.persist();return result;
 }
 async fetch(){const s=this.requireState();if(!this.remote)throw new SyncError('GATEWAY_NOT_CONFIGURED');
  const status=await this.remote.status();const id=status?.headId;
  if(!id)throw new SyncError('REMOTE_NOT_INITIALIZED');
  if(!/^[a-f0-9]{64}$/.test(id))throw new SyncError('REMOTE_INVALID_HEAD');
  let cursor=id,count=0;const downloads={};
  while(cursor&&!s.commits[cursor]){
    if(++count>MAX_HISTORY)throw new SyncError('HISTORY_TOO_DEEP');
    const record=verifyCommit(await this.remote.get(cursor));
    if(record.id!==cursor)throw new SyncError('REMOTE_INTEGRITY');
    downloads[cursor]=record;cursor=record.parents[0]||null;
  }
  // Never adopt a remote history unrelated to local genesis; download can be
  // retained in memory, but no local state or working file is overwritten.
  if(!cursor)throw new SyncError('UNRELATED_HISTORY');
  const merged={...s.commits,...downloads};
  const next={...s,commits:merged,remoteHeadId:id,review:null};checkState(next,this.vaultId);
  this.state=next;await this.persist();return this.preview();
 }
 preview(){const s=this.requireState();if(!s.remoteHeadId)throw new SyncError('REMOTE_NOT_FETCHED');
  const base=commonBase(s,s.headId,s.remoteHeadId);if(!base)throw new SyncError('UNRELATED_HISTORY');
  const local=s.commits[s.headId],remote=s.commits[s.remoteHeadId];
  const localGroups=groupsSince(s,base.id,local.id),remoteGroups=groupsSince(s,base.id,remote.id);
  const result=threeWay(base.files,local.files,remote.files,localGroups,remoteGroups);
  return {...result,baseId:base.id,localId:local.id,remoteId:remote.id,
    localGroups,remoteGroups};
 }
 async pull(){const s=this.requireState();if(!s.remoteHeadId)throw new SyncError('REMOTE_NOT_FETCHED');
  if(!this.remote)throw new SyncError('GATEWAY_NOT_CONFIGURED');
  if((await this.remote.status()).headId!==s.remoteHeadId)throw new SyncError('REMOTE_ADVANCED_FETCH_FIRST');
  if(Object.keys(s.staged).length)throw new SyncError('STAGED_CHANGES_EXIST');
  const view=this.preview();if(view.localId!==view.baseId)throw new SyncError('LOCAL_COMMITS_REQUIRE_MERGE');
  const target=s.commits[s.remoteHeadId];return this.applySnapshot(target.files,target.id,'pull');
 }
 async merge(relationIds=[]){const s=this.requireState();if(!s.remoteHeadId)throw new SyncError('REMOTE_NOT_FETCHED');
  if(!this.remote)throw new SyncError('GATEWAY_NOT_CONFIGURED');
  if((await this.remote.status()).headId!==s.remoteHeadId)throw new SyncError('REMOTE_ADVANCED_FETCH_FIRST');
  if(Object.keys(s.staged).length)throw new SyncError('STAGED_CHANGES_EXIST');
  const view=this.preview();if(view.disposition==='blocked')throw new SyncError('MERGE_CONFLICT');
  if(view.disposition!=='merge_ready')throw new SyncError('NO_MERGE_NEEDED');
  // Require explicit semantic declaration if a merged note references relations;
  // stage a new commit against remote and preserve previous local commits.
  const remote=s.commits[s.remoteHeadId];const changes=diff(remote.files,view.merged);
  const groups=groupsForChanges(remote.files,view.merged,changes,relationIds);
  const result=commit(remote,view.merged,'merge','Owner-reviewed merge of local work with fetched remote',groups);
  return this.applySnapshot(view.merged,result.id,'merge',result);
 }
 async applySnapshot(files,targetId,mode,mergeCommit=null){
  const s=this.requireState();const current=await this.vault.snapshot();
  if(!same(current,this.head().files))throw new SyncError('WORKTREE_DIRTY');
  const changes=diff(current,files);
  if(changes.some(c=>c.after===null))throw new SyncError('DELETE_NEEDS_MANUAL_REVIEW');
  if(changes.length>50)throw new SyncError('PULL_TOO_LARGE');
  const nextState=clone(s);
  nextState.journal={mode,targetId,changes,previousId:s.headId,mergeCommit,
    startedAt:new Date().toISOString()};
  this.state=nextState;await this.persist();
  try{
    for(const change of changes){await this.vault.write(change.path,change.after,change.before);}
    if(!(await this.verifyJournal(false)))throw new SyncError('PULL_READBACK_MISMATCH');
    return await this.finalizeJournal();
  }catch(error){throw new SyncError('RECOVERY_REQUIRED',error.code||error.message);}
 }
 async verifyJournal(requireOldOrNew=true){const s=this.state,j=s?.journal;if(!j)return false;
  const working=await this.vault.snapshot();return j.changes.every(c=>{
    const now=at(working,c.path);return requireOldOrNew?(now===c.before||now===c.after):now===c.after;
  });
 }
 async finalizeJournal(){const s=this.state,j=s?.journal;if(!j)throw new SyncError('JOURNAL_MISSING');
  const ok=await this.verifyJournal(false);if(!ok)throw new SyncError('JOURNAL_NOT_APPLIED');
  if(j.mergeCommit)s.commits[j.mergeCommit.id]=j.mergeCommit;
  s.headId=j.targetId;s.journal=null;s.staged={};s.review=null;await this.persist();return s.headId;
 }
 async rollbackJournal(){const s=this.state,j=s?.journal;if(!j)throw new SyncError('JOURNAL_MISSING');
  if(!(await this.verifyJournal(true)))throw new SyncError('JOURNAL_EXTERNAL_CHANGE');
  for(const change of j.changes.slice().reverse()){
    const now=(await this.vault.snapshot())[change.path]??null;
    if(now!==change.before){
      if(change.before===null){
        if(now!==change.after||typeof this.vault.remove!=='function')throw new SyncError('DELETE_RECOVERY_REQUIRES_REVIEW');
        // Explicitly owner-reviewed recovery only. Only remove a file created
        // by THIS interrupted pull if its exact staged content still matches.
        await this.vault.remove(change.path,now);
      }else await this.vault.write(change.path,change.before,now);
    }
  }
  if(!(await this.verifyJournal(true)))throw new SyncError('RECOVERY_FAILED');
  const working=await this.vault.snapshot();
  if(j.changes.some(c=>at(working,c.path)!==c.before))throw new SyncError('RECOVERY_READBACK_MISMATCH');
  s.journal=null;s.staged={};s.review=null;await this.persist();return s.headId;
 }
 async preparePush(){const s=this.requireState();if(!this.remote)throw new SyncError('GATEWAY_NOT_CONFIGURED');
  if(Object.keys(s.staged).length)throw new SyncError('STAGED_CHANGES_EXIST');
  const working=await this.vault.snapshot();if(!same(working,this.head().files))throw new SyncError('WORKTREE_DIRTY');
  const remoteHead=(await this.remote.status())?.headId;
  if(remoteHead!==s.remoteHeadId)throw new SyncError('REMOTE_ADVANCED_FETCH_FIRST');
  const view=this.preview();
  if(view.disposition==='blocked')throw new SyncError('MERGE_CONFLICT');
  if(view.localId===view.remoteId)return {status:'already_current'};
  if(view.remoteId!==view.baseId)throw new SyncError('MERGE_REQUIRED');
  const changes=diff(s.commits[view.baseId].files,s.commits[view.localId].files);
  if(changes.length>MAX_FILES)throw new SyncError('TOO_MANY_FILES_PUSH');
  const key=hash({baseId:view.baseId,expectedHead:view.remoteId,localId:view.localId,files:this.head().files});
  s.review={key,baseId:view.baseId,remoteId:view.remoteId,localId:view.localId,createdAt:new Date().toISOString()};
  await this.persist();return {status:'ready',key,view,changes};
 }
 async push(reviewKey){const s=this.requireState();if(!s.review||s.review.key!==reviewKey)throw new SyncError('PUSH_REVIEW_REQUIRED');
  const reviewed=s.review,ready=await this.preparePush();if(ready.status!=='ready'||ready.key!==reviewKey)throw new SyncError('PUSH_REVIEW_EXPIRED');
  const groups=groupsSince(s,reviewed.baseId,reviewed.localId);
  // Restrict actor and expected remote head client-side; the server still MUST
  // authenticate, validate dependency groups and CAS the authoritative ref.
  const result=await this.remote.push({baseId:reviewed.baseId,expectedHead:reviewed.remoteId,
    localFiles:this.head().files,groups,actor:'local',message:'Mac owner-reviewed local commits'});
  if(!result||!['published','remote_advanced','conflict','already_current'].includes(result.status))throw new SyncError('PUSH_UNKNOWN_RESULT');
  s.review=null;
  if(result.status==='published'){
    const latest=verifyCommit(await this.remote.get(result.headId));
    if(!same(latest.files,this.head().files))throw new SyncError('PUBLISHED_TREE_MISMATCH');
    s.commits[latest.id]=latest;s.remoteHeadId=latest.id;s.headId=latest.id;
  }
  await this.persist();return result;
 }
}
module.exports={SyncError,hash,size,validPath,checkSnapshot,sortedSnapshot,diff,validateGroups,genesis,commit,verifyCommit,
  threeWay,groupsForChanges,createState,LocalEngine,commonBase,groupsSince};
