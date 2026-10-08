/** Reviewed R2 writes: one-shot claims, CAS/version guards, durable receipts. */
import type { R2Client } from "../vault/r2-client";
import { validateWritablePath, PlanError, MAX_PLAN_BYTES,
  prepareNoteChanges, previewPlan, type ImmutableNotePlan, type PlannedStep } from "./plan";
import { planStoreCall, type Receipt, type StoredPlan } from "./store";

export interface PlanView {
  plan_id:string; digest:string; status:string; expires_at:number;
  review_url:string|null; review_path:string;
  preview:ReturnType<typeof previewPlan>;
  receipts:Receipt[];
  undo_of?:string;
  warning:string;
  mac_sync_status:"not_verified"|"not_applicable";
  mac_sync_instruction:string;
}

export function viewPlan(env:Env, row:StoredPlan):PlanView {
  const review_path="/review/"+row.id;
  const base=env.SERVICE_BASE_URL?.replace(/\/+$/,"")||"";
  return {
    plan_id:row.id,digest:row.digest,status:row.status,
    expires_at:row.expires,review_path,
    review_url:base?base+review_path:null,
    preview:previewPlan(row.plan),
    receipts:row.receipts,
    ...(row.plan.undo_of?{undo_of:row.plan.undo_of}:{}),
    warning:row.plan.note,
    mac_sync_status:row.status==="applied"?"not_verified":"not_applicable",
    mac_sync_instruction:"In Mac Obsidian, run Remotely Save bidirectional sync to pull new cloud notes; check for conflicts and verify contents. Cloud write does not guarantee Mac synchronization.",
  };
}
export async function planNoteChanges(env:Env,vault:R2Client,actions:unknown):Promise<PlanView> {
  const plan=await prepareNoteChanges(vault,actions);
  const result=await planStoreCall<StoredPlan>(env,"create",{plan});
  return viewPlan(env,result);
}
export async function getNotePlan(env:Env,id:string):Promise<PlanView> {
  const row=await planStoreCall<StoredPlan>(env,"get",{id});
  return viewPlan(env,row);
}
export async function cancelNotePlan(env:Env,id:string):Promise<PlanView> {
  const row=await planStoreCall<StoredPlan>(env,"cancel",{id});
  return viewPlan(env,row);
}
export async function listNoteHistory(env:Env,start=0,limit=20) {
  return planStoreCall(env,"history",{start,limit});
}
export async function prepareUndo(env:Env,vault:R2Client,id:string):Promise<PlanView> {
  const original=await planStoreCall<StoredPlan>(env,"get",{id});
  if(original.status!=="applied")throw new PlanError("UNDO_UNAVAILABLE","Only fully applied plans can be undone");
  if(original.plan.undo_of)throw new PlanError("UNDO_OF_UNDO_NOT_SUPPORTED");
  if(original.plan.steps.some(s=>s.before===null)) {
    throw new PlanError("UNDO_CREATE_NOT_SUPPORTED","No automatic deletion of newly created notes; review locally");
  }
  if(original.plan.steps.length!==original.receipts.length ||
     original.receipts.some(r=>r.state!=="done"||!r.after_etag)) {
    throw new PlanError("UNDO_UNAVAILABLE");
  }
  const steps:PlannedStep[]=[];
  for(let i=0;i<original.plan.steps.length;i++){
    const step=original.plan.steps[i],receipt=original.receipts[i];
    validateWritablePath(step.path);
    const existing=await vault.getWithEtag(step.path);
    if(!existing || existing.etag!==receipt.after_etag) {
      throw new PlanError("UNDO_VERSION_CONFLICT","The note has changed since the plan was applied");
    }
    steps.push({
      action:"restore_note",path:step.path,
      before:existing.body,before_etag:existing.etag,
      after:step.before as string,
    });
  }
  const inverse:ImmutableNotePlan={
    steps,undo_of:id,
    note:"Separately reviewed restore of previously modified notes. Creates are not auto-deleted. Each changed R2 version is verified again at apply.",
  };
  if(new TextEncoder().encode(JSON.stringify(inverse)).length>MAX_PLAN_BYTES){
    throw new PlanError("PLAN_TOO_LARGE");
  }
  const plan=await planStoreCall<StoredPlan>(env,"create",{plan:inverse});
  return viewPlan(env,plan);
}

function failMessage(e:unknown):string {
  if(e instanceof PlanError)return e.code;
  // Never leak R2 internal request URLs/headers or credentials to tools.
  return "UPSTREAM_RESULT_UNCERTAIN";
}

/** No auto-retry: R2 mutations are not in the same transaction as the plan DO. */
export async function applyNotePlan(
  env:Env,
  vault:R2Client,
  id:string,
  digest:string,
  onWritten?: (path:string, content:string, etag:string)=>void,
):Promise<PlanView> {
  if(!/^[a-f0-9]{64}$/.test(digest))throw new PlanError("INVALID_DIGEST");
  const claimed=await planStoreCall<StoredPlan & {claimed:boolean}>(
    env,"claim",{id,digest},
  );
  if(!claimed.claimed){
    return viewPlan(env,claimed); // terminal result: never replay an upstream write
  }
  const receipts:Receipt[]=[];
  for(let i=0;i<claimed.plan.steps.length;i++){
    const s=claimed.plan.steps[i];
    let current;
    try {
      validateWritablePath(s.path); // defense in depth, even for a stored plan
      current=await vault.getWithEtag(s.path);
    } catch {
      receipts.push({step:i,path:s.path,state:"uncertain",before_etag:s.before_etag,
        error:"R2_READ_UNCERTAIN"});
      return viewPlan(env,await planStoreCall<StoredPlan>(env,"record",{
        id,receipts,status:"uncertain",
      }));
    }
    const observedEtag=current?.etag??null;
    if(observedEtag!==s.before_etag || (s.before!==null && current?.body!==s.before)) {
      receipts.push({step:i,path:s.path,state:"failed",before_etag:s.before_etag,
        error:"NOTE_VERSION_CONFLICT"});
      return viewPlan(env,await planStoreCall<StoredPlan>(env,"record",{
        id,receipts,status:i===0?"failed":"partial",
      }));
    }
    let newEtag:string|null;
    try {
      if(s.before_etag===null){
        newEtag=await vault.putIfAbsent(s.path,s.after);
      }else{
        newEtag=await vault.putIfMatch(s.path,s.after,s.before_etag);
      }
    } catch {
      receipts.push({step:i,path:s.path,state:"uncertain",before_etag:s.before_etag,
        error:"R2_WRITE_RESULT_UNCERTAIN"});
      return viewPlan(env,await planStoreCall<StoredPlan>(env,"record",{
        id,receipts,status:"uncertain",
      }));
    }
    if(newEtag===null){
      receipts.push({step:i,path:s.path,state:"failed",before_etag:s.before_etag,
        error:"CONDITIONAL_WRITE_CONFLICT"});
      return viewPlan(env,await planStoreCall<StoredPlan>(env,"record",{
        id,receipts,status:i===0?"failed":"partial",
      }));
    }
    receipts.push({
      step:i,path:s.path,state:"done",before_etag:s.before_etag,after_etag:newEtag,
    });
    // The success receipt is persisted before the next write. If recording
    // fails, do not retry: on restart the plan will still be "applying".
    const status=i===claimed.plan.steps.length-1?"applied":"applying";
    const recorded=await planStoreCall<StoredPlan>(env,"record",{id,receipts,status});
    try { onWritten?.(s.path,s.after,newEtag); }catch {
      // Search cache is derived state; a failed index update is not a
      // reason to replay a successfully committed R2 write.
    }
    if(status==="applied")return viewPlan(env,recorded);
  }
  throw new PlanError(failMessage(new Error("Unreachable apply outcome")));
}
