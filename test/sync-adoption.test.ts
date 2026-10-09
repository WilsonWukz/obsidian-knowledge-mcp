import {env} from 'cloudflare:test';
import {describe,it,expect} from 'vitest';
import {R2Client} from '../src/vault/r2-client';
import {buildVaultConfig} from '../src/config';
import {makeGenesis} from '../src/sync/protocol';
import {adoptLegacyVault} from '../src/sync/adoption';
import {guardedHead} from '../src/sync/rpc';
import {makeReadableVault} from '../src/sync/read-vault';
function isolatedEnv():Env{
 const prefix='synthetic-adoption-'+crypto.randomUUID();
 const ownerId=env.SYNC_LEDGER.idFromName('adoption-'+crypto.randomUUID());
 const binding={idFromName:()=>ownerId,get:(id:DurableObjectId)=>env.SYNC_LEDGER.get(id)};
 return {...env,VAULT_PREFIX:prefix,SYNC_LEDGER:binding,ENABLE_GUARDED_SYNC:'true',
  ENABLE_SYNC_ADOPTION:'true',GUARDED_SYNC_CUTOVER:'false'} as unknown as Env;
}
const M='INSES/M00-关系总览.md',P='INSES/P21-Evidence.md';
describe('owner-approved genesis adoption and read overlay',()=>{
 it('denies incorrect local genesis and preserves legacy R2',async()=>{
  const e=isolatedEnv(),v=new R2Client(e.VAULT,buildVaultConfig(e));
  await v.put(M,'# original');
  await expect(adoptLegacyVault(e,'0'.repeat(64))).rejects.toMatchObject({code:'GENESIS_MISMATCH'});
  expect(await v.get(M)).toBe('# original');
 });
 it('adopts a frozen matching legacy snapshot; stale old writers never change managed HEAD',async()=>{
  const e=isolatedEnv(),v=new R2Client(e.VAULT,buildVaultConfig(e));
  const initial={[M]:'- [[P21#^R-P21-01]]：initial',[P]:'### R-P21-01\noriginal evidence'};
  for(const [p,body] of Object.entries(initial))await v.put(p,body);
  const genesis=await makeGenesis(initial);
  const adopted=await adoptLegacyVault(e,genesis.id);
  expect(adopted.status).toBe('initialized');
  expect(adopted.headId).toBe(genesis.id);
  expect((await guardedHead(e)).files).toEqual(initial);
  expect(await v.get(M)).toBe(initial[M]);
  expect(await adoptLegacyVault(e,genesis.id)).toMatchObject({status:'already_initialized'});
  await v.put(M,'# rogue legacy writer');
  const cutover={...e,GUARDED_SYNC_CUTOVER:'true'} as unknown as Env;
  const overlay=makeReadableVault(cutover,buildVaultConfig(cutover));
  expect(await overlay.get(M)).toBe(initial[M]);
  expect((await overlay.listMarkdown()).filter(p=>p.startsWith('INSES/')).sort()).toEqual([M,P].sort());
  await expect(adoptLegacyVault(e,genesis.id)).rejects.toMatchObject({code:'GENESIS_MISMATCH'});
 });
});
