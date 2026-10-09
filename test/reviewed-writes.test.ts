import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { R2Client } from "../src/vault/r2-client";
import { makeCfg } from "./_helpers";
import { PlanError, validateActions, prepareNoteChanges } from "../src/review/plan";
import { planStoreCall, type StoredPlan } from "../src/review/store";
import { planNoteChanges, applyNotePlan, prepareUndo } from "../src/review/operations";
import { handleReview } from "../src/review/http";

const base="https://vault.example.test";
const configured = () => ({ ...env, ENABLE_REVIEWED_WRITES:"true",
  AUTH_PASSWORD:"test-password-0123456789abcdef0123456789",
  SERVICE_BASE_URL:base,
} as unknown as Env);
const vault = () => new R2Client(env.VAULT,makeCfg());
function unique(label="Note"){return "INSES/"+label+"-"+crypto.randomUUID().replaceAll("-","")+".md";}
async function directApproval(id:string,digest:string) {
  return planStoreCall<StoredPlan>(configured(),"approve",{id,digest});
}

async function reviewInBrowser(id:string, wrong=false){
  const e=configured();
  const response=await handleReview(new Request(base+"/review/"+id),e);
  expect(response?.status).toBe(200);
  const raw=await response!.text();
  expect(raw).not.toContain("Private citation marker");
  const csrfCookie=(response!.headers.get("set-cookie")||"").split(";")[0];
  const csrf=csrfCookie.split("=")[1];
  const headers={"content-type":"application/x-www-form-urlencoded","origin":base,"cookie":csrfCookie};
  const preview=await handleReview(new Request(base+"/review/"+id+"/view",{
    method:"POST",headers,
    body:new URLSearchParams({csrf,password:wrong?"incorrect":e.AUTH_PASSWORD}),
  }),e);
  if(wrong){expect(preview?.status).toBe(401);return;}
  expect(preview?.status).toBe(200);
  const html=await preview!.text();
  expect(html).toContain("Private citation marker");
  const proof=/name='proof' value='([^']+)'/.exec(html)?.[1];
  expect(proof).toBeTruthy();
  const proofCookie=(preview!.headers.get("set-cookie")||"").split(";")[0];
  const missingAck=await handleReview(new Request(base+"/review/"+id+"/approve",{
    method:"POST",headers:{...headers,cookie:csrfCookie+"; "+proofCookie},
    body:new URLSearchParams({csrf,proof:proof!}),
  }),e);
  expect(missingAck?.status).toBe(403);
  const approval=await handleReview(new Request(base+"/review/"+id+"/approve",{
    method:"POST",headers:{...headers,cookie:csrfCookie+"; "+proofCookie},
    body:new URLSearchParams({csrf,proof:proof!,mac_ack:"yes"}),
  }),e);
  expect(approval?.status).toBe(200);
}

describe("Obsidian v0.2 reviewed R2 writes (synthetic vault only)",()=>{
  it("rejects traversal, hidden config, cross-vault notes and malformed YAML",async()=>{
    for(const p of ["Graph.md","INSES/../Secrets.md","INSES/.obsidian/data.md","INSES/x/../../abc.md","INSES\\x.md"]){
      expect(()=>validateActions([{action:"create_note",path:p,content:"# blocked"}])).toThrow(PlanError);
    }
    const path=unique();
    await expect(prepareNoteChanges(vault(),[{action:"create_note",path,
      content:"---\nkey: [\n---\n# text"}])).rejects.toMatchObject({code:"INVALID_YAML"});
    await expect(prepareNoteChanges(vault(),[{action:"patch_frontmatter",path,
      set:{id:"forged"}}])).rejects.toMatchObject({code:"INVALID_FRONTMATTER"});
    expect(()=>validateActions(Array.from({length:6},(_,i)=>({action:"create_note",path:unique("N"+i),content:"abc"})))).toThrow(PlanError);
  });

  it("requires real independent browser approval and executes each write once",async()=>{
    const path=unique(), content="---\ntags: [paper]\n---\n# INSES\nPrivate citation marker";
    const e=configured();
    const p=await planNoteChanges(e,vault(),[{action:"create_note",path,content}]);
    expect(p.status).toBe("pending");
    expect(p.review_url).toBe(base+p.review_path);
    expect(await vault().get(path)).toBeNull();
    await expect(applyNotePlan(e,vault(),p.plan_id,p.digest)).rejects.toMatchObject({code:"OWNER_APPROVAL_REQUIRED"});
    await reviewInBrowser(p.plan_id,true);
    await expect(applyNotePlan(e,vault(),p.plan_id,p.digest)).rejects.toMatchObject({code:"OWNER_APPROVAL_REQUIRED"});
    await reviewInBrowser(p.plan_id);
    const applied=await applyNotePlan(e,vault(),p.plan_id,p.digest);
    expect(applied.status).toBe("applied");
    expect(applied.mac_sync_status).toBe("not_verified");
    expect(applied.mac_sync_instruction).toContain("bidirectional");
    expect(applied.receipts).toHaveLength(1);
    expect(applied.receipts[0].state).toBe("done");
    const current=await vault().getWithEtag(path);
    expect(current?.body).toContain("Private citation marker");
    expect(await vault().head(path)).not.toBeNull();
    // Simulate a second connector/process reading the same R2 remote copy.
    const r2Rows=await env.VAULT.list({prefix:"INSES/"});
    expect(r2Rows.objects.some(row=>row.key===path)).toBe(true);
    const again=await applyNotePlan(e,vault(),p.plan_id,p.digest);
    expect(again.status).toBe("applied");
    expect((await vault().getWithEtag(path))?.etag).toBe(current?.etag);
  });

  it("browser approval denies cross-origin and missing CSRF",async()=>{
    const e=configured();
    const p=await planNoteChanges(e,vault(),[{action:"create_note",path:unique(),content:"# harmless"}]);
    const response=await handleReview(new Request(base+p.review_path+"/view",{
      method:"POST",headers:{"origin":"https://attacker.example","content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({csrf:"forged",password:e.AUTH_PASSWORD}),
    }),e);
    expect(response?.status).toBe(403);
    expect((await planStoreCall<StoredPlan>(e,"get",{id:p.plan_id})).status).toBe("pending");
  });

  it("stale remote changes fail instead of replacing Mac-synced versions",async()=>{
    const e=configured(),v=vault(),path=unique();
    await v.put(path,"# local text");
    const p=await planNoteChanges(e,v,[{action:"replace_note",path,content:"# agent change"}]);
    await directApproval(p.plan_id,p.digest);
    await v.put(path,"# fresh editor change");
    const result=await applyNotePlan(e,v,p.plan_id,p.digest);
    expect(result.status).toBe("failed");
    expect(result.receipts[0].error).toBe("NOTE_VERSION_CONFLICT");
    expect(await v.get(path)).toBe("# fresh editor change");
  });

  it("atomic conditional create protects a note uploaded by Obsidian",async()=>{
    const v=vault(),path=unique();
    await v.put(path,"# local uploaded");
    expect(await v.putIfAbsent(path,"# agent conflicting create")).toBeNull();
    expect(await v.get(path)).toBe("# local uploaded");
  });

  it("creates and edits a batch of two notes, both discoverable to syncing S3 clients",async()=>{
    const e=configured(),v=vault(),p1=unique("Paper1"),p2=unique("Paper2");
    const planned=await planNoteChanges(e,v,[
      {action:"create_note",path:p1,content:"# P1\n[[P2]]"},
      {action:"create_note",path:p2,content:"# P2\n[[P1]]"},
    ]);
    await directApproval(planned.plan_id,planned.digest);
    const done=await applyNotePlan(e,v,planned.plan_id,planned.digest);
    expect(done.status).toBe("applied");
    expect(done.receipts.map(x=>x.state)).toEqual(["done","done"]);
    const objects=await env.VAULT.list({prefix:"INSES/"});
    const found=new Set(objects.objects.map(o=>o.key));
    expect(found.has(p1)&&found.has(p2)).toBe(true);
    expect(await v.get(p1)).toContain("[[P2]]");
    expect(await v.get(p2)).toContain("[[P1]]");
  });

  it("can version-check a separate undo for edits, but refuses auto-delete of created notes",async()=>{
    const e=configured(),v=vault(),path=unique();
    await v.put(path,"---\nid: stable-identifier\ntags: [paper]\n---\n# Before");
    const p=await planNoteChanges(e,v,[{action:"replace_note",path,content:"# After"}]);
    await directApproval(p.plan_id,p.digest);
    const applied=await applyNotePlan(e,v,p.plan_id,p.digest);
    expect(applied.status).toBe("applied");
    expect(await v.get(path)).toContain("id: stable-identifier");
    const undo=await prepareUndo(e,v,p.plan_id);
    expect(undo.status).toBe("pending");
    await directApproval(undo.plan_id,undo.digest);
    const restored=await applyNotePlan(e,v,undo.plan_id,undo.digest);
    expect(restored.status).toBe("applied");
    expect(await v.get(path)).toContain("# Before");

    const created=await planNoteChanges(e,v,[{action:"create_note",path:unique(),content:"# new"}]);
    await directApproval(created.plan_id,created.digest);
    expect((await applyNotePlan(e,v,created.plan_id,created.digest)).status).toBe("applied");
    await expect(prepareUndo(e,v,created.plan_id)).rejects.toMatchObject({code:"UNDO_CREATE_NOT_SUPPORTED"});
  });

  it("rejects undo if Mac/another client changed a note after the reviewed write",async()=>{
    const e=configured(),v=vault(),path=unique();
    await v.put(path,"# before");
    const p=await planNoteChanges(e,v,[{action:"replace_note",path,content:"# reviewed"}]);
    await directApproval(p.plan_id,p.digest);
    expect((await applyNotePlan(e,v,p.plan_id,p.digest)).status).toBe("applied");
    await v.put(path,"# Mac modified later");
    await expect(prepareUndo(e,v,p.plan_id)).rejects.toMatchObject({code:"UNDO_VERSION_CONFLICT"});
  });

  it("never retries an uncertain R2 operation, preserving uncertain receipt",async()=>{
    const e=configured(),v=vault(),path=unique(),p=await planNoteChanges(e,vault(),
      [{action:"create_note",path,content:"# uncertain"}]);
    await directApproval(p.plan_id,p.digest);
    let writes=0;
    const uncertain={
      async getWithEtag(){return null;},
      async putIfAbsent(){writes++;throw new Error("network result unknown");},
    } as unknown as R2Client;
    const r=await applyNotePlan(e,uncertain,p.plan_id,p.digest);
    expect(r.status).toBe("uncertain");
    expect(writes).toBe(1);
    expect((await applyNotePlan(e,uncertain,p.plan_id,p.digest)).status).toBe("uncertain");
    expect(writes).toBe(1);
  });

  it("cancellation cannot be applied; persistent status survives separate caller",async()=>{
    const e=configured();
    const p=await planNoteChanges(e,vault(),[{action:"create_note",path:unique(),content:"# no writes"}]);
    await planStoreCall(e,"cancel",{id:p.plan_id});
    const row=await planStoreCall<StoredPlan>(e,"get",{id:p.plan_id});
    expect(row.status).toBe("cancelled");
    await expect(applyNotePlan(e,vault(),p.plan_id,p.digest)).rejects.toMatchObject({code:"OWNER_APPROVAL_REQUIRED"});
  });
  it("the independent approval preview escapes HTML in an AI-authored note", async()=>{
    const e=configured(),path=unique("UnsafeMarkup");
    const raw="<img src=x onerror=alert(1)> & test";
    const draft=await planNoteChanges(e,vault(),[{action:"create_note",path,content:raw}]);
    const res=await handleReview(new Request(base+"/review/"+draft.plan_id),e);
    const csrfCookie=(res!.headers.get("set-cookie")??"").split(";")[0];
    const csrf=csrfCookie.split("=")[1];
    const post=await handleReview(new Request(base+"/review/"+draft.plan_id+"/view",{
      method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","origin":base,"cookie":csrfCookie},
      body:new URLSearchParams({csrf,password:e.AUTH_PASSWORD}),
    }),e);
    expect(post?.status).toBe(200);
    const html=await post!.text();
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&amp; test");
    expect((await planStoreCall<StoredPlan>(e,"get",{id:draft.plan_id})).status).toBe("pending");
  });

  it("concurrent independent clients cannot claim the same approved plan twice", async()=>{
    const e=configured(),path=unique("Concurrent");
    const p=await planNoteChanges(e,vault(),[{action:"create_note",path,content:"# concurrency"}]);
    await directApproval(p.plan_id,p.digest);
    const [a,b]=await Promise.allSettled([
      planStoreCall<StoredPlan & {claimed:boolean}>(e,"claim",{id:p.plan_id,digest:p.digest}),
      planStoreCall<StoredPlan & {claimed:boolean}>(e,"claim",{id:p.plan_id,digest:p.digest}),
    ]);
    const successes=[a,b].filter(x=>x.status==="fulfilled");
    expect(successes).toHaveLength(1);
    const claimed=successes[0] as PromiseFulfilledResult<StoredPlan & {claimed:boolean}>;
    expect(claimed.value.claimed).toBe(true);
    const denied=[a,b].filter(x=>x.status==="rejected") as PromiseRejectedResult[];
    expect(denied).toHaveLength(1);
    expect(denied[0].reason).toMatchObject({code:"OWNER_APPROVAL_REQUIRED"});
    expect((await planStoreCall<StoredPlan>(e,"get",{id:p.plan_id})).status).toBe("applying");
  });

  it("multi-note conflicts remain partial and cannot be re-applied automatically", async()=>{
    const e=configured(),v=vault(),first=unique("PartialOne"),second=unique("PartialTwo");
    const p=await planNoteChanges(e,v,[
      {action:"create_note",path:first,content:"# first"},
      {action:"create_note",path:second,content:"# second"},
    ]);
    await directApproval(p.plan_id,p.digest);
    let completedFirst=false;
    const raced={
      getWithEtag:async (path:string)=>{
        if(path===second && completedFirst){
          return {body:"# Mac change",etag:"unexpected-other-writer"};
        }
        return v.getWithEtag(path);
      },
      putIfAbsent:async (path:string,content:string)=>{
        const etag=await v.putIfAbsent(path,content);
        if(path===first && etag!==null)completedFirst=true;
        return etag;
      },
      putIfMatch:(path:string,body:string,etag:string)=>v.putIfMatch(path,body,etag),
    } as unknown as R2Client;
    const result=await applyNotePlan(e,raced,p.plan_id,p.digest);
    expect(result.status).toBe("partial");
    expect(result.receipts.map(x=>x.state)).toEqual(["done","failed"]);
    expect(result.receipts[1].error).toBe("NOTE_VERSION_CONFLICT");
    expect(await v.get(first)).toContain("# first");
    expect(await v.get(second)).toBeNull();
    const again=await applyNotePlan(e,raced,p.plan_id,p.digest);
    expect(again.status).toBe("partial");
    expect(again.receipts).toEqual(result.receipts);
  });

  it("cannot strip or silently change a stable note identifier", async()=>{
    const path=unique("Stable"),v=vault();
    await v.put(path,"---\nid: fixed-note-id\n---\n# Intro");
    await expect(prepareNoteChanges(v,[{
      action:"patch_note",path,old_text:"id: fixed-note-id",new_text:"id: hacked-id",
    }])).rejects.toMatchObject({code:"STABLE_NOTE_ID_REQUIRED"});
    await expect(prepareNoteChanges(v,[{
      action:"patch_note",path,old_text:"id: fixed-note-id",new_text:"",
    }])).rejects.toMatchObject({code:"STABLE_NOTE_ID_REQUIRED"});
  });

  it("accepts genuine browser form POSTs with no Origin when CSRF cookie and field match",async()=>{
    const e=configured();
    const path=unique("OriginFreeBrowser");
    const draft=await planNoteChanges(e,vault(),[
      {action:"create_note",path,content:"# Login preview should be reachable"},
    ]);
    const page=await handleReview(new Request(base+"/review/"+draft.plan_id),e);
    expect(page?.status).toBe(200);
    const csrfCookie=(page!.headers.get("set-cookie")??"").split(";")[0];
    const csrf=csrfCookie.split("=")[1];
    const view=async (headers:Record<string,string>)=>
      handleReview(new Request(base+"/review/"+draft.plan_id+"/view",{
        method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",cookie:csrfCookie,...headers},
        body:new URLSearchParams({csrf,password:e.AUTH_PASSWORD}),
      }),e);
    const chrome=await view({"sec-fetch-site":"same-origin"});
    expect(chrome?.status).toBe(200);
    expect(await chrome!.text()).toContain("Login preview should be reachable");
    const privacy=await view({});
    expect(privacy?.status).toBe(200);
    expect(await privacy!.text()).toContain("Login preview should be reachable");
    // Previewing changes never approves or mutates the vault.
    expect((await planStoreCall<StoredPlan>(e,"get",{id:draft.plan_id})).status).toBe("pending");
    expect(await vault().get(path)).toBeNull();
  });

  it("rejects explicit foreign or opaque Origin and cross-site form POSTs",async()=>{
    const e=configured();
    const path=unique("OriginRejected");
    const draft=await planNoteChanges(e,vault(),[
      {action:"create_note",path,content:"# Must remain private"},
    ]);
    const page=await handleReview(new Request(base+"/review/"+draft.plan_id),e);
    const csrfCookie=(page!.headers.get("set-cookie")??"").split(";")[0];
    const csrf=csrfCookie.split("=")[1];
    for(const headers of [
      {origin:"https://attacker.example"},
      {origin:"null"},
      {"sec-fetch-site":"cross-site"},
      {"sec-fetch-site":"same-site"},
      {referer:"https://attacker.example/page"},
    ]){
      const res=await handleReview(new Request(base+"/review/"+draft.plan_id+"/view",{
        method:"POST",
        headers:{"content-type":"application/x-www-form-urlencoded",cookie:csrfCookie,...headers},
        body:new URLSearchParams({csrf,password:e.AUTH_PASSWORD}),
      }),e);
      expect(res?.status).toBe(403);
      expect((await res!.text())).toContain("Invalid review request");
    }
    const withoutToken=await handleReview(new Request(base+"/review/"+draft.plan_id+"/view",{
      method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",cookie:csrfCookie},
      body:new URLSearchParams({csrf:"wrong",password:e.AUTH_PASSWORD}),
    }),e);
    expect(withoutToken?.status).toBe(403);
    expect((await withoutToken!.text())).toContain("CSRF validation failed");
    expect((await planStoreCall<StoredPlan>(e,"get",{id:draft.plan_id})).status).toBe("pending");
  });

});
