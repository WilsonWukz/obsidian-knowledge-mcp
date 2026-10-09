# Mac ↔ R2 ↔ Slack Jarvis：双向同步与冲突验收

**目标：** Jarvis 经审批写入 Cloudflare R2 后，Mac 的 Obsidian 能通过 Remotely Save **下载**并显示云端的新笔记和变更，而不只是把本地文件上传。

这份指南仅用于测试 Vault **Research-MCP-Test** 和测试 R2 bucket **wilson-obsidian-mcp-test**。在完成所有检查以前，不要迁移正式研究 Vault。先备份测试 Vault 的完整文件夹。

## 1. Mac 端设置为“双向”

Obsidian → 设置 → Remotely Save：

- S3: 保持现有 Cloudflare R2 Endpoint、Bucket、Path-style 和留空的 Remote Prefix。
- 密码（加密密码）：留空，云端 MCP 需要读取 Markdown 明文。
- **高级设置 → 同步方向 Sync Direction：Bidirectional（双向）**，不能选择 push-only 或 pull-only。
- **自动运行：** 首次测试保持关闭，全部验收通过以后可设为 **每 5 分钟**。
- **启动后自动运行一次：** 建议在测试通过后设为 **10 秒**。
- **保存时同步：** 首次测试保持关闭；只有明确理解并发冲突风险后再开启。
- **配置文件夹同步：** 保持关闭，绝对不要同步含有密钥的 .obsidian/plugins/remotely-save/data.json。
- **冲突策略：** 默认“保留较新版本”不等于合并内容。开启 smart conflict 前也必须先用测试笔记验证。

Remotely Save 的双向同步算法具有 remote_is_created_then_pull 和 remote_is_modified_then_pull 分支。Worker 在 R2 修改对象后，Mac 需要**主动同步**（手动、启动或定时）才能下载。云端更新不等于立刻推送到 Mac。

## 2. 四项验收

**A. Mac → R2（此前成功过）：** 在 Mac 创建 Graph.md / INSES-test.md，手动同步；R2 中看到正确名称，远程 MCP list_notes/read_note 能读取。请确认文件不会出现 .md.md。

**B. R2 → Mac 新建（必须真实测试）：** 让 Jarvis 在 INSES/ 下经 plan_note_changes → 独立网页批准 → apply_note_changes，创建 INSES/_sync-cloud-create-test.md。Mac 上先确认不存在该文件，然后执行 Remotely Save 手动双向同步。确认 Obsidian 左侧出现该笔记，文件正文一致。关闭并重开 Obsidian、再次同步，确保没有回退。

**C. R2 → Mac 更新（必须真实测试）：** Mac 新建并同步 INSES/_sync-cloud-update-test.md；Jarvis 准备版本条件下的正文/YAML 更新计划，主人网页核对后批准并写入；Mac 不编辑该笔记时，再执行一次双向同步。核对变更段落、YAML、WikiLink，其他内容不得丢失，第二次同步不得回退。

**D. 离线冲突（必须真实测试）：** 在 Mac 离线时编辑一篇已同步的测试笔记，暂不上传。Jarvis 云端编辑同一篇时，MCP 的 R2 ETag 校验**无法知道** Mac 未上传的修改；服务端绝不能谎称完全避免冲突。先将本地文件拷贝备份，再恢复联网并手动同步。若插件选择“较新版本覆盖”，必须保留可恢复的副本或暂停正式 Vault 的同名文件更新能力。不同版本必须人工核对，不得静默覆盖。

## 3. 正式使用时的规约

- Jarvis 尽量在独立的 INSES/ 子目录下创建新论文笔记。不要未经本人审批覆盖用户亲自维护的笔记，也不得写入 .obsidian 配置目录。
- 每批最多 5 篇，先预览，再由用户在单独网页登录并审核，执行完返回逐文件的 R2 ETag 和回执。
- **R2 已写入 ≠ Mac 已同步。** Mac 端仍要保持联网、运行 Obsidian，等待下一次 Remotely Save 双向同步。
- 如果 Mac 暂时离线且本地修改未上传，应避免批准对同一笔记的云端修改。R2 条件写入只能检测云端版本变更。
- 成功的知识图谱输出需要区分已解析的 WikiLink 与语义推断，源论文英文引句要保留可核对的出处；不能把 AI 产生的链接直接当成可靠引用证据。
