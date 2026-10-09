/** Server-derived semantic dependency groups; client declarations are never authoritative. */
import {SafeSyncError,validateGroups,diffSnapshots,validateSnapshot,type FileSnapshot,type SemanticGroup} from './protocol.ts';
const RELATION=/\bR-[A-Za-z0-9-]{2,110}\b/g;
const VALID=/^R-[A-Za-z0-9-]{2,110}$/;
function ids(body:string):Set<string>{return new Set((body.match(RELATION)??[]).filter(x=>VALID.test(x)));}
function changedLines(before:string,after:string):string[]{
 const seen=new Map<string,number>();
 for(const x of before.split(/\r?\n/))seen.set(x,(seen.get(x)??0)+1);
 const added:string[]=[];
 for(const x of after.split(/\r?\n/)){const count=seen.get(x)??0;if(count)seen.set(x,count-1);else added.push(x);}
 const removed:string[]=[];
 for(const [x,n] of seen)for(let i=0;i<n;i++)removed.push(x);
 return [...added,...removed];
}
export function deriveServerGroups(base:FileSnapshot,candidate:FileSnapshot):SemanticGroup[]{
 validateSnapshot(base);validateSnapshot(candidate);
 const changes=diffSnapshots(base,candidate);
 if(!changes.length)return [];
 const affected=new Set<string>();
 for(const step of changes){
  const before=step.before??'',after=step.after??'';
  const all=new Set([...ids(before),...ids(after)]);
  if(!all.size)continue;
  if(step.after===null&&all.size>1)throw new SafeSyncError('SEMANTIC_SCOPE_REQUIRED');
  const changed=new Set(changedLines(before,after).flatMap(line=>[...ids(line)]));
  if(!changed.size){
   if(all.size!==1)throw new SafeSyncError('SEMANTIC_SCOPE_REQUIRED',step.path);
   affected.add([...all][0]);
  }else for(const id of changed)affected.add(id);
 }
 if(affected.size>11)throw new SafeSyncError('SEMANTIC_SCOPE_TOO_WIDE');
 const out:SemanticGroup[]=[];
 for(const id of [...affected].sort()){
  const paths=[...new Set([base,candidate].flatMap(snapshot=>
   Object.entries(snapshot).filter(([,body])=>ids(body).has(id)).map(([path])=>path)
  ))].sort();
  if(paths.length>25)throw new SafeSyncError('SEMANTIC_GROUP_TOO_WIDE');
  out.push({id:'relation:'+id,paths});
 }
 const modified=changes.map(x=>x.path);
 if(modified.length>1){
  let h=2166136261;
  for(const c of modified.join('|')){h^=c.charCodeAt(0);h=Math.imul(h,16777619)>>>0;}
  out.push({id:'batch:'+h.toString(16).padStart(8,'0'),paths:modified});
 }
 return validateGroups(out,modified);
}
