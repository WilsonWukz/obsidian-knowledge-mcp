/** Owner-authenticated, default-closed Mac sync HTTP gateway.
 * No client can bootstrap, spoof an Agent role, or write directly to R2.
 */
import {timingSafeEqual} from '../upload/tokens';
import {syncRpc,syncEnabled,syncCutover} from './rpc.ts';
import {SafeSyncError} from './protocol.ts';
import {adoptLegacyVault} from './adoption.ts';
const LIMIT=720_000;
function json(body:Record<string,unknown>,status=200):Response{
 return new Response(JSON.stringify(body),{status,headers:{
  'content-type':'application/json; charset=utf-8','cache-control':'no-store',
  'pragma':'no-cache','referrer-policy':'no-referrer','x-content-type-options':'nosniff',
 }});
}
function deny(status:number,code:string):Response{return json({error:code},status);}
function rec(x:unknown):x is Record<string,unknown>{return !!x&&typeof x==='object'&&!Array.isArray(x);}
function ipKey(req:Request):string|null{
 const ip=req.headers.get('cf-connecting-ip');
 return ip&&/^[\d.a-fA-F:]{3,64}$/.test(ip)?'sync-fails:'+ip:null;
}
async function failures(env:Env,key:string|null):Promise<number>{
 return key?Number(await env.OAUTH_KV.get(key)||'0'):0;
}
export async function handleGuardedSync(req:Request,env:Env):Promise<Response>{
 if(String(env.ENABLE_GUARDED_SYNC_API)!=='true'||!syncEnabled(env))return deny(404,'NOT_FOUND');
 if(req.method!=='POST')return deny(405,'METHOD_NOT_ALLOWED');
 if(new URL(req.url).protocol!=='https:')return deny(403,'HTTPS_REQUIRED');
 const key=ipKey(req);
 try{if((await failures(env,key))>=12)return deny(429,'RATE_LIMITED');}
 catch{return deny(503,'AUTH_BACKEND_UNAVAILABLE');}
 const expected=env.SYNC_OWNER_TOKEN;
 const received=req.headers.get('authorization');
 const valid=typeof expected==='string'&&expected.length>=32&&expected.length<=512&&
  typeof received==='string'&&received.startsWith('Bearer ')&&
  timingSafeEqual(expected,received.slice(7));
 if(!valid){
  try{if(key)await env.OAUTH_KV.put(key,String((await failures(env,key))+1),{expirationTtl:900});}
  catch{return deny(503,'AUTH_BACKEND_UNAVAILABLE');}
  return deny(401,'UNAUTHORIZED');
 }
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return deny(415,'JSON_REQUIRED');
 if(Number(req.headers.get('content-length')||0)>LIMIT)return deny(413,'PAYLOAD_TOO_LARGE');
 let obj:Record<string,unknown>;
 try{
  const raw=await req.text();
  if(new TextEncoder().encode(raw).length>LIMIT)return deny(413,'PAYLOAD_TOO_LARGE');
  obj=JSON.parse(raw) as Record<string,unknown>;
  if(!rec(obj))return deny(400,'INVALID_REQUEST');
 }catch{return deny(400,'INVALID_REQUEST');}
 try{
  if(obj.op==='status'){
   const current=await syncRpc<{headId:string|null}>(env,'status');
   return json({...current,cutover:syncCutover(env),mode:syncCutover(env)?'managed':'isolated_test'});
  }
  if(obj.op==='get'){
   if(typeof obj.id!=='string'||!/^[a-f0-9]{64}$/.test(obj.id))return deny(400,'INVALID_COMMIT_ID');
   return json(await syncRpc(env,'get',{id:obj.id}));
  }
  if(obj.op==='history'){
   const n=obj.limit===undefined?20:obj.limit;
   if(typeof n!=='number'||!Number.isInteger(n)||n<1||n>50)return deny(400,'INVALID_LIMIT');
   return json(await syncRpc(env,'history',{limit:n}));
  }
  if(obj.op==='adopt_legacy_vault'){
   if(String(env.ENABLE_SYNC_ADOPTION)!=='true'||syncCutover(env))return deny(403,'ADOPTION_DISABLED');
   if(obj.ack!=='I_HAVE_DISABLED_LEGACY_WRITERS'||typeof obj.expectedGenesisId!=='string')
    return deny(403,'ADOPTION_CONFIRMATION_REQUIRED');
   return json(await adoptLegacyVault(env,obj.expectedGenesisId));
  }
  if(obj.op==='push'){
   if(!rec(obj.input))return deny(400,'INVALID_PUSH');
   const x=obj.input;
   if(typeof x.baseId!=='string'||typeof x.expectedHead!=='string'||
      !rec(x.localFiles)||typeof x.message!=='string')return deny(400,'INVALID_PUSH');
   // Never forward actor/groups/role from an external client. The DO must
   // derive relation dependencies from the verified content itself.
   const input={baseId:x.baseId,expectedHead:x.expectedHead,
    localFiles:x.localFiles,groups:[],actor:'local',message:x.message};
   const result=await syncRpc(env,'push',{input});
   return json({...result,mode:syncCutover(env)?'managed':'isolated_test'});
  }
  return deny(403,'OPERATION_FORBIDDEN');
 }catch(e){
  if(e instanceof SafeSyncError)return deny(409,e.code);
  return deny(503,'SYNC_BACKEND_UNAVAILABLE');
 }
}
