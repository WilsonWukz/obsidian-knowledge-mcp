/** Internal Worker → singleton Durable Object transport. */
import {SafeSyncError,type SyncCommit} from './protocol.ts';
export function syncEnabled(env:Env):boolean{
 return String(env.ENABLE_GUARDED_SYNC)==='true'&&!!env.SYNC_LEDGER&&!!env.SYNC_OBJECTS;
}
export function syncCutover(env:Env):boolean{
 const wantsManaged=String(env.GUARDED_SYNC_CUTOVER)==='true';
 if(wantsManaged&&!syncEnabled(env))throw new SafeSyncError('CUTOVER_MISCONFIGURED');
 return wantsManaged;
}
export async function syncRpc<T extends Record<string,unknown>>(
 env:Env,op:string,params:Record<string,unknown>={},
):Promise<T>{
 if(!syncEnabled(env))throw new SafeSyncError('SYNC_FEATURE_DISABLED');
 const stub=env.SYNC_LEDGER.get(env.SYNC_LEDGER.idFromName('owner-guarded-sync-v1'));
 const result=await stub.fetch('https://internal.guarded-sync/rpc',{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({op,...params}),
 });
 let data:Record<string,unknown>;
 try{data=await result.json() as Record<string,unknown>;}
 catch{throw new SafeSyncError('SYNC_BACKEND_UNAVAILABLE');}
 if(!result.ok)throw new SafeSyncError(typeof data.error==='string'?data.error:'SYNC_BACKEND_UNAVAILABLE');
 return data as T;
}
export async function guardedHead(env:Env):Promise<SyncCommit>{
 const state=await syncRpc<{headId:string|null}>(env,'status');
 if(!state.headId)throw new SafeSyncError('NOT_INITIALIZED');
 const result=await syncRpc<{commit:SyncCommit}>(env,'get',{id:state.headId});
 return result.commit;
}
