/**
 * Independent, password-protected browser review.
 *
 * An MCP client cannot self-approve by supplying "confirmed": true.
 * Private before/after Markdown is shown ONLY after owner password + CSRF.
 * The browser approval transitions the stored plan; it never performs R2 I/O.
 */
import { signValue, verifyValue, timingSafeEqual } from "../upload/tokens";
import { isRateLimited, recordAuthFailure, clearAuthFailures } from "../auth/rate-limit";
import { PlanError } from "./plan";
import { planStoreCall, type StoredPlan } from "./store";

const CSRF_COOKIE="obs_review_csrf";
const PROOF_COOKIE="obs_review_proof";
const MAX_PASSWORD_ATTEMPTS=10;
const PROOF_TTL_MS=10*60*1000;

function escapeHtml(s:string):string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function cookie(req:Request,name:string):string|null {
  const chunk=req.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith(name+"="));
  return chunk?chunk.slice(name.length+1):null;
}
function random():string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,"0")).join("");
}
function formToken(req:Request,form:FormData):boolean {
  const expected=cookie(req,CSRF_COOKIE);
  const provided=form.get("csrf");
  return !!expected && typeof provided==="string" && timingSafeEqual(expected,provided);
}
function originMatches(req:Request):boolean {
  const origin=req.headers.get("origin");
  return !!origin && origin===new URL(req.url).origin;
}
function page(body:string,status=200):Response {
  return new Response("<!doctype html><html lang='zh-CN'><head>"+
    "<meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"+
    "<title>Obsidian · Review exact changes</title>"+
    "<style>body{font:16px system-ui;margin:auto;max-width:900px;padding:2rem;line-height:1.5;}"+
    "pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:32rem;overflow-y:auto;border:1px solid #bbb;padding:1rem;}"+
    "input{font-size:1rem;padding:.6rem;margin:.5rem 0;}button{padding:.7rem 1.1rem;}"+
    ".warning{border-left:4px solid #a67c36;padding:1rem;background:#f5f0e8;}"+
    "section{margin:1.5rem 0;border-top:1px solid #aaa;padding-top:1rem}</style></head><body>"+
    body+"</body></html>",{
    status,headers:{
      "content-type":"text/html; charset=utf-8",
      "cache-control":"no-store",
      "referrer-policy":"no-referrer",
      "x-content-type-options":"nosniff",
      "x-frame-options":"DENY",
      "content-security-policy":"default-src 'none'; form-action 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}
function csrfCookie(token:string):string {
  return CSRF_COOKIE+"="+token+"; Path=/review/; Max-Age=900; HttpOnly; Secure; SameSite=Strict";
}
function proofCookie(token:string,maxAge:number):string {
  return PROOF_COOKIE+"="+token+"; Path=/review/; Max-Age="+maxAge+"; HttpOnly; Secure; SameSite=Strict";
}
function noAccess(body:string,status:number):Response {
  return page("<h1>Obsidian Knowledge MCP · Review</h1><p>"+escapeHtml(body)+"</p>",status);
}
function login(id:string):Response {
  const csrf=random();
  const p=page("<h1>Review exact Obsidian changes</h1>"+
    "<p class='warning'>Only the vault owner should open this page. Before/after notes stay hidden until password verification. "+
    "Approval does not write any file; return to the MCP client to apply the exact plan.</p>"+
    "<form method='post' action='/review/"+encodeURIComponent(id)+"/view'>"+
    "<input name='csrf' type='hidden' value='"+csrf+"'>"+
    "<label>Owner login password <input type='password' name='password' autocomplete='off' minlength='16' required></label>"+
    "<button type='submit'>Unlock preview</button></form>");
  p.headers.append("set-cookie",csrfCookie(csrf));
  return p;
}
function previewPage(plan:StoredPlan,proof:string,csrf:string):Response {
  const blocks=plan.plan.steps.map((step,i)=>
    "<section><h2>"+escapeHtml(String(i+1)+". "+step.action+" — "+step.path)+"</h2>"+
    "<p>Expected R2 ETag: "+escapeHtml(step.before_etag??"(new note)")+"</p>"+
    "<h3>Before (exact)</h3><pre>"+escapeHtml(step.before??"(file does not exist)")+"</pre>"+
    "<h3>After (exact)</h3><pre>"+escapeHtml(step.after)+"</pre></section>",
  ).join("");
  const p=page(
    "<h1>Obsidian · Review exact changes</h1>"+
    "<p class='warning'>Review the full content. Never approve before your Mac has synced pending offline edits. "+
    "This is not a multi-file atomic transaction. Versions will be rechecked when applying.</p>"+
    "<p><strong>Plan:</strong> "+escapeHtml(plan.id)+"</p>"+
    "<p><strong>Digest:</strong> "+escapeHtml(plan.digest)+"</p>"+
    "<p><strong>Expires:</strong> "+escapeHtml(new Date(plan.expires).toISOString())+"</p>"+
    "<p><strong>Warnings:</strong> "+escapeHtml(plan.plan.note)+"</p>"+blocks+
    "<form method='post' action='/review/"+encodeURIComponent(plan.id)+"/approve'>"+
    "<input type='hidden' name='csrf' value='"+escapeHtml(csrf)+"'>"+
    "<input type='hidden' name='proof' value='"+escapeHtml(proof)+"'>"+
    "<button type='submit'>Approve exact changes</button></form>"+
    "<p>You may close this page without approving; the plan will expire.</p>",
  );
  p.headers.append("set-cookie",proofCookie(proof,600));
  return p;
}
export async function handleReview(req:Request,env:Env):Promise<Response|null> {
  const url=new URL(req.url);
  const m=/^\/review\/([A-Za-z0-9_-]{32})(?:\/(view|approve))?$/.exec(url.pathname);
  if(!url.pathname.startsWith("/review/"))return null;
  if(env.ENABLE_REVIEWED_WRITES!=="true")return noAccess("Reviewed writes are disabled",404);
  if(!m)return noAccess("Not found",404);
  const id=m[1],route=m[2]??"";
  if(url.protocol!=="https:") {
    url.protocol="https:";
    return Response.redirect(url,308);
  }
  if(req.method==="GET" && !route) return login(id);
  if(req.method!=="POST" || !originMatches(req))return noAccess("Invalid review request",403);
  const form=await req.formData();
  if(!formToken(req,form))return noAccess("CSRF validation failed; reopen the review link",403);
  if(route==="view"){
    const supplied=form.get("password"), ip=req.headers.get("cf-connecting-ip")??"";
    if(typeof supplied!=="string"||!env.AUTH_PASSWORD||env.AUTH_PASSWORD.length<32)
      return noAccess("Login misconfigured",503);
    if(await isRateLimited(env.OAUTH_KV,ip))return noAccess("Too many attempts",429);
    if(!timingSafeEqual(supplied,env.AUTH_PASSWORD)){
      await recordAuthFailure(env.OAUTH_KV,ip);
      return noAccess("Invalid password; reopen review link",401);
    }
    await clearAuthFailures(env.OAUTH_KV,ip);
    try {
      const plan=await planStoreCall<StoredPlan>(env,"get",{id});
      if(plan.status!=="pending"||plan.expires<=Date.now())
        return noAccess("Plan expired or not pending; generate a new one",409);
      const payload=btoa(JSON.stringify({
        id,digest:plan.digest,exp:Math.min(plan.expires,Date.now()+PROOF_TTL_MS),
        nonce:cookie(req,CSRF_COOKIE),
      }));
      const proof=await signValue(env.AUTH_PASSWORD,payload);
      return previewPage(plan,proof,cookie(req,CSRF_COOKIE)!);
    }catch(e) {
      return noAccess(e instanceof PlanError?e.code:"Unable to load plan",409);
    }
  }
  if(route==="approve"){
    const provided=form.get("proof"), token=cookie(req,PROOF_COOKIE);
    if(typeof provided!=="string" || !token || !timingSafeEqual(provided,token))
      return noAccess("Review session is missing or expired",403);
    const data=await verifyValue(env.AUTH_PASSWORD,provided);
    if(!data)return noAccess("Invalid approval proof",403);
    let signed:{id:string;digest:string;exp:number;nonce:string};
    try { signed=JSON.parse(atob(data)); }catch { return noAccess("Invalid proof contents",403); }
    if(signed.id!==id || signed.exp<Date.now() ||
       !timingSafeEqual(signed.nonce||"",cookie(req,CSRF_COOKIE)||"")){
      return noAccess("Expired or mismatched approval",403);
    }
    try {
      const approved=await planStoreCall<StoredPlan>(env,"approve",{id,digest:signed.digest});
      const res=page("<h1>Approved</h1><p>Exact plan "+escapeHtml(id)+
        " approved. No Obsidian files have been modified yet. Return to ChatGPT / Slack Jarvis to execute apply_note_changes.</p>");
      res.headers.append("set-cookie",proofCookie("",0));
      return res;
    }catch(e){
      return noAccess(e instanceof PlanError?e.code:"Unable to approve plan",409);
    }
  }
  return noAccess("Not found",404);
}
