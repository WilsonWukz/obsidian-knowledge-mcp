/** One-shot, owner-confirmed adoption of the existing R2 vault.
 * External S3 credentials must be disabled by operator; the Worker cannot revoke them.
 * Never accepts untrusted caller-supplied Markdown snapshots as genesis.
 */
import {R2Client} from '../vault/r2-client';
import {buildVaultConfig} from '../config';
import {makeGenesis,SafeSyncError,type FileSnapshot} from './protocol.ts';
import {syncRpc,syncEnabled,syncCutover} from './rpc.ts';
export async function adoptLegacyVault(env:Env,expectedGenesisId:string):Promise<{status:string;headId:string}>{
 if(!syncEnabled(env)||syncCutover(env)||String(env.ENABLE_SYNC_ADOPTION)!=='true')
  throw new SafeSyncError('ADOPTION_DISABLED');
 if(!/^[a-f0-9]{64}$/.test(expectedGenesisId))throw new SafeSyncError('INVALID_GENESIS_ID');
 const vault=new R2Client(env.VAULT,buildVaultConfig(env));
 const first=(await vault.listMarkdownWithMeta()).filter(x=>x.path.startsWith('INSES/')).sort((a,b)=>a.path.localeCompare(b.path));
 if(!first.length||first.length>2000)throw new SafeSyncError('INVALID_ADOPTION_SOURCE');
 const files:FileSnapshot={};
 for(const entry of first){
  const note=await vault.getWithEtag(entry.path);
  if(!note||note.etag!==entry.etag)throw new SafeSyncError('SOURCE_CHANGED');
  files[entry.path]=note.body;
 }
 const second=(await vault.listMarkdownWithMeta()).filter(x=>x.path.startsWith('INSES/')).sort((a,b)=>a.path.localeCompare(b.path));
 if(JSON.stringify(first)!==JSON.stringify(second))throw new SafeSyncError('SOURCE_CHANGED');
 const genesis=await makeGenesis(files);
 if(genesis.id!==expectedGenesisId)throw new SafeSyncError('GENESIS_MISMATCH');
 return syncRpc<{status:string;headId:string}>(env,'bootstrap',{files});
}
