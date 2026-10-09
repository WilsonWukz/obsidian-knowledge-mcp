'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const originalLoad=Module._load;
Module._load=function(req,...args){if(req==='obsidian'){class Base{};return {Plugin:Base,ItemView:Base,PluginSettingTab:Base,Setting:Base,Notice:Base,Modal:Base,requestUrl:async()=>({status:404,json:{error:'NOT_DEPLOYED'}})};}return originalLoad.call(this,req,...args);};
const plugin=require('../src/plugin.js');const {DiskStore,ObsidianVaultAdapter,GatewayRemote,validateEndpoint,vaultIdentity,readOwnerKeychainToken}=plugin._test;
Module._load=originalLoad;
const {genesis,SyncError}=require('../src/core.js');
async function temp(){return fsp.mkdtemp(path.join(os.tmpdir(),'guarded-sync-tests-'));}

test('plugin exports a valid desktop Obsidian entrypoint',()=>{
 assert.equal(typeof plugin,'function');assert.equal(plugin.default,plugin);
});
test('gateway URL is HTTPS-only and forbids credentials, query parameters and bucket endpoints',()=>{
 assert.equal(validateEndpoint('https://vault.example.test/sync/v1'),'https://vault.example.test/sync/v1');
 for(const bad of ['http://vault.example.test/sync/v1','https://evil.example.test/upload',
   'https://user:password@vault.example.test/sync/v1','https://vault.example.test/sync/v1?token=abc',
   'https://vault.example.test/sync/v1#anchor','file:///etc/passwd']){
   assert.throws(()=>validateEndpoint(bad),e=>e.code==='INVALID_GATEWAY_URL');
 }
});
test('initializing an unconfigured remote cannot invoke network or write vault',async()=>{
 const remote=new GatewayRemote('', 'test-identity');
 await assert.rejects(()=>remote.status(),{code:'GATEWAY_NOT_CONFIGURED'});
});
test('vault identity derives from actual on-disk Vault path, not a user-controlled URL',async()=>{
 const dir=await temp();try{
 const mock={vault:{adapter:{getBasePath:()=>dir}}};
 const id=vaultIdentity(mock);assert.equal(id.base,fs.realpathSync(dir));assert.match(id.id,/^[a-f0-9]{64}$/);
 }finally{await fsp.rm(dir,{recursive:true,force:true});}
});
test('local version store writes atomically and survives restart',async()=>{
 const dir=await temp();try{
 const store=new DiskStore('unit-test');store.dir=dir;store.file=path.join(dir,'state.json');
 const sample={schema:1,headId:'abc',files:{'INSES/Test.md':'private content, never upload'},journal:null};
 await store.write(sample);const read=await store.read();assert.deepEqual(read,sample);
 const mode=(await fsp.stat(store.file)).mode&0o777;assert.equal(mode,0o600);
 assert.deepEqual((await fsp.readdir(dir)).filter(x=>x.endsWith('.tmp')),[]);
 }finally{await fsp.rm(dir,{recursive:true,force:true});}
});
test('corrupt local state is NOT silently reset or replaced',async()=>{
 const dir=await temp();try{const store=new DiskStore('broken');store.dir=dir;store.file=path.join(dir,'state.json');
 await fsp.writeFile(store.file,'{invalid-journal');
 await assert.rejects(()=>store.read(),{code:'LOCAL_STATE_CORRUPT'});
 assert.equal(await fsp.readFile(store.file,'utf8'),'{invalid-journal');
 }finally{await fsp.rm(dir,{recursive:true,force:true});}
});
test('Obsidian adapter reads scoped Markdown and prevents modifications outside INSES',async()=>{
 const dir=await temp();try{await fsp.mkdir(path.join(dir,'INSES'),{recursive:true});
 await fsp.writeFile(path.join(dir,'INSES','A.md'),'# baseline');
 const file={path:'INSES/A.md',extension:'md'};
 const adapter={
   getMarkdownFiles:()=>[file,{path:'Other/unmanaged.md',extension:'md'}],
   getAbstractFileByPath:p=>p===file.path?file:p==='INSES'?{path:'INSES',extension:''}:null,
   read:async()=>fsp.readFile(path.join(dir,file.path),'utf8'),
   modify:async(_f,body)=>fsp.writeFile(path.join(dir,file.path),body),
 };
 const wrapped=new ObsidianVaultAdapter({vault:adapter},dir);
 assert.deepEqual(await wrapped.snapshot(),{'INSES/A.md':'# baseline'});
 await assert.rejects(()=>wrapped.write('Other/private.md','overwritten'),{code:'INVALID_PATH'});
 await assert.rejects(()=>wrapped.write('INSES/A.md','overwrite wrong','# stale'),{code:'WORKTREE_CHANGED_DURING_APPLY'});
 assert.equal(await fsp.readFile(path.join(dir,'INSES','A.md'),'utf8'),'# baseline');
 await wrapped.write('INSES/A.md','# changed','# baseline');
 assert.equal(await fsp.readFile(path.join(dir,'INSES','A.md'),'utf8'),'# changed');
 }finally{await fsp.rm(dir,{recursive:true,force:true});}
});
test('Vault adapter rejects symlinks leading outside the Vault',async()=>{
 const root=await temp(),outsider=await temp();try{
 await fsp.mkdir(path.join(root,'INSES'));
 await fsp.writeFile(path.join(outsider,'stolen.md'),'secret');
 await fsp.symlink(path.join(outsider,'stolen.md'),path.join(root,'INSES','A.md'));
 const files=[{path:'INSES/A.md',extension:'md'}];
 const app={vault:{getMarkdownFiles:()=>files,read:async()=>fsp.readFile(path.join(root,'INSES','A.md'),'utf8')}};
 await assert.rejects(()=>new ObsidianVaultAdapter(app,root).snapshot(),{code:'SYMLINK_OUTSIDE_VAULT'});
 }finally{await fsp.rm(root,{recursive:true,force:true});await fsp.rm(outsider,{recursive:true,force:true});}
});
test('bundled plugin has pure protocol and no require local dependency',async()=>{
 const main=await fsp.readFile(path.join(__dirname,'..','main.js'),'utf8');
 assert.match(main,/class LocalEngine/);assert.match(main,/module\.exports\.default=GuardedSyncPlugin/);
 assert.doesNotMatch(main,/require\('\.\/core\.js'\)/);
});

test('Keychain lookup uses /usr/bin/security and preserves actual service/account',async()=>{
 let captured;
 const fake=async (command,args,options)=>{captured={command,args,options};return {stdout:'K'.repeat(64)+'\\n',stderr:''};};
 const token=await readOwnerKeychainToken('vault-test-identity',fake,'darwin');
 assert.equal(token,'K'.repeat(64));
 assert.equal(captured.command,'/usr/bin/security');
 assert.deepEqual(captured.args,['find-generic-password','-s','obsidian-guarded-sync','-a','vault-test-identity','-w']);
 assert.ok(captured.options.timeout>=20000);
 assert.equal(captured.options.encoding,'utf8');
});

test('Keychain lookup rejects unsupported platforms without starting a subprocess',async()=>{
 let attempted=false;
 await assert.rejects(()=>readOwnerKeychainToken('vault',async()=>{attempted=true;return {stdout:'K'.repeat(64)};},'linux'),{code:'MAC_ONLY'});
 assert.equal(attempted,false);
});

test('Keychain lookup distinguishes nonexistent security executable from missing keychain item',async()=>{
 const err=Object.assign(new Error('spawn ENOENT'),{code:'ENOENT'});
 await assert.rejects(()=>readOwnerKeychainToken('vault',async()=>{throw err;},'darwin'),{code:'KEYCHAIN_COMMAND_UNAVAILABLE'});
});

test('Keychain lookup distinguishes denied keychain access',async()=>{
 const err=Object.assign(new Error('denied'),{code:1,stderr:'User interaction is not allowed.'});
 await assert.rejects(()=>readOwnerKeychainToken('vault',async()=>{throw err;},'darwin'),{code:'KEYCHAIN_ACCESS_DENIED'});
});

test('Keychain lookup recognizes explicit item-not-found diagnosis',async()=>{
 const err=Object.assign(new Error('not found'),{code:44,stderr:'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'});
 await assert.rejects(()=>readOwnerKeychainToken('vault',async()=>{throw err;},'darwin'),{code:'KEYCHAIN_TOKEN_MISSING'});
});

test('Keychain lookup maps canceled, timed-out approval prompts to an explicit timeout error',async()=>{
 const err=Object.assign(new Error('approval timed out'),{code:null,signal:'SIGTERM',killed:true});
 await assert.rejects(()=>readOwnerKeychainToken('vault',async()=>{throw err;},'darwin'),{code:'KEYCHAIN_ACCESS_TIMEOUT'});
});

test('Keychain lookup fails closed for empty, short or malformed subprocess output',async()=>{
 for(const stdout of ['', 'abc', '  ']){
  await assert.rejects(()=>readOwnerKeychainToken('vault',async()=>({stdout}), 'darwin'),{code:'KEYCHAIN_TOKEN_INVALID'});
 }
});

test('Keychain lookup never prints a secret through an unexpected error',async()=>{
 const secret='SYNTHETIC_TOKEN_VALUE_THAT_MUST_NOT_BE_LOGGED';
 const err=Object.assign(new Error('private:'+secret),{code:1,stderr:'private:'+secret});
 await assert.rejects(()=>readOwnerKeychainToken('vault',async()=>{throw err;},'darwin'),(failure)=>{
  assert.equal(failure.code,'KEYCHAIN_LOOKUP_FAILED');
  assert.ok(!failure.message.includes(secret));
  return true;
 });
});
