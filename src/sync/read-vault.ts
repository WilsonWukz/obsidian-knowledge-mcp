/** Authoritative Markdown overlay in managed cutover mode.
 * Existing PDF/attachment R2 objects remain read-only in the old Vault.
 */
import {R2Client} from '../vault/r2-client';
import type {VaultConfig} from '../types';
import {guardedHead,syncCutover} from './rpc.ts';
import {hashCanonical,type FileSnapshot} from './protocol.ts';
export class GuardedReadVault extends R2Client{
 constructor(bucket:R2Bucket,cfg:VaultConfig,private readonly guardedEnv:Env){super(bucket,cfg);}
 private managed(path:string):boolean{return path.startsWith('INSES/')&&path.endsWith('.md');}
 private async snapshot():Promise<FileSnapshot>{return (await guardedHead(this.guardedEnv)).files;}
 override async get(path:string):Promise<string|null>{
  if(!this.managed(path))return super.get(path);
  const files=await this.snapshot();return Object.hasOwn(files,path)?files[path]:null;
 }
 override async getWithEtag(path:string):Promise<{body:string;etag:string}|null>{
  if(!this.managed(path))return super.getWithEtag(path);
  const files=await this.snapshot();
  return Object.hasOwn(files,path)?{body:files[path],etag:await hashCanonical(files[path])}:null;
 }
 override async listMarkdownWithMeta():Promise<{path:string;etag:string}[]>{
  const others=(await super.listMarkdownWithMeta()).filter(v=>!this.managed(v.path));
  const files=await this.snapshot();
  const managed=await Promise.all(Object.entries(files).map(async([path,body])=>({
   path,etag:await hashCanonical(body),
  })));
  return [...others,...managed].sort((a,b)=>a.path.localeCompare(b.path));
 }
 override async listMarkdown():Promise<string[]>{
  return (await this.listMarkdownWithMeta()).map(x=>x.path);
 }
}
export function makeReadableVault(env:Env,cfg:VaultConfig):R2Client{
 return syncCutover(env)?new GuardedReadVault(env.VAULT,cfg,env):new R2Client(env.VAULT,cfg);
}
