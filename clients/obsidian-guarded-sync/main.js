/* Guarded Sync 0.3.0-alpha.1: bundled, desktop-only; source in src/ */
const __gsCoreModule={exports:{}};
(function(module,exports,require){
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

})(__gsCoreModule,__gsCoreModule.exports,require);
'use strict';
/* Obsidian Guarded Sync (desktop-only). No integration with Remotely Save or MCP.
 * Until the separate authenticated gateway ships, Fetch/Push fail closed.
 */
const {Plugin,ItemView,PluginSettingTab,Setting,Notice,Modal,requestUrl} = require('obsidian');
const fs = require('node:fs/promises');
const {realpathSync} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash} = require('node:crypto');
const {LocalEngine,SyncError,diff,validPath,checkSnapshot} = __gsCoreModule.exports;
const execFileAsync=promisify(execFile);
const VIEW='guarded-sync-workbench';
const SERVICE='obsidian-guarded-sync';
const defaults={gatewayUrl:'',projectPrefix:'INSES/',autoSync:false};
const friendly={
  LOCAL_NOT_INITIALIZED:'先点击「Initialize local history」，只建立本地版本基线。',
  GATEWAY_NOT_CONFIGURED:'受控同步网关尚未配置，Fetch/Push 不可使用。',
  ADOPTION_DISABLED:'云端尚未显式启用一次性迁移许可。',
  GENESIS_MISMATCH:'云端与 Mac 的初始文件不完全一致。请先核对，不要强制覆盖。',
  SOURCE_CHANGED:'迁移中云端文件发生变化，已中止；先停用旧同步写入者。',
  KEYCHAIN_TOKEN_MISSING:'钥匙串中没有与当前 Vault identity 匹配的凭证；请检查服务名及账户名。',
  KEYCHAIN_TOKEN_INVALID:'钥匙串项目存在，但密码为空或长度不足 32 字符；请检查保存的值。',
  KEYCHAIN_COMMAND_UNAVAILABLE:'无法启动 macOS /usr/bin/security 命令，请检查系统环境。',
  KEYCHAIN_ACCESS_DENIED:'Obsidian 无法读取该钥匙串项目；请在 macOS 授权提示中选择允许。',
  KEYCHAIN_ACCESS_TIMEOUT:'等待钥匙串访问授权超时；请重新检查并及时处理 macOS 授权提示。',
  KEYCHAIN_LOOKUP_FAILED:'钥匙串命令执行失败，但不一定是凭证缺失；请使用开发者工具检查本机权限。',
  REMOTE_NOT_INITIALIZED:'远端受控版本库尚未经过审核初始化，不能直接从旧 R2 内容推送。',
  UNRELATED_HISTORY:'本地与云端没有经过验证的共同祖先。禁止覆盖；请先完成迁移对账。',
  WORKTREE_DIRTY:'本地文件与已提交快照不同。先检查 Status、Stage 和 Commit；禁止隐式覆盖。',
  STAGED_CHANGES_EXIST:'仍有暂存修改，先完成 Commit 或 Unstage。',
  SEMANTIC_SCOPE_REQUIRED:'修改涉及关系证据，但无法自动确定关系范围。请填写关系 ID（如 R-P21-01）。',
  SEMANTIC_SCOPE_TOO_WIDE:'该修改涉及过多关系，请拆成较小的提交并人工核对。',
  RELATION_ID_NOT_IN_CHANGED_NOTE:'指定关系 ID 未出现在这次修改的关联笔记中。',
  MERGE_CONFLICT:'本地与云端存在内容或语义冲突；必须人工比较三方版本。',
  LOCAL_COMMITS_REQUIRE_MERGE:'本地有尚未发布的提交；先 Fetch、查看冲突并合并。',
  REMOTE_ADVANCED_FETCH_FIRST:'云端版本已变化，Push 被阻止。先 Fetch，再重新审阅。',
  MERGE_REQUIRED:'本地与远端已经分叉；必须先审阅并完成 Merge。',
  PUSH_REVIEW_REQUIRED:'必须先点 Preview Push，并独立审阅每项差异。',
  DELETE_NEEDS_MANUAL_REVIEW:'存在删除文件操作。此版本禁止自动删除，请人工处理。',
  RECOVERY_REQUIRED:'同步过程中断，必须处理恢复日志后才能执行其他操作。',
  JOURNAL_EXTERNAL_CHANGE:'失败后有第三方再次修改该文件；不能自动回滚，请人工核对备份。',
};
function el(tag,parent,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);parent?.appendChild(n);return n;}
function button(parent,label,cb,kind=''){const b=el('button',parent,'gs-button '+kind,label);b.type='button';b.addEventListener('click',cb);return b;}
function validateEndpoint(input){
  if(!input)return null;
  try{const u=new URL(input);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/sync/v1')throw Error();return u.href;}
  catch{throw new SyncError('INVALID_GATEWAY_URL','需要 HTTPS 且路径为 /sync/v1（不包含用户名、参数或片段）');}
}
function vaultIdentity(app){
  if(typeof app.vault.adapter.getBasePath!=='function')throw new SyncError('DESKTOP_VAULT_REQUIRED');
  const base=realpathSync(app.vault.adapter.getBasePath());
  const hashed=createHash('sha256').update(base).digest('hex');
  return {base,id:hashed};
}
class DiskStore {
  constructor(vaultId){
    this.dir=path.join(os.homedir(),'.obsidian-guarded-sync','vaults',vaultId);
    this.file=path.join(this.dir,'state.json');
  }
  async read(){
    try{return JSON.parse(await fs.readFile(this.file,'utf8'));}
    catch(e){if(e.code==='ENOENT')return null;throw new SyncError('LOCAL_STATE_CORRUPT','保留文件 '+this.file+'，请不要重新初始化覆盖');}
  }
  async write(value){
    await fs.mkdir(this.dir,{recursive:true,mode:0o700});
    const temp=path.join(this.dir,`state.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    let saved=false;
    try{
      // State contains private paper content but never credentials. It is
      // intentionally OUTSIDE the Obsidian Vault/Remotely Save folder.
      const handle=await fs.open(temp,'wx',0o600);
      try{await handle.writeFile(JSON.stringify(value),'utf8');await handle.sync();}finally{await handle.close();}
      await fs.rename(temp,this.file);saved=true;
      // Best effort directory sync after rename, supported by macOS/APFS.
      try{const dir=await fs.open(this.dir,'r');try{await dir.sync();}finally{await dir.close();}}catch{}
    }finally{if(!saved)await fs.rm(temp,{force:true}).catch(()=>{});}
  }
}
class ObsidianVaultAdapter {
  constructor(app,base){this.app=app;this.base=base;}
  async snapshot(){
    const out={},list=this.app.vault.getMarkdownFiles().filter(f=>f.path.startsWith('INSES/'));
    if(list.length>2000)throw new SyncError('SNAPSHOT_TOO_LARGE');
    for(const f of list){validPath(f.path);
      // Reject symlinks that escape the Vault; getMarkdownFiles itself may
      // include adapter-provided paths not backed by an ordinary file.
      const expected=path.join(this.base,...f.path.split('/'));
      let actual;
      try{actual=await fs.realpath(expected);}catch{throw new SyncError('VAULT_FILE_UNAVAILABLE',f.path);}
      if(!actual.startsWith(this.base+path.sep))throw new SyncError('SYMLINK_OUTSIDE_VAULT',f.path);
      out[f.path]=await this.app.vault.read(f);
    }
    checkSnapshot(out);return out;
  }
  async write(notePath,body,expected){
    validPath(notePath);
    if(body===null)throw new SyncError('DELETE_NEEDS_MANUAL_REVIEW');
    const existing=this.app.vault.getAbstractFileByPath(notePath);
    if(existing&&existing.extension!=='md')throw new SyncError('FILE_TYPE_CONFLICT');
    const before=existing?await this.app.vault.read(existing):null;
    if(expected!==undefined&&before!==expected)throw new SyncError('WORKTREE_CHANGED_DURING_APPLY');
    if(existing){await this.app.vault.modify(existing,body);return;}
    const parent=notePath.slice(0,notePath.lastIndexOf('/'));
    if(!this.app.vault.getAbstractFileByPath(parent))throw new SyncError('PARENT_DIRECTORY_MISSING',parent);
    await this.app.vault.create(notePath,body);
  }
  async remove(notePath,expected){
    validPath(notePath);
    const file=this.app.vault.getAbstractFileByPath(notePath);
    if(!file)return;
    if(file.extension!=='md'||await this.app.vault.read(file)!==expected)
      throw new SyncError('WORKTREE_CHANGED_DURING_RECOVERY');
    // Only after the owner chose manual recovery. Trash, not hard delete.
    await this.app.fileManager.trashFile(file);
  }
}
// macOS GUI apps may have a different PATH from Terminal. Never invoke a shell,
// and never log stdout: it contains the actual owner credential.
const KEYCHAIN_SECURITY_BIN='/usr/bin/security';
async function readOwnerKeychainToken(vaultId,run=execFileAsync,platform=process.platform){
  if(platform!=='darwin')throw new SyncError('MAC_ONLY');
  let response;
  try{
    // Give a human time to approve the first macOS Keychain access prompt.
    response=await run(KEYCHAIN_SECURITY_BIN,
      ['find-generic-password','-s',SERVICE,'-a',vaultId,'-w'],
      {timeout:30000,maxBuffer:4096,encoding:'utf8'});
  }catch(e){
    const code=e?.code;
    if(code==='ENOENT')throw new SyncError('KEYCHAIN_COMMAND_UNAVAILABLE');
    if(code==='EACCES'||code==='EPERM')throw new SyncError('KEYCHAIN_ACCESS_DENIED');
    if(e?.killed||e?.signal==='SIGTERM'||code==='ETIMEDOUT')
      throw new SyncError('KEYCHAIN_ACCESS_TIMEOUT');
    const diagnostic=typeof e?.stderr==='string'?e.stderr:'';
    if(/specified item could not be found|errSecItemNotFound|item not found/i.test(diagnostic))
      throw new SyncError('KEYCHAIN_TOKEN_MISSING');
    if(/user interaction is not allowed|authorization failed|operation was canceled|access denied/i.test(diagnostic))
      throw new SyncError('KEYCHAIN_ACCESS_DENIED');
    // A bare nonzero exit code has multiple possible causes. Do NOT claim that
    // the item is missing, and do not leak stderr or the secret in a notice.
    throw new SyncError('KEYCHAIN_LOOKUP_FAILED');
  }
  const token=typeof response?.stdout==='string'?response.stdout.trim():'';
  if(token.length<32)throw new SyncError('KEYCHAIN_TOKEN_INVALID');
  return token;
}
class GatewayRemote {
  constructor(url,vaultId){this.url=validateEndpoint(url);this.vaultId=vaultId;}
  token(){return readOwnerKeychainToken(this.vaultId);}
  async rpc(op,args={}){
    if(!this.url)throw new SyncError('GATEWAY_NOT_CONFIGURED');
    const key=await this.token();
    let response;
    try{
      response=await requestUrl({url:this.url,method:'POST',headers:{'Content-Type':'application/json',
        'Authorization':'Bearer '+key,'Cache-Control':'no-store'},body:JSON.stringify({op,...args}),throw:false});
    }catch{throw new SyncError('GATEWAY_UNREACHABLE');}
    const obj=response.json;
    if(!obj||typeof obj!=='object')throw new SyncError('REMOTE_INVALID_RESPONSE');
    if(response.status!==200)throw new SyncError(typeof obj.error==='string'?obj.error:'GATEWAY_REJECTED');
    return obj;
  }
  status(){return this.rpc('status');}
  async get(id){const r=await this.rpc('get',{id});return r.commit;}
  push(input){return this.rpc('push',{input});}
  adopt(expectedGenesisId){return this.rpc('adopt_legacy_vault',{expectedGenesisId,ack:'I_HAVE_DISABLED_LEGACY_WRITERS'});}
}
class ConfirmModal extends Modal {
  constructor(app,{title,body,buttonText='确认执行',onConfirm}){super(app);this.title=title;this.body=body;this.buttonText=buttonText;this.onConfirm=onConfirm;}
  onOpen(){
    const {contentEl}=this;contentEl.empty();contentEl.addClass('gs-modal');
    el('h3',contentEl,'',this.title);
    const pre=el('pre',contentEl,'gs-review-text',this.body);
    pre.setAttribute('aria-label','完整变更审阅内容');
    const actions=el('div',contentEl,'gs-modal-actions');
    button(actions,'取消',()=>this.close());
    button(actions,this.buttonText,()=>{this.close();void this.onConfirm();},'mod-warning');
  }
}
class GuardedSyncView extends ItemView {
  constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.checked=new Set();this.busy=false;}
  getViewType(){return VIEW;}
  getDisplayText(){return 'Guarded Sync · 受保护版本管理';}
  getIcon(){return 'git-branch';}
  async onOpen(){await this.render();}
  async render(){
    const container=this.containerEl.children[1]||this.containerEl;container.empty();
    const root=el('div',container,'gs-root');this.root=root;
    const top=el('div',root,'gs-header');el('h3',top,'','Guarded Sync');
    el('span',top,'gs-badge','Local-first · No autosync');
    el('p',root,'gs-info','本地 Stage / Commit 不上传。Fetch 只读取版本信息；Pull / Merge 必须确认后才写入。');
    const main=el('div',root,'gs-toolbar');
    button(main,'Refresh Status',()=>this.action(()=>this.render()));
    button(main,'Initialize local history',()=>this.action(async()=>{
      const folder=this.plugin.identity.base;
      await this.review({title:'建立本地初始快照',body:`只对 ${folder}/INSES/ 建立本地版本历史。不会改动笔记，也不会上传。\n存储路径：${this.plugin.store.dir}`,confirm:'初始化',run:()=>this.plugin.engine.initialize()});
    }));
    button(main,'Fetch',()=>this.action(async()=>{const value=await this.plugin.engine.fetch();new Notice('Fetch：'+value.disposition+'；本地文件未改动。');}));
    button(main,'Check remote mode',()=>this.action(async()=>{
      if(!this.plugin.engine.remote)throw new SyncError('GATEWAY_NOT_CONFIGURED');
      const status=await this.plugin.engine.remote.status();
      new Notice(status.mode==='managed'?'受保护版本库已进入 managed 模式。':'isolated_test：提交只更新隔离历史，不会改变旧 Remotely Save Vault。',7000);
    }));
    button(main,'Adopt legacy baseline (one-time)',()=>this.action(async()=>{
      const state=this.plugin.engine.state;
      if(!state)throw new SyncError('LOCAL_NOT_INITIALIZED');
      const genesis=Object.values(state.commits).find(c=>c.parents.length===0);
      if(!genesis||genesis.id!==state.headId)throw new SyncError('LOCAL_COMMITS_REQUIRE_MERGE');
      const status=await this.plugin.engine.status();
      if(status.staged.length||status.unstaged.length)throw new SyncError('WORKTREE_DIRTY');
      if(!this.plugin.engine.remote)throw new SyncError('GATEWAY_NOT_CONFIGURED');
      await this.review({title:'一次性核验旧云端基线',
        body:'警告：必须先备份 Vault，停用 Remotely Save 对 INSES/ 的写入并撤销相关旧 R2/S3 写入凭据。\\n'
          +'此操作只会在云端建立不可变初始快照，不会改动 Mac 文件。只有云端 INSES/ 与本地初始快照的 SHA-256 完全一致才会成功。\\n'
          +'本地初始版本：'+genesis.id,
        confirm:'我已停止旧写入者，开始比对',
        run:async()=>{await this.plugin.engine.remote.adopt(genesis.id);await this.plugin.engine.fetch();}
      });
    }));
    let state=this.plugin.engine.state;
    if(!state){el('div',root,'gs-note','尚未初始化本地历史。请先在测试 Vault 中创建第一份只读基线。');return;}
    if(state.journal){
      const warning=el('div',root,'gs-warning');el('strong',warning,'','检测到未完成的本地应用日志');
      el('p',warning,'',`目标提交 ${state.journal.targetId.slice(0,12)} · ${state.journal.mode}`);
      button(warning,'核对后完成应用',()=>this.action(async()=>this.review({title:'确认完成恢复',body:'系统将逐项读取当前文件，仅当全部与目标版本精确一致时更新 HEAD。不满足时拒绝。',confirm:'核对并完成',run:()=>this.plugin.engine.finalizeJournal()})));
      button(warning,'核对后回滚',()=>this.action(async()=>this.review({title:'回滚未完成的拉取',body:'仅当文件仍是应用前或应用后原样时，恢复本地原文。若期间有第三方修改，则直接阻拦。',confirm:'回滚',run:()=>this.plugin.engine.rollbackJournal()})));
      return;
    }
    const head=el('div',root,'gs-status-bar');
    el('span',head,'',`Local: ${state.headId.slice(0,12)}`);
    el('span',head,'',`Remote: ${state.remoteHeadId?.slice(0,12)||'not fetched'}`);
    const row=el('div',root,'gs-worktrees');
    const branch=el('div',row,'gs-files');
    el('h4',branch,'','Working tree');
    let snapshot;
    try{snapshot=await this.plugin.engine.status();}
    catch(e){el('p',branch,'gs-warning',this.plugin.explain(e));return;}
    const stagedPaths=new Set(snapshot.staged.map(x=>x.path));
    const files=[...new Set([...snapshot.staged.map(x=>x.path),...snapshot.unstaged.map(x=>x.path)])].sort();
    if(!files.length)el('p',branch,'gs-muted','工作区干净。');
    for(const file of files){
      const entry=el('label',branch,'gs-file');const box=el('input',entry);box.type='checkbox';box.checked=this.checked.has(file);
      box.addEventListener('change',()=>{if(box.checked)this.checked.add(file);else this.checked.delete(file);});
      const desc=stagedPaths.has(file)?'STAGED':'MODIFIED';
      el('span',entry,'gs-path',file);el('small',entry,'',desc);
    }
    const controls=el('div',branch,'gs-controls');
    button(controls,'Stage selected',()=>this.action(()=>this.plugin.engine.stage([...this.checked])));
    button(controls,'Unstage selected',()=>this.action(()=>this.plugin.engine.unstage([...this.checked])));
    this.message=el('input',branch,'gs-input');this.message.placeholder='Commit message (why the evidence changed)';
    this.relationIds=el('input',branch,'gs-input');this.relationIds.placeholder='Related evidence IDs if needed: R-P21-01, R-P22-01';
    button(branch,'Commit staged changes',()=>this.action(async()=>{
      const message=this.message.value,ids=this.relationIds.value.split(',').map(x=>x.trim()).filter(Boolean);
      const staged=this.plugin.engine.state.staged;
      await this.review({title:'本地 Commit（不会上传）',body:Object.entries(staged).map(([p,c])=>`${p}  → ${c===null?'DELETE':c.length+' characters'}`).join('\n')+`\n\n${message}`,confirm:'保存本地 Commit',run:()=>this.plugin.engine.commit(message,ids)});
    }));
    const remote=el('div',row,'gs-remote');
    el('h4',remote,'','Remote tracking');
    const ractions=el('div',remote,'gs-controls');
    button(ractions,'Review Pull',()=>this.action(async()=>{
      const v=this.plugin.engine.preview();
      if(v.localId!==v.baseId)throw new SyncError('LOCAL_COMMITS_REQUIRE_MERGE');
      await this.review({title:'审阅 Pull 差异',body:formatPreview(v),confirm:'Apply Pull to Vault',run:()=>this.plugin.engine.pull()});
    }));
    button(ractions,'Review Merge',()=>this.action(async()=>{
      const v=this.plugin.engine.preview();if(v.disposition==='blocked')return this.displayConflicts(v);
      if(v.disposition!=='merge_ready')throw new SyncError('NO_MERGE_NEEDED');
      await this.review({title:'审阅三方合并',body:formatPreview(v),confirm:'Apply Merge to Vault',run:()=>this.plugin.engine.merge([])});
    }));
    button(ractions,'Preview Push',()=>this.action(async()=>{
      const proposed=await this.plugin.engine.preparePush();
      if(proposed.status==='already_current'){new Notice('远端已是当前版本。');return;}
      await this.review({title:'确认 Push',body:formatPreview(proposed.view)+`\n\n提交变化：\n`+
        proposed.changes.map(c=>`${c.path}: ${c.before?.length??0} → ${c.after?.length??0} characters`).join('\n')+
        '\n\n确认后仍会二次检查远端 HEAD，若已变化则拒绝发布。',
        confirm:'Publish reviewed commit',run:()=>this.plugin.engine.push(proposed.key)});
    }));
    const previewBox=el('div',remote,'gs-preview');
    try{
      const preview=this.plugin.engine.preview();
      el('p',previewBox,'',`Branch status: ${preview.disposition}`);
      el('p',previewBox,'gs-muted',`${preview.localChanged.length} local / ${preview.remoteChanged.length} remote changes`);
      if(preview.conflicts.length){
        el('strong',previewBox,'gs-danger',`${preview.conflicts.length} conflict(s) · no automatic publish`);
        button(previewBox,'Inspect base / local / remote',()=>this.displayConflicts(preview));
      }
    }catch(e){el('p',previewBox,'gs-muted',this.plugin.explain(e));}
    el('p',remote,'gs-muted','只有 mode=managed 时才能将此视为受保护的正式同步。isolated_test 仅写隔离的不可变版本库。');
  }
  async displayConflicts(preview){const text=preview.conflicts.map(c=>`${c.reason} [${c.groupId||''}]\n`+
    c.paths.map(p=>`${p}\nBASE:\n${c.base[p]??'(absent)'}\nLOCAL:\n${c.local[p]??'(absent)'}\nREMOTE:\n${c.remote[p]??'(absent)'}`).join('\n')).join('\n\n----\n\n');
    const modal=new ConfirmModal(this.app,{title:'三方冲突详情（只读）',body:text||'No conflicts.',buttonText:'关闭',onConfirm:()=>{}});modal.open();
  }
  async review({title,body,confirm,run}){new ConfirmModal(this.app,{title,body,buttonText:confirm,onConfirm:()=>this.action(run)}).open();}
  async action(fn){if(this.busy)return;this.busy=true;try{await fn();}
    catch(e){new Notice('Guarded Sync：'+this.plugin.explain(e),10000);console.warn('[Guarded Sync]',e?.code||'action_failed');}
    finally{this.busy=false;await this.render();}}
}
function formatPreview(v){return `${v.disposition}\nBASE: ${v.baseId}\nLOCAL: ${v.localId}\nREMOTE: ${v.remoteId}\n\nLOCAL CHANGED:\n${v.localChanged.join('\n')}\n\nREMOTE CHANGED:\n${v.remoteChanged.join('\n')}\n\nCONFLICTS:\n${v.conflicts.map(c=>c.reason+': '+c.paths.join(', ')).join('\n')||'(none)'}`;}
class GuardedSyncSettings extends PluginSettingTab {
  constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
  display(){const c=this.containerEl;c.empty();c.createEl('h2',{text:'Guarded Sync · local-first safety'});
    c.createEl('p',{text:'No Cloud/MCP bypass. Secrets are never kept in plugin settings. Phase C is development-only until the authenticated gateway is enabled.'});
    new Setting(c).setName('Protected project folder').setDesc('Fixed to INSES/ in v0.3; other folders are not supported.').addText(x=>x.setValue('INSES/').setDisabled(true));
    new Setting(c).setName('Guarded gateway URL').setDesc('Only a future HTTPS owner-authenticated /sync/v1 route; never an R2 bucket endpoint.')
      .addText(x=>x.setPlaceholder('https://your-worker.workers.dev/sync/v1').setValue(this.plugin.settings.gatewayUrl||'')
      .onChange(async value=>{if(value)validateEndpoint(value);this.plugin.settings.gatewayUrl=value.trim();await this.plugin.saveData(this.plugin.settings);this.plugin.rebuildRemote();}));
    c.createEl('p',{text:'Vault identity (macOS Keychain account): '+this.plugin.identity.id});
    c.createEl('p',{text:'Private commit data path (outside Vault): '+this.plugin.store.dir});
    c.createEl('p',{text:'The separate keychain service name is obsidian-guarded-sync. Never paste a token into Markdown or a synchronized plugin config.'});
  }
}
class GuardedSyncPlugin extends Plugin {
  async onload(){this.settings=Object.assign({},defaults,await this.loadData());this.identity=vaultIdentity(this.app);
    this.store=new DiskStore(this.identity.id);
    this.adapter=new ObsidianVaultAdapter(this.app,this.identity.base);
    this.engine=new LocalEngine({vault:this.adapter,store:this.store,vaultId:this.identity.id});
    await this.engine.load();this.rebuildRemote();
    this.registerView(VIEW,leaf=>new GuardedSyncView(leaf,this));
    this.addRibbonIcon('git-branch','Open Guarded Sync',()=>this.openView());
    this.addCommand({id:'open-guarded-sync',name:'Open Guarded Sync local commits and review',callback:()=>this.openView()});
    this.addSettingTab(new GuardedSyncSettings(this.app,this));
    if(this.engine.state?.journal)new Notice('Guarded Sync：检测到未完成 Pull/Merge，请打开工作台恢复。',15000);
  }
  onunload(){this.app.workspace.detachLeavesOfType(VIEW);}
  rebuildRemote(){this.engine.remote=this.settings.gatewayUrl?new GatewayRemote(this.settings.gatewayUrl,this.identity.id):null;}
  explain(error){return friendly[error?.code]||error?.code||'操作中止，未确认成功。';}
  async openView(){let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];if(!leaf){leaf=this.app.workspace.getLeaf('tab');await leaf.setViewState({type:VIEW,active:true});}this.app.workspace.revealLeaf(leaf);}
}
module.exports=GuardedSyncPlugin;
module.exports.default=GuardedSyncPlugin;
module.exports._test={DiskStore,ObsidianVaultAdapter,GatewayRemote,validateEndpoint,vaultIdentity,readOwnerKeychainToken};
