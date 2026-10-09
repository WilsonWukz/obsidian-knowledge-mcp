/**
 * Durable commit history and an authoritative atomic HEAD pointer.
 * No public route, authentication, live vault mutation or Remotely Save cutover.
 * This core is injectable so the exact Cloudflare SQLite/R2 protocol can be
 * tested with Node's SQLite and simulated R2 failures before deployment.
 */
import {
  SafeSyncError, makeCommit, makeGenesis, verifyCommit, diffSnapshots,
  validateGroups, threeWayMerge, type FileSnapshot, type SemanticGroup,
  type Actor, type SyncCommit, type MergePreview,
} from './protocol.ts';
import { SyncObjectStore, type StagedCommit } from './object-store.ts';

export interface SqlResult { toArray():Array<Record<string,unknown>>; rowsWritten:number }
export interface SyncSql {
  exec(query:string,...args:(string|number|null)[]):SqlResult;
}
export interface SyncTransaction {
  sql:SyncSql;
  transactionSync<T>(f:()=>T):T;
}
export interface HeadRow { id:string; parent:string|null; treeId:string; actor:string; createdAt:string }
export type PushResponse =
 | {status:'published';headId:string;preview:MergePreview}
 | {status:'already_current';headId:string;preview:MergePreview}
 | {status:'conflict';headId:string;preview:MergePreview}
 | {status:'remote_advanced';headId:string};
export const HEAD_NAME='main';
const ID=/^[a-f0-9]{64}$/;

export class SqliteSyncLedger {
  private readonly storage:SyncTransaction;
  private readonly objects:SyncObjectStore;
  constructor(storage:SyncTransaction,objects:SyncObjectStore){
    this.storage=storage;this.objects=objects;
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS sync_commits ('+
      'id TEXT PRIMARY KEY, parent TEXT, tree_id TEXT NOT NULL, actor TEXT NOT NULL,'+
      'created_at TEXT NOT NULL)');
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS sync_refs ('+
      'name TEXT PRIMARY KEY, head TEXT NOT NULL)');
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS sync_parent ON sync_commits(parent)');
  }
  private current():string|null {
    const rows=this.storage.sql.exec('SELECT head FROM sync_refs WHERE name=?',HEAD_NAME).toArray();
    return rows.length ? String(rows[0].head):null;
  }
  headId():string|null{return this.current();}
  private row(id:string):HeadRow{
    if(!ID.test(id))throw new SafeSyncError('INVALID_COMMIT_ID');
    const rows=this.storage.sql.exec(
      'SELECT id,parent,tree_id,actor,created_at FROM sync_commits WHERE id=?',id).toArray();
    if(!rows.length)throw new SafeSyncError('UNKNOWN_REVISION');
    const r=rows[0];
    return {id:String(r.id),parent:r.parent===null?null:String(r.parent),
      treeId:String(r.tree_id),actor:String(r.actor),createdAt:String(r.created_at)};
  }
  async get(id:string):Promise<SyncCommit>{
    const entry=this.row(id);
    const commit=await this.objects.readRevision(entry.id,entry.treeId);
    if((commit.parents[0]??null)!==entry.parent || commit.actor!==entry.actor ||
       commit.createdAt!==entry.createdAt)throw new SafeSyncError('REVISION_METADATA_MISMATCH');
    return commit;
  }
  async head():Promise<SyncCommit|null>{
    const id=this.current();
    return id?await this.get(id):null;
  }
  async fileAt(commitId:string,path:string):Promise<string|null>{
    const row=this.row(commitId);
    return this.objects.readFile(row.id,row.treeId,path);
  }
  async history(limit=20):Promise<Array<HeadRow>>{
    if(!Number.isInteger(limit)||limit<1||limit>50)throw new SafeSyncError('INVALID_LIMIT');
    let cursor=this.current();
    const out:HeadRow[]=[];
    const seen=new Set<string>();
    while(cursor&&out.length<limit){
      if(seen.has(cursor))throw new SafeSyncError('HISTORY_CYCLE');
      seen.add(cursor);
      const row=this.row(cursor);
      out.push(row);
      cursor=row.parent;
    }
    return out;
  }
  private async remoteGroupsSince(baseId:string,headId:string):Promise<SemanticGroup[]>{
    const groups:SemanticGroup[]=[];
    let cursor:string|null=headId;
    const seen=new Set<string>();
    while(cursor!==baseId){
      if(!cursor||seen.has(cursor))throw new SafeSyncError('UNRELATED_HISTORY');
      seen.add(cursor);
      const commit=await this.get(cursor);
      groups.push(...commit.groups);
      cursor=commit.parents[0]??null;
    }
    return groups;
  }
  private install(expected:string|null,commit:SyncCommit,staged:StagedCommit):boolean{
    if(staged.commitId!==commit.id)throw new SafeSyncError('STAGE_MISMATCH');
    // An additional transaction is the authoritative linearization point.
    // Staged R2 objects may be orphaned, but readers only follow this pointer.
    return this.storage.transactionSync(()=>{
      if(this.current()!==expected)return false;
      this.storage.sql.exec(
        'INSERT INTO sync_commits(id,parent,tree_id,actor,created_at) VALUES(?,?,?,?,?)',
        commit.id,commit.parents[0]??null,staged.treeId,commit.actor,commit.createdAt);
      if(expected===null){
        this.storage.sql.exec('INSERT INTO sync_refs(name,head) VALUES(?,?)',HEAD_NAME,commit.id);
        // SQL cursor rowsWritten differs across SQLite runtimes. Verify actual
        // state inside the SAME transaction instead of trusting that counter.
        if(this.current()!==commit.id)throw new SafeSyncError('HEAD_CAS_FAILED');
      }else{
        this.storage.sql.exec('UPDATE sync_refs SET head=? WHERE name=? AND head=?',commit.id,HEAD_NAME,expected);
        if(this.current()!==commit.id)throw new SafeSyncError('HEAD_CAS_FAILED');
      }
      return true;
    });
  }
  async bootstrap(files:FileSnapshot):Promise<{status:'initialized'|'already_initialized';headId:string}>{
    const present=this.current();
    if(present){
      // Idempotent only for the exact same genesis snapshot, never accept a
      // different unreviewed baseline silently.
      const genesis=await makeGenesis(files);
      const ancestry=await this.history(50);
      if(ancestry.length===1&&present===genesis.id)return {status:'already_initialized',headId:present};
      throw new SafeSyncError('ALREADY_INITIALIZED');
    }
    const commit=await makeGenesis(files);
    await verifyCommit(commit,null);
    const staged=await this.objects.putRevision(commit);
    if(!this.install(null,commit,staged))throw new SafeSyncError('GENESIS_RACE');
    return {status:'initialized',headId:commit.id};
  }
  async push(input:{
    baseId:string;expectedHead:string;localFiles:FileSnapshot;
    groups:SemanticGroup[];actor:Actor;message:string;
  }):Promise<PushResponse>{
    // Clients can stage offline commits but must lease an actual remote HEAD.
    if(!ID.test(input.expectedHead)||!ID.test(input.baseId))throw new SafeSyncError('INVALID_COMMIT_ID');
    const expected=this.current();
    if(!expected)throw new SafeSyncError('NOT_INITIALIZED');
    if(input.expectedHead!==expected)return {status:'remote_advanced',headId:expected};
    const base=await this.get(input.baseId);
    const current=await this.get(expected);
    const localChanges=diffSnapshots(base.files,input.localFiles);
    const remoteGroups=await this.remoteGroupsSince(input.baseId,expected);
    if(!localChanges.length){
      return {status:'already_current',headId:expected,
        preview:threeWayMerge(base.files,base.files,current.files,[],remoteGroups)};
    }
    const localGroups=validateGroups(input.groups,localChanges.map(x=>x.path));
    const preview=threeWayMerge(base.files,input.localFiles,current.files,localGroups,remoteGroups);
    if(preview.disposition==='blocked')return {status:'conflict',headId:expected,preview};
    if(!preview.merged)throw new SafeSyncError('MERGE_RESULT_MISSING');
    const changes=diffSnapshots(current.files,preview.merged);
    if(!changes.length)return {status:'already_current',headId:expected,preview};
    if(changes.length>5)throw new SafeSyncError('TOO_MANY_FILES');
    const groups=localGroups.filter(g=>g.paths.some(p=>changes.some(c=>c.path===p)));
    // Always create a new single-parent commit against the current remote
    // head; do not update old objects nor replay local edits blindly.
    const commit=await makeCommit({parent:current,files:preview.merged,
      groups,actor:input.actor,message:input.message});
    await verifyCommit(commit,current);
    const staged=await this.objects.putRevision(commit);
    if(!this.install(expected,commit,staged))
      return {status:'remote_advanced',headId:this.current()!};
    return {status:'published',headId:commit.id,preview};
  }
}