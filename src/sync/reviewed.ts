/** Bridge existing independent browser approval to one atomic versioned HEAD. */
import {PlanError,MAX_PLAN_BYTES,prepareNoteChanges,type ImmutableNotePlan,type PlannedStep} from '../review/plan';
import {planStoreCall,type StoredPlan,type Receipt} from '../review/store';
import {viewPlan,type PlanView} from '../review/operations';
import {guardedHead,syncRpc,syncCutover} from './rpc.ts';
import {SafeSyncError,hashCanonical} from './protocol.ts';
import type {R2Client} from '../vault/r2-client';
function guard(env:Env){if(!syncCutover(env))throw new PlanError('GUARDED_SYNC_CUTOVER_DISABLED');}
function sizeof(value:unknown){return new TextEncoder().encode(JSON.stringify(value)).length;}
function expected(plan:ImmutableNotePlan){
 const p=plan as ImmutableNotePlan & {sync?:{expectedHead:string}};
 if(!p.sync||!/^[a-f0-9]{64}$/.test(p.sync.expectedHead))throw new PlanError('VERSIONED_PLAN_REQUIRED');
 return p.sync.expectedHead;
}
export async function planVersionedChanges(env:Env,actions:unknown):Promise<PlanView>{
 guard(env);
 const head=await guardedHead(env);
 const adapter:Pick<R2Client,'getWithEtag'>={
  getWithEtag:async(path:string)=>Object.hasOwn(head.files,path)?{
   body:head.files[path],etag:await hashCanonical(head.files[path]),
  }:null,
 };
 const plan=await prepareNoteChanges(adapter,actions);
 const versioned:ImmutableNotePlan & {sync:{expectedHead:string}}={...plan,
  sync:{expectedHead:head.id},
  note:'One owner-reviewed atomic version commit. Remote HEAD is rechecked on apply. Offline Mac commits remain protected by conditional push; external Remotely Save writers must be disabled.',
 };
 if(sizeof(versioned)>MAX_PLAN_BYTES)throw new PlanError('PLAN_TOO_LARGE');
 const stored=await planStoreCall<StoredPlan>(env,'create',{plan:versioned});
 return viewPlan(env,stored);
}
async function rejected(env:Env,id:string,code:string,step?:PlannedStep):Promise<PlanView>{
 const row=await planStoreCall<StoredPlan>(env,'record',{
  id,receipts:[{step:0,path:step?.path??'',state:'failed',
   before_etag:step?.before_etag??null,error:code}],status:'failed',
 });
 return viewPlan(env,row);
}
export async function applyVersionedChanges(env:Env,id:string,digest:string):Promise<PlanView>{
 guard(env);
 if(!/^[a-f0-9]{64}$/.test(digest))throw new PlanError('INVALID_DIGEST');
 const claimed=await planStoreCall<StoredPlan & {claimed:boolean}>(env,'claim',{id,digest});
 if(!claimed.claimed)return viewPlan(env,claimed);
 let attempted=false;
 const first=claimed.plan.steps[0];
 try {
  const headId=expected(claimed.plan);
  const current=await guardedHead(env);
  if(current.id!==headId)return rejected(env,id,'NOTE_VERSION_CONFLICT',first);
  const next={...current.files};
  for(const s of claimed.plan.steps){
   const before=Object.hasOwn(next,s.path)?next[s.path]:null;
   const etag=before===null?null:await hashCanonical(before);
   if(before!==s.before||etag!==s.before_etag)
    return rejected(env,id,'NOTE_VERSION_CONFLICT',s);
   next[s.path]=s.after;
  }
  attempted=true;
  const published=await syncRpc<{status:string;headId:string}>(env,'push',{
   input:{baseId:headId,expectedHead:headId,localFiles:next,
    actor:'agent',groups:[],message:'Owner-reviewed Agent plan '+id},
  });
  if(published.status!=='published')
   return rejected(env,id,published.status==='remote_advanced'?'NOTE_VERSION_CONFLICT':'VERSIONED_PUBLISH_REJECTED',first);
  const receipts:Receipt[]=await Promise.all(claimed.plan.steps.map(async(s,i)=>({
   step:i,path:s.path,state:'done' as const,before_etag:s.before_etag,
   after_etag:await hashCanonical(s.after),
  })));
  const saved=await planStoreCall<StoredPlan>(env,'record',{id,receipts,status:'applied'});
  return viewPlan(env,saved);
 } catch(e){
  // A lost RPC response could follow a successful HEAD CAS. Never retry.
  const code=e instanceof SafeSyncError?e.code:e instanceof PlanError?e.code:'UPSTREAM_RESULT_UNCERTAIN';
  if(!attempted&&code==='NOT_INITIALIZED')return rejected(env,id,code,first);
  const row=await planStoreCall<StoredPlan>(env,'record',{id,receipts:[{
   step:0,path:first?.path??'',state:'uncertain',before_etag:first?.before_etag??null,error:code,
  }],status:'uncertain'});
  return viewPlan(env,row);
 }
}
export async function prepareVersionedUndo(env:Env,id:string):Promise<PlanView>{
 guard(env);
 const original=await planStoreCall<StoredPlan>(env,'get',{id});
 if(original.status!=='applied'||original.plan.undo_of)throw new PlanError('UNDO_UNAVAILABLE');
 if(original.plan.steps.some(s=>s.before===null))throw new PlanError('UNDO_CREATE_NOT_SUPPORTED');
 if(original.plan.steps.length!==original.receipts.length||
   original.receipts.some(r=>r.state!=='done'))throw new PlanError('UNDO_UNAVAILABLE');
 const head=await guardedHead(env);
 const steps:PlannedStep[]=[];
 for(const prev of original.plan.steps){
  const body=head.files[prev.path];
  if(body===undefined||body!==prev.after)throw new PlanError('UNDO_VERSION_CONFLICT');
  steps.push({action:'restore_note',path:prev.path,before:body,
   before_etag:await hashCanonical(body),after:prev.before!});
 }
 const plan:ImmutableNotePlan & {sync:{expectedHead:string}}={
  steps,undo_of:id,sync:{expectedHead:head.id},
  note:'Separately approved reversal; blocked on later changes and never deletes newly created notes.',
 };
 if(sizeof(plan)>MAX_PLAN_BYTES)throw new PlanError('PLAN_TOO_LARGE');
 const saved=await planStoreCall<StoredPlan>(env,'create',{plan});
 return viewPlan(env,saved);
}
