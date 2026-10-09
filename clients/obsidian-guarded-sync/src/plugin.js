'use strict';
/* Obsidian Guarded Sync (desktop-only). No integration with Remotely Save or MCP.
 * Until the separate authenticated gateway ships, Fetch/Push fail closed.
 */
const {Plugin,ItemView,PluginSettingTab,Setting,Notice,Modal,requestUrl} = require('obsidian');
const fs = require('node:fs/promises');
const {realpathSync} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash} = require('node:crypto');
const {LocalEngine,SyncError,diff,validPath,checkSnapshot} = require('./core.js');
const execFileAsync=promisify(execFile);
const VIEW='guarded-sync-workbench';
const SERVICE='obsidian-guarded-sync';
const defaults={gatewayUrl:'',projectPrefix:'INSES/',autoSync:false};
const friendly={
  LOCAL_NOT_INITIALIZED:'先点击「Initialize local history」，只建立本地版本基线。',
  GATEWAY_NOT_CONFIGURED:'受控同步网关尚未配置，Fetch/Push 不可使用。',
  ADOPTION_DISABLED:'云端尚未显式启用一次性迁移许可。',
  GENESIS_MISMATCH:'云端与 Mac 的初始文件不完全一致。请先核对，不要强制覆盖。',
  SOURCE_CHANGED:'迁移中云端文件发生变化，已中止；先停用旧同步写入者。',
  KEYCHAIN_TOKEN_MISSING:'系统钥匙串中找不到授权凭证；密钥不会保存在 Vault。',
  REMOTE_NOT_INITIALIZED:'远端受控版本库尚未经过审核初始化，不能直接从旧 R2 内容推送。',
  UNRELATED_HISTORY:'本地与云端没有经过验证的共同祖先。禁止覆盖；请先完成迁移对账。',
  WORKTREE_DIRTY:'本地文件与已提交快照不同。先检查 Status、Stage 和 Commit；禁止隐式覆盖。',
  STAGED_CHANGES_EXIST:'仍有暂存修改，先完成 Commit 或 Unstage。',
  SEMANTIC_SCOPE_REQUIRED:'修改涉及关系证据，但无法自动确定关系范围。请填写关系 ID（如 R-P21-01）。',
  SEMANTIC_SCOPE_TOO_WIDE:'该修改涉及过多关系，请拆成较小的提交并人工核对。',
  RELATION_ID_NOT_IN_CHANGED_NOTE:'指定关系 ID 未出现在这次修改的关联笔记中。',
  MERGE_CONFLICT:'本地与云端存在内容或语义冲突；必须人工比较三方版本。',
  LOCAL_COMMITS_REQUIRE_MERGE:'本地有尚未发布的提交；先 Fetch、查看冲突并合并。',
  REMOTE_ADVANCED_FETCH_FIRST:'云端版本已变化，Push 被阻止。先 Fetch，再重新审阅。',
  MERGE_REQUIRED:'本地与远端已经分叉；必须先审阅并完成 Merge。',
  PUSH_REVIEW_REQUIRED:'必须先点 Preview Push，并独立审阅每项差异。',
  DELETE_NEEDS_MANUAL_REVIEW:'存在删除文件操作。此版本禁止自动删除，请人工处理。',
  RECOVERY_REQUIRED:'同步过程中断，必须处理恢复日志后才能执行其他操作。',
  JOURNAL_EXTERNAL_CHANGE:'失败后有第三方再次修改该文件；不能自动回滚，请人工核对备份。',
};
function el(tag,parent,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);parent?.appendChild(n);return n;}
function button(parent,label,cb,kind=''){const b=el('button',parent,'gs-button '+kind,label);b.type='button';b.addEventListener('click',cb);return b;}
function validateEndpoint(input){
  if(!input)return null;
  try{const u=new URL(input);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/sync/v1')throw Error();return u.href;}
  catch{throw new SyncError('INVALID_GATEWAY_URL','需要 HTTPS 且路径为 /sync/v1（不包含用户名、参数或片段）');}
}
function vaultIdentity(app){
  if(typeof app.vault.adapter.getBasePath!=='function')throw new SyncError('DESKTOP_VAULT_REQUIRED');
  const base=realpathSync(app.vault.adapter.getBasePath());
  const hashed=createHash('sha256').update(base).digest('hex');
  return {base,id:hashed};
}
class DiskStore {
  constructor(vaultId){
    this.dir=path.join(os.homedir(),'.obsidian-guarded-sync','vaults',vaultId);
    this.file=path.join(this.dir,'state.json');
  }
  async read(){
    try{return JSON.parse(await fs.readFile(this.file,'utf8'));}
    catch(e){if(e.code==='ENOENT')return null;throw new SyncError('LOCAL_STATE_CORRUPT','保留文件 '+this.file+'，请不要重新初始化覆盖');}
  }
  async write(value){
    await fs.mkdir(this.dir,{recursive:true,mode:0o700});
    const temp=path.join(this.dir,`state.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    let saved=false;
    try{
      // State contains private paper content but never credentials. It is
      // intentionally OUTSIDE the Obsidian Vault/Remotely Save folder.
      const handle=await fs.open(temp,'wx',0o600);
      try{await handle.writeFile(JSON.stringify(value),'utf8');await handle.sync();}finally{await handle.close();}
      await fs.rename(temp,this.file);saved=true;
      // Best effort directory sync after rename, supported by macOS/APFS.
      try{const dir=await fs.open(this.dir,'r');try{await dir.sync();}finally{await dir.close();}}catch{}
    }finally{if(!saved)await fs.rm(temp,{force:true}).catch(()=>{});}
  }
}
class ObsidianVaultAdapter {
  constructor(app,base){this.app=app;this.base=base;}
  async snapshot(){
    const out={},list=this.app.vault.getMarkdownFiles().filter(f=>f.path.startsWith('INSES/'));
    if(list.length>2000)throw new SyncError('SNAPSHOT_TOO_LARGE');
    for(const f of list){validPath(f.path);
      // Reject symlinks that escape the Vault; getMarkdownFiles itself may
      // include adapter-provided paths not backed by an ordinary file.
      const expected=path.join(this.base,...f.path.split('/'));
      let actual;
      try{actual=await fs.realpath(expected);}catch{throw new SyncError('VAULT_FILE_UNAVAILABLE',f.path);}
      if(!actual.startsWith(this.base+path.sep))throw new SyncError('SYMLINK_OUTSIDE_VAULT',f.path);
      out[f.path]=await this.app.vault.read(f);
    }
    checkSnapshot(out);return out;
  }
  async write(notePath,body,expected){
    validPath(notePath);
    if(body===null)throw new SyncError('DELETE_NEEDS_MANUAL_REVIEW');
    const existing=this.app.vault.getAbstractFileByPath(notePath);
    if(existing&&existing.extension!=='md')throw new SyncError('FILE_TYPE_CONFLICT');
    const before=existing?await this.app.vault.read(existing):null;
    if(expected!==undefined&&before!==expected)throw new SyncError('WORKTREE_CHANGED_DURING_APPLY');
    if(existing){await this.app.vault.modify(existing,body);return;}
    const parent=notePath.slice(0,notePath.lastIndexOf('/'));
    if(!this.app.vault.getAbstractFileByPath(parent))throw new SyncError('PARENT_DIRECTORY_MISSING',parent);
    await this.app.vault.create(notePath,body);
  }
  async remove(notePath,expected){
    validPath(notePath);
    const file=this.app.vault.getAbstractFileByPath(notePath);
    if(!file)return;
    if(file.extension!=='md'||await this.app.vault.read(file)!==expected)
      throw new SyncError('WORKTREE_CHANGED_DURING_RECOVERY');
    // Only after the owner chose manual recovery. Trash, not hard delete.
    await this.app.fileManager.trashFile(file);
  }
}
class GatewayRemote {
  constructor(url,vaultId){this.url=validateEndpoint(url);this.vaultId=vaultId;}
  async token(){
    if(process.platform!=='darwin')throw new SyncError('MAC_ONLY');
    try{
      const r=await execFileAsync('security',['find-generic-password','-s',SERVICE,'-a',this.vaultId,'-w'],{timeout:7000,maxBuffer:4096,encoding:'utf8'});
      const token=r.stdout.trim();if(token.length<32)throw new SyncError('KEYCHAIN_TOKEN_INVALID');return token;
    }catch(e){if(e instanceof SyncError)throw e;throw new SyncError('KEYCHAIN_TOKEN_MISSING');}
  }
  async rpc(op,args={}){
    if(!this.url)throw new SyncError('GATEWAY_NOT_CONFIGURED');
    const key=await this.token();
    let response;
    try{
      response=await requestUrl({url:this.url,method:'POST',headers:{'Content-Type':'application/json',
        'Authorization':'Bearer '+key,'Cache-Control':'no-store'},body:JSON.stringify({op,...args}),throw:false});
    }catch{throw new SyncError('GATEWAY_UNREACHABLE');}
    const obj=response.json;
    if(!obj||typeof obj!=='object')throw new SyncError('REMOTE_INVALID_RESPONSE');
    if(response.status!==200)throw new SyncError(typeof obj.error==='string'?obj.error:'GATEWAY_REJECTED');
    return obj;
  }
  status(){return this.rpc('status');}
  async get(id){const r=await this.rpc('get',{id});return r.commit;}
  push(input){return this.rpc('push',{input});}
  adopt(expectedGenesisId){return this.rpc('adopt_legacy_vault',{expectedGenesisId,ack:'I_HAVE_DISABLED_LEGACY_WRITERS'});}
}
class ConfirmModal extends Modal {
  constructor(app,{title,body,buttonText='确认执行',onConfirm}){super(app);this.title=title;this.body=body;this.buttonText=buttonText;this.onConfirm=onConfirm;}
  onOpen(){
    const {contentEl}=this;contentEl.empty();contentEl.addClass('gs-modal');
    el('h3',contentEl,'',this.title);
    const pre=el('pre',contentEl,'gs-review-text',this.body);
    pre.setAttribute('aria-label','完整变更审阅内容');
    const actions=el('div',contentEl,'gs-modal-actions');
    button(actions,'取消',()=>this.close());
    button(actions,this.buttonText,()=>{this.close();void this.onConfirm();},'mod-warning');
  }
}
class GuardedSyncView extends ItemView {
  constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.checked=new Set();this.busy=false;}
  getViewType(){return VIEW;}
  getDisplayText(){return 'Guarded Sync · 受保护版本管理';}
  getIcon(){return 'git-branch';}
  async onOpen(){await this.render();}
  async render(){
    const container=this.containerEl.children[1]||this.containerEl;container.empty();
    const root=el('div',container,'gs-root');this.root=root;
    const top=el('div',root,'gs-header');el('h3',top,'','Guarded Sync');
    el('span',top,'gs-badge','Local-first · No autosync');
    el('p',root,'gs-info','本地 Stage / Commit 不上传。Fetch 只读取版本信息；Pull / Merge 必须确认后才写入。');
    const main=el('div',root,'gs-toolbar');
    button(main,'Refresh Status',()=>this.action(()=>this.render()));
    button(main,'Initialize local history',()=>this.action(async()=>{
      const folder=this.plugin.identity.base;
      await this.review({title:'建立本地初始快照',body:`只对 ${folder}/INSES/ 建立本地版本历史。不会改动笔记，也不会上传。\n存储路径：${this.plugin.store.dir}`,confirm:'初始化',run:()=>this.plugin.engine.initialize()});
    }));
    button(main,'Fetch',()=>this.action(async()=>{const value=await this.plugin.engine.fetch();new Notice('Fetch：'+value.disposition+'；本地文件未改动。');}));
    button(main,'Adopt legacy baseline (one-time)',()=>this.action(async()=>{
      const state=this.plugin.engine.state;
      if(!state)throw new SyncError('LOCAL_NOT_INITIALIZED');
      const genesis=Object.values(state.commits).find(c=>c.parents.length===0);
      if(!genesis||genesis.id!==state.headId)throw new SyncError('LOCAL_COMMITS_REQUIRE_MERGE');
      const status=await this.plugin.engine.status();
      if(status.staged.length||status.unstaged.length)throw new SyncError('WORKTREE_DIRTY');
      if(!this.plugin.engine.remote)throw new SyncError('GATEWAY_NOT_CONFIGURED');
      await this.review({title:'一次性核验旧云端基线',
        body:'警告：必须先备份 Vault，停用 Remotely Save 对 INSES/ 的写入并撤销相关旧 R2/S3 写入凭据。\\n'
          +'此操作只会在云端建立不可变初始快照，不会改动 Mac 文件。只有云端 INSES/ 与本地初始快照的 SHA-256 完全一致才会成功。\\n'
          +'本地初始版本：'+genesis.id,
        confirm:'我已停止旧写入者，开始比对',
        run:async()=>{await this.plugin.engine.remote.adopt(genesis.id);await this.plugin.engine.fetch();}
      });
    }));
    let state=this.plugin.engine.state;
    if(!state){el('div',root,'gs-note','尚未初始化本地历史。请先在测试 Vault 中创建第一份只读基线。');return;}
    if(state.journal){
      const warning=el('div',root,'gs-warning');el('strong',warning,'','检测到未完成的本地应用日志');
      el('p',warning,'',`目标提交 ${state.journal.targetId.slice(0,12)} · ${state.journal.mode}`);
      button(warning,'核对后完成应用',()=>this.action(async()=>this.review({title:'确认完成恢复',body:'系统将逐项读取当前文件，仅当全部与目标版本精确一致时更新 HEAD。不满足时拒绝。',confirm:'核对并完成',run:()=>this.plugin.engine.finalizeJournal()})));
      button(warning,'核对后回滚',()=>this.action(async()=>this.review({title:'回滚未完成的拉取',body:'仅当文件仍是应用前或应用后原样时，恢复本地原文。若期间有第三方修改，则直接阻拦。',confirm:'回滚',run:()=>this.plugin.engine.rollbackJournal()})));
      return;
    }
    const head=el('div',root,'gs-status-bar');
    el('span',head,'',`Local: ${state.headId.slice(0,12)}`);
    el('span',head,'',`Remote: ${state.remoteHeadId?.slice(0,12)||'not fetched'}`);
    const row=el('div',root,'gs-worktrees');
    const branch=el('div',row,'gs-files');
    el('h4',branch,'','Working tree');
    let snapshot;
    try{snapshot=await this.plugin.engine.status();}
    catch(e){el('p',branch,'gs-warning',this.plugin.explain(e));return;}
    const stagedPaths=new Set(snapshot.staged.map(x=>x.path));
    const files=[...new Set([...snapshot.staged.map(x=>x.path),...snapshot.unstaged.map(x=>x.path)])].sort();
    if(!files.length)el('p',branch,'gs-muted','工作区干净。');
    for(const file of files){
      const entry=el('label',branch,'gs-file');const box=el('input',entry);box.type='checkbox';box.checked=this.checked.has(file);
      box.addEventListener('change',()=>{if(box.checked)this.checked.add(file);else this.checked.delete(file);});
      const desc=stagedPaths.has(file)?'STAGED':'MODIFIED';
      el('span',entry,'gs-path',file);el('small',entry,'',desc);
    }
    const controls=el('div',branch,'gs-controls');
    button(controls,'Stage selected',()=>this.action(()=>this.plugin.engine.stage([...this.checked])));
    button(controls,'Unstage selected',()=>this.action(()=>this.plugin.engine.unstage([...this.checked])));
    this.message=el('input',branch,'gs-input');this.message.placeholder='Commit message (why the evidence changed)';
    this.relationIds=el('input',branch,'gs-input');this.relationIds.placeholder='Related evidence IDs if needed: R-P21-01, R-P22-01';
    button(branch,'Commit staged changes',()=>this.action(async()=>{
      const message=this.message.value,ids=this.relationIds.value.split(',').map(x=>x.trim()).filter(Boolean);
      const staged=this.plugin.engine.state.staged;
      await this.review({title:'本地 Commit（不会上传）',body:Object.entries(staged).map(([p,c])=>`${p}  → ${c===null?'DELETE':c.length+' characters'}`).join('\n')+`\n\n${message}`,confirm:'保存本地 Commit',run:()=>this.plugin.engine.commit(message,ids)});
    }));
    const remote=el('div',row,'gs-remote');
    el('h4',remote,'','Remote tracking');
    const ractions=el('div',remote,'gs-controls');
    button(ractions,'Review Pull',()=>this.action(async()=>{
      const v=this.plugin.engine.preview();
      if(v.localId!==v.baseId)throw new SyncError('LOCAL_COMMITS_REQUIRE_MERGE');
      await this.review({title:'审阅 Pull 差异',body:formatPreview(v),confirm:'Apply Pull to Vault',run:()=>this.plugin.engine.pull()});
    }));
    button(ractions,'Review Merge',()=>this.action(async()=>{
      const v=this.plugin.engine.preview();if(v.disposition==='blocked')return this.displayConflicts(v);
      if(v.disposition!=='merge_ready')throw new SyncError('NO_MERGE_NEEDED');
      await this.review({title:'审阅三方合并',body:formatPreview(v),confirm:'Apply Merge to Vault',run:()=>this.plugin.engine.merge([])});
    }));
    button(ractions,'Preview Push',()=>this.action(async()=>{
      const proposed=await this.plugin.engine.preparePush();
      if(proposed.status==='already_current'){new Notice('远端已是当前版本。');return;}
      await this.review({title:'确认 Push',body:formatPreview(proposed.view)+`\n\n提交变化：\n`+
        proposed.changes.map(c=>`${c.path}: ${c.before?.length??0} → ${c.after?.length??0} characters`).join('\n')+
        '\n\n确认后仍会二次检查远端 HEAD，若已变化则拒绝发布。',
        confirm:'Publish reviewed commit',run:()=>this.plugin.engine.push(proposed.key)});
    }));
    const previewBox=el('div',remote,'gs-preview');
    try{
      const preview=this.plugin.engine.preview();
      el('p',previewBox,'',`Branch status: ${preview.disposition}`);
      el('p',previewBox,'gs-muted',`${preview.localChanged.length} local / ${preview.remoteChanged.length} remote changes`);
      if(preview.conflicts.length){
        el('strong',previewBox,'gs-danger',`${preview.conflicts.length} conflict(s) · no automatic publish`);
        button(previewBox,'Inspect base / local / remote',()=>this.displayConflicts(preview));
      }
    }catch(e){el('p',previewBox,'gs-muted',this.plugin.explain(e));}
    el('p',remote,'gs-muted','Fetch/Push 需要未来启用的受认证网关；目前线上部署保持关闭。');
  }
  async displayConflicts(preview){const text=preview.conflicts.map(c=>`${c.reason} [${c.groupId||''}]\n`+
    c.paths.map(p=>`${p}\nBASE:\n${c.base[p]??'(absent)'}\nLOCAL:\n${c.local[p]??'(absent)'}\nREMOTE:\n${c.remote[p]??'(absent)'}`).join('\n')).join('\n\n----\n\n');
    const modal=new ConfirmModal(this.app,{title:'三方冲突详情（只读）',body:text||'No conflicts.',buttonText:'关闭',onConfirm:()=>{}});modal.open();
  }
  async review({title,body,confirm,run}){new ConfirmModal(this.app,{title,body,buttonText:confirm,onConfirm:()=>this.action(run)}).open();}
  async action(fn){if(this.busy)return;this.busy=true;try{await fn();}
    catch(e){new Notice('Guarded Sync：'+this.plugin.explain(e),10000);console.warn('[Guarded Sync]',e?.code||'action_failed');}
    finally{this.busy=false;await this.render();}}
}
function formatPreview(v){return `${v.disposition}\nBASE: ${v.baseId}\nLOCAL: ${v.localId}\nREMOTE: ${v.remoteId}\n\nLOCAL CHANGED:\n${v.localChanged.join('\n')}\n\nREMOTE CHANGED:\n${v.remoteChanged.join('\n')}\n\nCONFLICTS:\n${v.conflicts.map(c=>c.reason+': '+c.paths.join(', ')).join('\n')||'(none)'}`;}
class GuardedSyncSettings extends PluginSettingTab {
  constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
  display(){const c=this.containerEl;c.empty();c.createEl('h2',{text:'Guarded Sync · local-first safety'});
    c.createEl('p',{text:'No Cloud/MCP bypass. Secrets are never kept in plugin settings. Phase C is development-only until the authenticated gateway is enabled.'});
    new Setting(c).setName('Protected project folder').setDesc('Fixed to INSES/ in v0.3; other folders are not supported.').addText(x=>x.setValue('INSES/').setDisabled(true));
    new Setting(c).setName('Guarded gateway URL').setDesc('Only a future HTTPS owner-authenticated /sync/v1 route; never an R2 bucket endpoint.')
      .addText(x=>x.setPlaceholder('https://your-worker.workers.dev/sync/v1').setValue(this.plugin.settings.gatewayUrl||'')
      .onChange(async value=>{if(value)validateEndpoint(value);this.plugin.settings.gatewayUrl=value.trim();await this.plugin.saveData(this.plugin.settings);this.plugin.rebuildRemote();}));
    c.createEl('p',{text:'Vault identity (macOS Keychain account): '+this.plugin.identity.id});
    c.createEl('p',{text:'Private commit data path (outside Vault): '+this.plugin.store.dir});
    c.createEl('p',{text:'The separate keychain service name is obsidian-guarded-sync. Never paste a token into Markdown or a synchronized plugin config.'});
  }
}
class GuardedSyncPlugin extends Plugin {
  async onload(){this.settings=Object.assign({},defaults,await this.loadData());this.identity=vaultIdentity(this.app);
    this.store=new DiskStore(this.identity.id);
    this.adapter=new ObsidianVaultAdapter(this.app,this.identity.base);
    this.engine=new LocalEngine({vault:this.adapter,store:this.store,vaultId:this.identity.id});
    await this.engine.load();this.rebuildRemote();
    this.registerView(VIEW,leaf=>new GuardedSyncView(leaf,this));
    this.addRibbonIcon('git-branch','Open Guarded Sync',()=>this.openView());
    this.addCommand({id:'open-guarded-sync',name:'Open Guarded Sync local commits and review',callback:()=>this.openView()});
    this.addSettingTab(new GuardedSyncSettings(this.app,this));
    if(this.engine.state?.journal)new Notice('Guarded Sync：检测到未完成 Pull/Merge，请打开工作台恢复。',15000);
  }
  onunload(){this.app.workspace.detachLeavesOfType(VIEW);}
  rebuildRemote(){this.engine.remote=this.settings.gatewayUrl?new GatewayRemote(this.settings.gatewayUrl,this.identity.id):null;}
  explain(error){return friendly[error?.code]||error?.code||'操作中止，未确认成功。';}
  async openView(){let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];if(!leaf){leaf=this.app.workspace.getLeaf('tab');await leaf.setViewState({type:VIEW,active:true});}this.app.workspace.revealLeaf(leaf);}
}
module.exports=GuardedSyncPlugin;
module.exports.default=GuardedSyncPlugin;
module.exports._test={DiskStore,ObsidianVaultAdapter,GatewayRemote,validateEndpoint,vaultIdentity};
