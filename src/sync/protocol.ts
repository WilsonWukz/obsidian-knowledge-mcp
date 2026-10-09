/**
 * Safe Sync v0.3 — pure version and conflict protocol.
 * This module does not modify R2 or a Vault. Full enforcement requires a
 * managed client and a single authoritative write gateway.
 */
export const SYNC_PROTOCOL_VERSION = 1;
export const MANAGED_PREFIX = 'INSES/';
export const MAX_FILES_PER_COMMIT = 5;
export const MAX_NOTE_BYTES = 96_000;
export const MAX_COMMIT_BYTES = 650_000;
export const MAX_GROUPS_PER_COMMIT = 12;

export type FileSnapshot = Record<string,string>;
export type Actor = 'local'|'agent'|'merge'|'migration';
export interface SemanticGroup {id:string;paths:string[]}
export interface FileChange {path:string;before:string|null;after:string|null}
export interface SyncCommit {
  protocol:typeof SYNC_PROTOCOL_VERSION;
  id:string;
  parents:string[];
  createdAt:string;
  actor:Actor;
  message:string;
  files:FileSnapshot;
  changes:FileChange[];
  groups:SemanticGroup[];
}
export type ConflictReason = 'SAME_FILE_DIVERGED'|'SEMANTIC_GROUP_OVERLAP';
export interface Conflict {
  reason:ConflictReason;
  paths:string[];
  groupId?:string;
  base:Record<string,string|null>;
  local:Record<string,string|null>;
  remote:Record<string,string|null>;
}
export interface MergePreview {
  disposition:'unchanged'|'fast_forward_local'|'fast_forward_remote'|'merge_ready'|'blocked';
  merged:FileSnapshot|null;
  localChanged:string[];
  remoteChanged:string[];
  conflicts:Conflict[];
}
export class SafeSyncError extends Error {
  readonly code:string;
  constructor(code:string,message=code){super(message);this.code=code;this.name='SafeSyncError';}
}
const enc=new TextEncoder();
function bytes(s:string):number {return enc.encode(s).length;}
function sorted(o:Record<string,unknown>):string[]{return Object.keys(o).sort();}
function exact(files:FileSnapshot,path:string):string|null {
  return Object.prototype.hasOwnProperty.call(files,path)?files[path]:null;
}
function copy(files:FileSnapshot):FileSnapshot {
  return Object.fromEntries(sorted(files).map(p=>[p,files[p]]));
}
function changed(a:FileSnapshot,b:FileSnapshot):string[]{
  return [...new Set([...Object.keys(a),...Object.keys(b)])].sort().filter(p=>exact(a,p)!==exact(b,p));
}
function values(paths:string[],files:FileSnapshot):Record<string,string|null>{
  return Object.fromEntries(paths.map(p=>[p,exact(files,p)]));
}
export function validateManagedPath(path:string):void {
  if(typeof path!=='string'||path.length<MANAGED_PREFIX.length+4||path.length>220||
     !path.startsWith(MANAGED_PREFIX)||!path.endsWith('.md')||
     path.includes('\\')||path.includes('//')||/[\x00-\x1f\x7f]/.test(path)||
     path.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.'))||
     /%(?:2e|2f|5c)/i.test(path)){
    throw new SafeSyncError('INVALID_PATH',`Outside managed scope: ${path}`);
  }
}
export function validateSnapshot(snapshot:unknown):asserts snapshot is FileSnapshot {
  if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))throw new SafeSyncError('INVALID_SNAPSHOT');
  const rec=snapshot as Record<string,unknown>;
  if(Object.keys(rec).length>2000)throw new SafeSyncError('SNAPSHOT_TOO_LARGE');
  for(const [path,body] of Object.entries(rec)){
    validateManagedPath(path);
    if(typeof body!=='string'||bytes(body)>MAX_NOTE_BYTES)throw new SafeSyncError('INVALID_CONTENT',path);
  }
}
export function diffSnapshots(a:FileSnapshot,b:FileSnapshot):FileChange[]{
  validateSnapshot(a);validateSnapshot(b);
  return changed(a,b).map(path=>({path,before:exact(a,path),after:exact(b,path)}));
}
export function validateGroups(groups:SemanticGroup[],paths:string[]):SemanticGroup[]{
  if(!Array.isArray(groups)||groups.length>MAX_GROUPS_PER_COMMIT)throw new SafeSyncError('INVALID_GROUPS');
  const ids=new Set<string>();
  const out:SemanticGroup[]=[];
  for(const group of groups){
    if(!group||typeof group.id!=='string'||
       !/^[a-zA-Z0-9][a-zA-Z0-9:_./-]{0,119}$/.test(group.id)||
       !Array.isArray(group.paths)||!group.paths.length||group.paths.length>25)
      throw new SafeSyncError('INVALID_GROUP');
    if(ids.has(group.id))throw new SafeSyncError('DUPLICATE_GROUP');
    ids.add(group.id);
    for(const path of group.paths)validateManagedPath(path);
    const members=[...new Set(group.paths)].sort();
    if(!members.some(p=>paths.includes(p)))throw new SafeSyncError('UNTOUCHED_GROUP',group.id);
    out.push({id:group.id,paths:members});
  }
  if(paths.length>1&&!out.some(g=>paths.every(p=>g.paths.includes(p))))
    throw new SafeSyncError('GROUP_REQUIRED','Multi-file edits must declare a semantic group covering every changed file');
  if(paths.length===1&&!out.length)out.push({id:`file:${paths[0]}`,paths:[paths[0]]});
  return out.sort((a,b)=>a.id.localeCompare(b.id));
}
export async function hashCanonical(value:unknown):Promise<string>{
  const digest=await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function makeCommit(args:{
  parent:SyncCommit|null;files:FileSnapshot;actor:Actor;message:string;
  groups?:SemanticGroup[];createdAt?:string;
}):Promise<SyncCommit>{
  validateSnapshot(args.files);
  const changes=diffSnapshots(args.parent?.files??{},args.files);
  if(!changes.length)throw new SafeSyncError('NO_OP');
  if(changes.length>MAX_FILES_PER_COMMIT)throw new SafeSyncError('TOO_MANY_FILES');
  if(!['local','agent','merge','migration'].includes(args.actor))throw new SafeSyncError('INVALID_ACTOR');
  if(typeof args.message!=='string'||!args.message.trim()||args.message.length>300)
    throw new SafeSyncError('INVALID_MESSAGE');
  const groups=validateGroups(args.groups??[],changes.map(c=>c.path));
  const createdAt=args.createdAt??new Date().toISOString();
  if(Number.isNaN(Date.parse(createdAt)))throw new SafeSyncError('INVALID_DATE');
  const raw={protocol:SYNC_PROTOCOL_VERSION as typeof SYNC_PROTOCOL_VERSION,parents:args.parent?[args.parent.id]:[],
    createdAt,actor:args.actor,message:args.message.trim(),files:copy(args.files),changes,groups};
  if(bytes(JSON.stringify(raw))>MAX_COMMIT_BYTES)throw new SafeSyncError('COMMIT_TOO_LARGE');
  return {...raw,id:await hashCanonical(raw)};
}
/** A migration anchor can cover more than 5 existing notes without editing any of them. */
export async function makeGenesis(files:FileSnapshot,createdAt='1970-01-01T00:00:00.000Z'):Promise<SyncCommit>{
  validateSnapshot(files);
  const raw={protocol:SYNC_PROTOCOL_VERSION as typeof SYNC_PROTOCOL_VERSION,parents:[],createdAt,actor:'migration' as Actor,
    message:'Adopt existing vault snapshot; no notes written',files:copy(files),changes:[] as FileChange[],
    groups:[] as SemanticGroup[]};
  return {...raw,id:await hashCanonical(raw)};
}
export async function verifyCommit(commit:SyncCommit,parent:SyncCommit|null):Promise<void>{
  if(!commit||commit.protocol!==SYNC_PROTOCOL_VERSION||!Array.isArray(commit.parents)||
     commit.parents.length!==(parent?1:0)||(parent&&commit.parents[0]!==parent.id))
    throw new SafeSyncError('PARENT_MISMATCH');
  const rebuilt=parent?await makeCommit({parent,files:commit.files,actor:commit.actor,
    message:commit.message,groups:commit.groups,createdAt:commit.createdAt}):
    await makeGenesis(commit.files,commit.createdAt);
  if(rebuilt.id!==commit.id||JSON.stringify(rebuilt.changes)!==JSON.stringify(commit.changes))
    throw new SafeSyncError('COMMIT_INTEGRITY_ERROR');
}
export function threeWayMerge(base:FileSnapshot,local:FileSnapshot,remote:FileSnapshot,
                             localGroups:SemanticGroup[]=[],remoteGroups:SemanticGroup[]=[]):MergePreview{
  validateSnapshot(base);validateSnapshot(local);validateSnapshot(remote);
  const localChanged=changed(base,local),remoteChanged=changed(base,remote);
  const paths=[...new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)])].sort();
  const merged:FileSnapshot={};
  const conflicts:Conflict[]=[];
  const divergent=new Set<string>();
  for(const path of paths){
    const common=exact(base,path),ours=exact(local,path),theirs=exact(remote,path);
    const changedHere=ours!==common,changedThere=theirs!==common;
    if(changedHere&&changedThere&&ours!==theirs){
      conflicts.push({reason:'SAME_FILE_DIVERGED',paths:[path],
        base:{[path]:common},local:{[path]:ours},remote:{[path]:theirs}});
      divergent.add(path);
      continue;
    }
    const final=changedHere?ours:theirs;
    if(final!==null)merged[path]=final;
  }
  // A relationship summary and its evidence block may be in DIFFERENT files.
  // File-disjoint patches still conflict if their declared semantic groups
  // overlap by relation ID or by a group member path.
  for(const lg of localGroups){
    if(!lg.paths.some(p=>localChanged.includes(p)))continue;
    for(const rg of remoteGroups){
      if(!rg.paths.some(p=>remoteChanged.includes(p)))continue;
      const intersect=lg.paths.filter(p=>rg.paths.includes(p));
      if(lg.id!==rg.id&&!intersect.length)continue;
      const involved=[...new Set([...lg.paths,...rg.paths])].sort();
      if(involved.every(p=>exact(local,p)===exact(remote,p)))continue;
      if(involved.length===1&&divergent.has(involved[0]))continue;
      if(conflicts.some(c=>c.reason==='SEMANTIC_GROUP_OVERLAP'&&c.paths.join('|')===involved.join('|')))continue;
      conflicts.push({reason:'SEMANTIC_GROUP_OVERLAP',paths:involved,
        groupId:lg.id===rg.id?lg.id:`${lg.id} × ${rg.id}`,
        base:values(involved,base),local:values(involved,local),remote:values(involved,remote)});
    }
  }
  if(conflicts.length)return {disposition:'blocked',merged:null,localChanged,remoteChanged,conflicts};
  const disposition=localChanged.length===0&&remoteChanged.length===0?'unchanged':
    localChanged.length===0?'fast_forward_remote':remoteChanged.length===0?'fast_forward_local':'merge_ready';
  return {disposition,merged:copy(merged),localChanged,remoteChanged,conflicts};
}
export function previewPush(args:{
  base:SyncCommit;local:SyncCommit;remote:SyncCommit;
  localGroups?:SemanticGroup[];remoteGroups?:SemanticGroup[];
}):MergePreview&{expectedHead:string}{
  if(args.local.id!==args.base.id&&!args.local.parents.includes(args.base.id)&&!args.localGroups)
    throw new SafeSyncError('LOCAL_LINEAGE_UNVERIFIED');
  if(args.remote.id!==args.base.id&&!args.remote.parents.includes(args.base.id)&&!args.remoteGroups)
    throw new SafeSyncError('REMOTE_LINEAGE_UNVERIFIED');
  const view=threeWayMerge(args.base.files,args.local.files,args.remote.files,
    args.localGroups??args.local.groups,args.remoteGroups??args.remote.groups);
  return {...view,expectedHead:args.remote.id};
}