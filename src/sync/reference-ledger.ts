/**
 * Deterministic reference ledger for tests and protocol simulations.
 * NOT a live/production backend: this intentionally has no durability/auth.
 * The Durable Object implementation must preserve these safety invariants.
 */
import {SafeSyncError,makeGenesis,makeCommit,threeWayMerge,validateGroups,
  diffSnapshots,verifyCommit,type SyncCommit,type FileSnapshot,type SemanticGroup,
  type Actor,type MergePreview} from './protocol.ts';

export type PublishOutcome =
  | {status:'published';head:SyncCommit;preview:MergePreview}
  | {status:'already_current';head:SyncCommit;preview:MergePreview}
  | {status:'conflict';head:SyncCommit;preview:MergePreview}
  | {status:'remote_advanced';head:SyncCommit};

export class ReferenceLedger {
  private revisions=new Map<string,SyncCommit>();
  private current='';
  static async bootstrap(files:FileSnapshot):Promise<ReferenceLedger>{
    const ledger=new ReferenceLedger();
    const genesis=await makeGenesis(files);
    ledger.revisions.set(genesis.id,genesis);ledger.current=genesis.id;
    return ledger;
  }
  head():SyncCommit {return this.get(this.current);}
  get(id:string):SyncCommit{
    const found=this.revisions.get(id);
    if(!found)throw new SafeSyncError('UNKNOWN_REVISION');
    return structuredClone(found);
  }
  get size():number{return this.revisions.size;}
  private remoteGroupsSince(base:string):SemanticGroup[]{
    const groups:SemanticGroup[]=[];
    let cursor=this.head();
    const visited=new Set<string>();
    // The reference implementation models one canonical head lineage;
    // if a parent graph becomes ambiguous, reject rather than guess.
    while(cursor.id!==base){
      if(visited.has(cursor.id)||!cursor.parents.length)
        throw new SafeSyncError('UNRELATED_HISTORY');
      visited.add(cursor.id);
      groups.push(...cursor.groups);
      cursor=this.get(cursor.parents[0]);
    }
    return groups;
  }
  /**
   * A local commit records the EXACT state relative to the observed base.
   * The head lease is rechecked after async hashing; no stale commit is accepted.
   * If remote moved while offline, require explicit preflight/review before push.
   */
  async push(input:{
    baseId:string;expectedHead:string;localFiles:FileSnapshot;
    groups:SemanticGroup[];actor:Actor;message:string;
  }):Promise<PublishOutcome>{
    const initialHead=this.head();
    if(input.expectedHead!==initialHead.id)
      return {status:'remote_advanced',head:initialHead};
    const base=this.get(input.baseId);
    const localChanges=diffSnapshots(base.files,input.localFiles);
    if(!localChanges.length){
      const view=threeWayMerge(base.files,base.files,initialHead.files);
      return {status:'already_current',head:initialHead,preview:view};
    }
    const localGroups=validateGroups(input.groups,localChanges.map(c=>c.path));
    const remoteGroups=this.remoteGroupsSince(base.id);
    const preview=threeWayMerge(base.files,input.localFiles,initialHead.files,localGroups,remoteGroups);
    if(preview.disposition==='blocked')return {status:'conflict',head:initialHead,preview};
    const merged=preview.merged;
    if(!merged)throw new SafeSyncError('EMPTY_MERGE');
    const changedOnRemote=diffSnapshots(initialHead.files,merged);
    if(!changedOnRemote.length)return {status:'already_current',head:initialHead,preview};
    if(changedOnRemote.length>5)throw new SafeSyncError('TOO_MANY_FILES');
    const qualifyingGroups=localGroups.filter(g=>g.paths.some(p=>changedOnRemote.some(c=>c.path===p)));
    const proposal=await makeCommit({parent:initialHead,files:merged,
      groups:qualifyingGroups,actor:input.actor,message:input.message});
    await verifyCommit(proposal,initialHead);
    // In a Durable Object, compare-and-swap must be performed as a *single*
    // SQLite transaction with the ref mutation, not read-then-write to R2.
    if(this.current!==input.expectedHead)
      return {status:'remote_advanced',head:this.head()};
    this.revisions.set(proposal.id,proposal);
    this.current=proposal.id;
    return {status:'published',head:this.head(),preview};
  }
}