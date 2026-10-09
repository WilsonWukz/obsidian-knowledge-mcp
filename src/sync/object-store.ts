/**
 * Guarded Sync content-addressed object storage.
 *
 * All objects live in a DEDICATED, separately permissioned R2 bucket
 * (SYNC_OBJECTS), never in the existing Remotely Save VAULT bucket.
 * Staging an object does not publish a revision: only the SQLite HEAD CAS does.
 * Storage objects are never updated or deleted by this interface.
 */
import {
  SafeSyncError, hashCanonical, validateSnapshot, type SyncCommit,
  type FileSnapshot,
} from './protocol.ts';

export interface ImmutableBucket {
  put(key:string, value:string, options?:{
    onlyIf?:Headers;
    httpMetadata?:{contentType:string};
  }):Promise<{etag:string}|null>;
  get(key:string):Promise<{text():Promise<string>}|null>;
}
export interface TreeRecord { protocol:1; paths:Record<string,string> }
export interface StagedCommit { commitId:string; treeId:string; commitKey:string }
const FORMAT=1;
const HEADERS=()=>new Headers({'If-None-Match':'*'});
const ID=/^[a-f0-9]{64}$/;
const encoder=new TextEncoder();
const LIMIT=650_000;
export function blobKey(hash:string):string {
  if(!ID.test(hash))throw new SafeSyncError('INVALID_OBJECT_HASH');
  return `v1/blobs/${hash.slice(0,2)}/${hash}.txt`;
}
export function treeKey(hash:string):string {
  if(!ID.test(hash))throw new SafeSyncError('INVALID_OBJECT_HASH');
  return `v1/trees/${hash}.json`;
}
export function commitKey(hash:string):string {
  if(!ID.test(hash))throw new SafeSyncError('INVALID_OBJECT_HASH');
  return `v1/commits/${hash}.json`;
}

export class SyncObjectStore {
  private readonly bucket:ImmutableBucket;
  constructor(bucket:ImmutableBucket) {this.bucket=bucket;}
  private async stageExact(key:string,body:string,contentType:string):Promise<void>{
    if(encoder.encode(body).length>LIMIT)throw new SafeSyncError('OBJECT_TOO_LARGE');
    // R2 condition is evaluated at write time, not a racy HEAD precheck.
    const newObject=await this.bucket.put(key,body,{onlyIf:HEADERS(),httpMetadata:{contentType}});
    // A second submitter can stage the same content ID in parallel. In either
    // case read it back: an external bucket rewrite must never be accepted.
    if(!newObject){
      const prior=await this.bucket.get(key);
      if(!prior || await prior.text()!==body)throw new SafeSyncError('IMMUTABLE_OBJECT_CONFLICT',key);
    } else {
      const readback=await this.bucket.get(key);
      if(!readback || await readback.text()!==body)throw new SafeSyncError('OBJECT_READBACK_FAILED',key);
    }
  }
  private async readExact(key:string):Promise<string>{
    const obj=await this.bucket.get(key);
    if(!obj)throw new SafeSyncError('OBJECT_MISSING',key);
    const content=await obj.text();
    if(encoder.encode(content).length>LIMIT)throw new SafeSyncError('OBJECT_TOO_LARGE');
    return content;
  }
  async putRevision(commit:SyncCommit):Promise<StagedCommit>{
    validateSnapshot(commit.files);
    // Canonical verified by the SQLite gateway before staging. The individual
    // note bytes use content hashes; identical versions share immutable blobs.
    const paths:Record<string,string>={};
    for(const path of Object.keys(commit.files).sort()){
      const body=commit.files[path];
      const hash=await hashCanonical(body);
      await this.stageExact(blobKey(hash),body,'text/plain; charset=utf-8');
      paths[path]=hash;
    }
    const tree:TreeRecord={protocol:FORMAT,paths};
    const treeId=await hashCanonical(tree);
    await this.stageExact(treeKey(treeId),JSON.stringify(tree),'application/json');
    const key=commitKey(commit.id);
    await this.stageExact(key,JSON.stringify(commit),'application/json');
    return {commitId:commit.id,treeId,commitKey:key};
  }
  async readRevision(id:string,expectedTreeId?:string):Promise<SyncCommit>{
    const raw=await this.readExact(commitKey(id));
    let commit:SyncCommit;
    try {commit=JSON.parse(raw) as SyncCommit;}catch{throw new SafeSyncError('COMMIT_DECODE_FAILED');}
    if(!commit || commit.id!==id || !commit.files || !Array.isArray(commit.parents))
      throw new SafeSyncError('COMMIT_INTEGRITY_ERROR');
    // Every read validates content identity before trusting any persisted body.
    const {id:discard,...canonical}=commit;
    if(await hashCanonical(canonical)!==id)throw new SafeSyncError('COMMIT_INTEGRITY_ERROR');
    validateSnapshot(commit.files);
    if(expectedTreeId){
      const paths:Record<string,string>={};
      for(const path of Object.keys(commit.files).sort())paths[path]=await hashCanonical(commit.files[path]);
      const tree:TreeRecord={protocol:FORMAT,paths};
      if(await hashCanonical(tree)!==expectedTreeId)throw new SafeSyncError('TREE_MISMATCH');
      const stored=await this.readExact(treeKey(expectedTreeId));
      if(stored!==JSON.stringify(tree))throw new SafeSyncError('TREE_MISMATCH');
    }
    return commit;
  }
  async readFile(commitId:string,treeId:string,path:string):Promise<string|null>{
    const commit=await this.readRevision(commitId,treeId);
    if(!Object.hasOwn(commit.files,path))return null;
    const body=commit.files[path];
    const blob=await this.readExact(blobKey(await hashCanonical(body)));
    if(blob!==body)throw new SafeSyncError('BLOB_INTEGRITY_ERROR',path);
    return body;
  }
}