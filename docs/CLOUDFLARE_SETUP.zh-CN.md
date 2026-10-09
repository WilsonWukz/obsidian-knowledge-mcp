# Cloudflare R2 + Obsidian + MCP：首次部署

本指南面向 **Mac 原生 Obsidian、云端全天候 Jarvis、尽量利用免费额度**。你已成功部署 v0.1 只读 Worker，且测试 Vault 已通过 Mac → R2 同步、ChatGPT 云端读取；以下流程也适用于重新部署 v0.2。**v0.2 的云端受控写入及 Mac 拉取仍须单独验收。**

## 0. 不动原来的 Vault

在 Mac 的 Obsidian 中先新建一个独立的 `Research-MCP-Test` 测试 Vault，放入两篇虚构 Markdown 笔记，例如一篇含 `[[Graph]]` 双链；**不要复制真实科研笔记、R2 密钥、账户口令**。后续验证云同步、离线修改和冲突后，再迁移原 Vault。

## 1. 创建 Cloudflare 资源

1. 访问 https://dash.cloudflare.com 注册并登录。
2. 进入 **R2 Object Storage**，根据控制台提示启用 R2；免费额度可能仍需要先登记支付方式。先阅读费用条件。
3. 找到 Cloudflare **Account ID**（账户标识，可以告诉 Jarvis，不是密码）。
4. 记下准备创建的 bucket 名，例如 `wilson-research-vault`；它仅在你的账户内需要唯一，建议与 Zotero 存储保持独立。
5. 不需要购买域名，Worker 可使用免费的 `*.workers.dev`。

## 2. 推荐：在 GitHub 一键部署（Mac 不用安装环境）

代码仓库现已提供 [Deploy Obsidian Cloud (manual)](https://github.com/WilsonWukz/obsidian-knowledge-mcp/actions/workflows/deploy-cloudflare.yml) 工作流。**必须手动触发**，不会因为代码更新就动你的云端资源。

**A. 创建仅限 Cloudflare 部署的 API Token：**

1. Cloudflare Dashboard → **My Profile → API Tokens**（或 Manage account → Account API tokens）→ **Create Token**。
2. 选择 **Edit Cloudflare Workers** 模板；检查包含 Workers Scripts、Workers KV Storage、Workers R2 Storage 的写权限，**仅限你自己的 Cloudflare Account**。如果页面使用新权限体系，需要授予创建 Worker、KV、R2 的相应权限。
3. 完成创建后，将令牌复制到密码管理器；**不要贴在聊天、仓库、Slack、Issue 或工作流输入框中**。

**B. 把两项凭据放到 GitHub Secret，而不是代码：**

仓库 → **Settings → Secrets and variables → Actions → New repository secret**。

| Secret 名称 | 填入内容 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 上一步创建的 Cloudflare 部署 API Token |
| `OBSIDIAN_MCP_AUTH_PASSWORD` | 自己生成的 **至少 32 字符的全新独立口令**，保存在密码管理器中，后续 ChatGPT/Slack OAuth 登录要用 |

注意：**第二项不是 Cloudflare Token、不是 Zotero 密码，也不是稍后 Remotely Save 的 R2 Access Key。** 三种凭据各司其职，不要混用。

**C. 点击手动部署：**

1. 仓库 → **Actions → Deploy Obsidian Cloud (manual) → Run workflow**（选择 `main`）。
2. `account_id` 填你的 32 位 Cloudflare Account ID。
3. `bucket_name` 保持默认 **`wilson-obsidian-mcp-test`**，它会成为专门的私人**测试存储桶**；如果账号已有同名存储桶，先确认其中没有需要保护的数据。生产笔记库暂不接入。
4. v0.2 额外填写 `public_origin` 为 `https://obsidian-knowledge-mcp.wilsonkwu.workers.dev`，`enable_reviewed_writes` **默认先保持 false**。点击 **Run workflow**。流水线先跑全部离线测试，随后创建或复用 R2 bucket 与 OAuth KV、部署 Worker、设置 OAuth Secret、并检查 `/health` 中的版本和写入开关。只有测试 Vault 备份、审批与 Mac 双向拉取验证准备就绪后，再专门以 true 重新运行。
5. 成功后打开该 Action 的 **Summary**，复制其中 `https://...workers.dev/mcp` 地址，返回聊天告诉我地址即可。**只发 MCP URL，不发送 Secret。**

这套部署通过 GitHub Actions 的短期运行环境调用 Wrangler。R2 与 Workers Free 有使用限额，首次启用 R2 可能要求 Cloudflare 结算设置。部署流水线从不把凭据写进 Git 仓库；**工作流实际运行成功前，不能宣称已完成云端部署**。

### 备选：Mac 本地部署

如果 GitHub Actions 权限配置不便，也可以运行：

```bash
git clone https://github.com/WilsonWukz/obsidian-knowledge-mcp.git
cd obsidian-knowledge-mcp
npm ci
npm test
cp .env.example .env
# 在本机填写 .env 的 CLOUDFLARE_ACCOUNT_ID 和 R2_BUCKET_NAME，MCP_HOSTNAME 留空
npx wrangler login
npm run setup
npx wrangler deploy
npx wrangler secret put AUTH_PASSWORD
```

不要把 `.env`、口令或 API Token 发到聊天或公开仓库。

## 3. 为 Obsidian 配置 R2 双向同步

Mac Obsidian 的 Remotely Save 是真正负责把云端改动下载回本地的组件。设置 → Remotely Save → **高级设置 → 同步方向 `Bidirectional`**；初次使用先手动同步并验收，后续再设置每 5 分钟自动运行和启动后同步一次。正式对同一篇笔记并发修改前必须处理本地离线版本冲突，不能只靠“保留较新”时间戳。完整操作与测试见 [Mac ↔ R2 双向同步验收](MAC_BIDIRECTIONAL_SYNC.zh-CN.md)。



Cloudflare → R2 → **Manage R2 API Tokens** → 创建仅能访问新 bucket 的读写 API token。把它保存在你的密码管理器中（不要在 GitHub 和 Slack 里发送）。

Mac Obsidian → Settings → Community plugins → 搜索并安装 **Remotely Save**，选择 S3 / Compatible：

- Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
- Bucket: 与 Worker 相同的 R2 bucket
- Access Key / Secret Key: 新建的 bucket-scoped token
- URL style: **Path-style**
- Remote prefix: 与 `VAULT_PREFIX` 完全一致（初次建议都留空）
- Client-side encryption: **OFF**（否则 Worker 读不到笔记；注意这意味着不是真正端到端加密）

同步前，确认没有把 `.obsidian/plugins/remotely-save/data.json` 同步到云端，它可能包含密钥。首次只同步测试 Vault，验证文件在 R2 对象列表中、修改可双向同步且不存在覆盖事故。

## 4. 接入 ChatGPT / Slack

用部署 URL 检查 `/health` 返回服务正常。通过 ChatGPT 自定义 MCP 连接 `https://<worker>.workers.dev/mcp`，在 OAuth 网页输入刚才的 `AUTH_PASSWORD`。

首先测试 `list_notes`、`read_note`、`get_note_graph`：应能检索测试笔记，并在图谱中看到两篇通过 `[[wikilink]]` 建立的显式链接。再让 Slack Jarvis 从自己的工具环境独立验证，不能直接把 ChatGPT 成功等同于 Slack 成功。

**只有完成 Cloudflare Live / 两端 OAuth / 双向同步和备份验证，才能把项目标记为真正已上线。**

## 安全提示

- 这套方案不用在 Mac 上运行常驻 MCP 服务；但 Mac 本地修改依赖 Remotely Save 联网同步。
- R2 为服务端加密存储，不代表仅你本人能够解密。Worker 会处理明文笔记。
- R2/Workers 免费额度有上限，需主动查看账单和 API 请求量。
- v0.1 只有读工具；任何自动写笔记的能力等 v0.2 独立审核系统上线后再开启。
