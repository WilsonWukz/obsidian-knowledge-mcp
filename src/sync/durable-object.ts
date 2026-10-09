/**
 * Internal-only Durable Object for isolated guarded-sync state.
 * There is deliberately NO public handler, OAuth route or MCP tool invoking
 * this in v0.3 Phase B. This class alone does NOT protect the live Vault.
 */
import { DurableObject } from 'cloudflare:workers';
import { SafeSyncError } from './protocol.ts';
import { SqliteSyncLedger, type SyncTransaction } from './sqlite-ledger.ts';
import { SyncObjectStore } from './object-store.ts';

const MAX_REQUEST_BYTES=720_000;
function safeError(error:unknown):string {
  if(error instanceof SafeSyncError)return error.code;
  return 'SYNC_BACKEND_UNAVAILABLE';
}
export class GuardedSyncLedger extends DurableObject<Env> {
  private readonly ledger:SqliteSyncLedger;
  constructor(ctx:DurableObjectState,env:Env){
    super(ctx,env);
    // Dedicated bucket. Never use env.VAULT for immutable history storage.
    this.ledger=new SqliteSyncLedger(
      ctx.storage as unknown as SyncTransaction,
      new SyncObjectStore(env.SYNC_OBJECTS),
    );
  }
  async fetch(request:Request):Promise<Response>{
    if(request.method!=='POST')return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405});
    if(String(this.env.ENABLE_GUARDED_SYNC)!=='true')
      return Response.json({error:'SYNC_FEATURE_DISABLED'},{status:503});
    // No public endpoint reaches this Durable Object in Phase B. This is a
    // privileged internal RPC; future external callers need verified OAuth
    // identity, owner-approved commits, quota/rate limits and client binding.
    const size=Number(request.headers.get('content-length')||0);
    if(size>MAX_REQUEST_BYTES)return Response.json({error:'PAYLOAD_TOO_LARGE'},{status:413});
    try {
      const raw=await request.text();
      if(new TextEncoder().encode(raw).length>MAX_REQUEST_BYTES)
        return Response.json({error:'PAYLOAD_TOO_LARGE'},{status:413});
      const input=JSON.parse(raw) as Record<string,unknown>;
      const op=input.op;
      if(op==='status')return Response.json({headId:this.ledger.headId()});
      if(op==='history')return Response.json({history:await this.ledger.history(Number(input.limit??20))});
      if(op==='get'){
        if(typeof input.id!=='string')throw new SafeSyncError('INVALID_COMMIT_ID');
        return Response.json({commit:await this.ledger.get(input.id)});
      }
      if(op==='read_file'){
        if(typeof input.id!=='string'||typeof input.path!=='string')
          throw new SafeSyncError('INVALID_FILE_REQUEST');
        return Response.json({body:await this.ledger.fileAt(input.id,input.path)});
      }
      if(op==='bootstrap'){
        // Genesis may be used only after a separate audited adoption step.
        // An already-initialized ledger cannot be reset through the RPC.
        return Response.json(await this.ledger.bootstrap(input.files as never));
      }
      if(op==='push'){
        const options=input.input;
        if(!options||typeof options!=='object'||Array.isArray(options))
          throw new SafeSyncError('INVALID_PUSH');
        return Response.json(await this.ledger.push(options as Parameters<SqliteSyncLedger['push']>[0]));
      }
      throw new SafeSyncError('UNKNOWN_OPERATION');
    }catch(error){
      const code=safeError(error);
      return Response.json({error:code},{status:error instanceof SafeSyncError?409:503});
    }
  }
}