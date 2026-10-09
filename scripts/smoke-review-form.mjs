/**
 * Nonmutating live acceptance probe: GET login then POST a synthetic wrong
 * password with a valid CSRF cookie/form token. Never approves a real plan.
 */
import { randomUUID } from "node:crypto";

const base=process.argv[2];
if(!base)throw Error("Expected the deployed Worker public origin");
const origin=new URL(base);
if(origin.protocol!=="https:" || !origin.hostname.endsWith(".workers.dev") ||
   origin.pathname!=="/" || origin.search || origin.hash){
  throw Error("Refusing to probe anything except an HTTPS workers.dev origin");
}
const id="00000000000000000000000000000000";
const login=await fetch(new URL("/review/"+id,origin),{
  redirect:"manual",cache:"no-store",
});
if(login.status!==200)throw Error("Review login GET did not return 200; HTTP "+login.status);
const page=await login.text();
const cookie=login.headers.get("set-cookie")??"";
const token=/obs_review_csrf=([0-9a-f]{48})/.exec(cookie)?.[1];
if(!token || !page.includes("name='csrf' type='hidden' value='"+token+"'")){
  throw Error("Review CSRF cookie/form pair missing");
}
const form=new URLSearchParams({
  csrf:token,password:"invalid-smoke-test-password-"+randomUUID(),
});
const verify=await fetch(new URL("/review/"+id+"/view",origin),{
  method:"POST",redirect:"manual",
  headers:{
    "content-type":"application/x-www-form-urlencoded",
    "cookie":"obs_review_csrf="+token,
    "origin":"null",
    "sec-fetch-site":"same-site",
  },
  body:form.toString(),
});
const body=await verify.text();
if(verify.status!==401 || !body.includes("Invalid password")){
  const category=body.includes("FETCH_SITE_")?"FETCH_SITE_REJECTED":
    body.includes("ORIGIN_MISMATCH")?"ORIGIN_REJECTED":
    body.includes("FORM_METHOD_NOT_POST")?"FORM_METHOD_REWRITTEN":
    body.includes("CSRF validation")?"CSRF_COOKIE_NOT_FORWARDED":
    "OTHER_REVIEW_ERROR";
  throw Error("Live review form smoke failed: "+category+" HTTP "+verify.status);
}
console.log("Real Worker review login POST accepted CSRF and reached password verifier.");
console.log("Probe used only a fabricated plan ID and invalid password; zero vault writes.");
