/**
 * Dedicated singleton SQLite-backed Durable Object: immutable owner-reviewed
 * change plans, one-shot atomic claims, and durable per-file operation receipts.
 *
 * MCP sessions get separate Durable Objects in the Agents SDK. This dedicated
 * DO is deliberately global to the single owner's vault, so approval and
 * history survive new clients, Slack sessions, restarts and redeployments.
 *
 * Important: R2 operations cannot participate in SQLite transactions.
 * A claim is persisted before sending a write; an interrupted "applying"
 * operation must be manually reconciled and is NEVER blindly retried.
 */
import { DurableObject } from "cloudflare:workers";
import { PlanError, digestPlan, type ImmutableNotePlan } from "./plan";

export type PlanStatus = "pending"|"approved"|"applying"|"applied"|"failed"|"partial"|"uncertain"|"cancelled";
export type Receipt = {
  step: number;
  path: string;
  state: "done"|"failed"|"uncertain";
  before_etag: string|null;
  after_etag?: string;
  error?: string;
};
export interface StoredPlan {
  id: string;
  digest: string;
  created: number;
  expires: number;
  status: PlanStatus;
  plan: ImmutableNotePlan;
  receipts: Receipt[];
}
type Row = {
  id:string;digest:string;created:number;expires:number;status:PlanStatus;
  body:string;receipts:string;
};
const RETENTION = 7 * 86_400_000;
const EXPIRY = 30 * 60_000;

export class ReviewPlans extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx,env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS note_plans ("+
      "id TEXT PRIMARY KEY,digest TEXT NOT NULL,created INTEGER NOT NULL,"+
      "expires INTEGER NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,receipts TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS note_plans_created "+
      "ON note_plans(created DESC,id)");
  }

  private row(id:string):Row|null {
    return (this.ctx.storage.sql.exec("SELECT * FROM note_plans WHERE id = ?",id)
      .toArray()[0] as Row | undefined) ?? null;
  }
  private unpack(row:Row):StoredPlan {
    return { id:row.id,digest:row.digest,created:row.created,expires:row.expires,
      status:row.status,plan:JSON.parse(row.body),receipts:JSON.parse(row.receipts) };
  }
  private async verified(id:string):Promise<StoredPlan> {
    const row=this.row(id);
    if(!row)throw new PlanError("PLAN_NOT_FOUND");
    const record=this.unpack(row);
    if (await digestPlan(record.plan) !== record.digest) throw new PlanError("PLAN_INTEGRITY_ERROR");
    return record;
  }
  private transition(id:string,previous:PlanStatus,next:PlanStatus,unexpired=true) {
    const now=Date.now();
    const sql=unexpired
      ? "UPDATE note_plans SET status=? WHERE id=? AND status=? AND expires>?"
      : "UPDATE note_plans SET status=? WHERE id=? AND status=?";
    const cursor=unexpired
      ? this.ctx.storage.sql.exec(sql,next,id,previous,now)
      : this.ctx.storage.sql.exec(sql,next,id,previous);
    if(cursor.rowsWritten!==1)throw new PlanError("PLAN_STATE_CONFLICT");
  }

  async fetch(request:Request):Promise<Response> {
    if(request.method!=="POST")return Response.json({error:"METHOD_NOT_ALLOWED"},{status:405});
    try {
      const {op, ...params} = await request.json() as Record<string,unknown>;
      const id=params.id;
      const validId=typeof id==="string" && /^[a-zA-Z0-9_-]{32}$/.test(id);
      if(op!=="create" && op!=="history" && !validId)throw new PlanError("INVALID_PLAN_ID");
      switch(op) {
        case "create": {
          const plan=params.plan as ImmutableNotePlan;
          if(!plan || !Array.isArray(plan.steps)||plan.steps.length<1||plan.steps.length>5)
            throw new PlanError("INVALID_PLAN");
          const raw=JSON.stringify(plan);
          if(new TextEncoder().encode(raw).length>700_000)throw new PlanError("PLAN_TOO_LARGE");
          const digest=await digestPlan(plan);
          const now=Date.now();
          const id=crypto.randomUUID().replaceAll("-","");
          this.ctx.storage.transactionSync(()=>{
            this.ctx.storage.sql.exec(
              "DELETE FROM note_plans WHERE created<? AND status NOT IN ('applying','uncertain')",
              now-RETENTION,
            );
            const count=this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM note_plans").toArray()[0] as {n:number};
            if(count.n >= 300)throw new PlanError("HISTORY_FULL");
            this.ctx.storage.sql.exec(
              "INSERT INTO note_plans VALUES(?,?,?,?,?,?,?)",
              id,digest,now,now+EXPIRY,"pending",raw,"[]",
            );
          });
          return Response.json(await this.verified(id));
        }
        case "get":
          return Response.json(await this.verified(id as string));
        case "approve": {
          const current=await this.verified(id as string);
          if(current.digest!==params.digest)throw new PlanError("DIGEST_MISMATCH");
          this.transition(id as string,"pending","approved");
          return Response.json(await this.verified(id as string));
        }
        case "cancel": {
          const current=await this.verified(id as string);
          if(current.status==="pending"||current.status==="approved") {
            this.transition(id as string,current.status,"cancelled",false);
          } else throw new PlanError("PLAN_STATE_CONFLICT");
          return Response.json(await this.verified(id as string));
        }
        case "claim": {
          const current=await this.verified(id as string);
          if(current.digest!==params.digest)throw new PlanError("DIGEST_MISMATCH");
          if(current.status==="applied"||current.status==="failed"||
             current.status==="partial"||current.status==="uncertain") {
            return Response.json({ ...current, claimed:false });
          }
          if(current.status!=="approved")throw new PlanError("OWNER_APPROVAL_REQUIRED");
          this.transition(id as string,"approved","applying");
          return Response.json({ ...current, claimed:true });
        }
        case "record": {
          const current=await this.verified(id as string);
          if(current.status!=="applying")throw new PlanError("PLAN_STATE_CONFLICT");
          const receipts=params.receipts;
          const status=params.status;
          if(!Array.isArray(receipts)||receipts.length>current.plan.steps.length||
             !["applying","applied","failed","partial","uncertain"].includes(status as string)) {
            throw new PlanError("INVALID_RECEIPTS");
          }
          if(receipts.length<current.receipts.length ||
             current.receipts.some((v,i)=>JSON.stringify(v)!==JSON.stringify(receipts[i]))) {
            throw new PlanError("RECEIPT_CONFLICT");
          }
          if(status==="applied" && (receipts.length!==current.plan.steps.length||
             receipts.some(r=>!r || r.state!=="done"))) throw new PlanError("INCOMPLETE_APPLY");
          this.ctx.storage.sql.exec(
            "UPDATE note_plans SET receipts=?,status=? WHERE id=? AND status='applying'",
            JSON.stringify(receipts),status,id,
          );
          return Response.json(await this.verified(id as string));
        }
        case "history": {
          const start=Number(params.start??0),limit=Number(params.limit??20);
          if(!Number.isInteger(start)||start<0||start>1000||
             !Number.isInteger(limit)||limit<1||limit>50)throw new PlanError("INVALID_PAGINATION");
          const rows=this.ctx.storage.sql.exec(
            "SELECT id,digest,created,expires,status FROM note_plans "+
            "ORDER BY created DESC,id LIMIT ? OFFSET ?", limit+1,start,
          ).toArray();
          return Response.json({
            plans:rows.slice(0,limit),
            next_start:rows.length>limit?start+limit:null,
          });
        }
        default: throw new PlanError("UNKNOWN_OPERATION");
      }
    }catch(e) {
      const code=e instanceof PlanError?e.code:"INTERNAL_STORE_ERROR";
      return Response.json({error:code},{status:e instanceof PlanError?409:500});
    }
  }
}

/** Durable Object is not reachable from public HTTP; use this internal stub. */
export async function planStoreCall<T = Record<string,unknown>>(
  env:Env, op:string, values:Record<string,unknown>={},
):Promise<T> {
  if(!env.REVIEW_PLANS)throw new PlanError("STORE_NOT_CONFIGURED");
  const stub=env.REVIEW_PLANS.get(env.REVIEW_PLANS.idFromName("owner-reviewed-notes-v1"));
  const result=await stub.fetch("https://review.internal/ops",{
    method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({op,...values}),
  });
  const data=await result.json() as Record<string,unknown>;
  if(!result.ok)throw new PlanError(String(data.error??"STORE_ERROR"));
  return data as T;
}
