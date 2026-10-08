# Cloudflare R2 + Obsidian + MCP：首次部署

本指南面向 **Mac 原生 Obsidian、云端全天候 Jarvis、尽量利用免费额度**。代码已经在仓库，但当前尚未部署到你的 Cloudflare 帐户。

## 0. 不动原来的 Vault

在 Mac 的 Obsidian 中先新建一个独立的 `Research-MCP-Test` 测试 Vault，放入两篇虚构 Markdown 笔记，例如一篇含 `[[Graph]]` 双链；**不要复制真实科研笔记、R2 密钥、账户口令**。后续验证云同步、离线修改和冲突后，再迁移原 Vault。

## 1. 创建 Cloudflare 资源

1. 访问 https://dash.cloudflare.com 注册并登录。
2. 进入 **R2 Object Storage**，根据控制台提示启用 R2；免费额度可能仍需要先登记支付方式。先阅读费用条件。
3. 找到 Cloudflare **Account ID**（账户标识，可以告诉 Jarvis，不是密码）。
4. 记下准备创建的 bucket 名，例如 `wilson-research-vault`；它仅在你的账户内需要唯一，建议与 Zotero 存储保持独立。
5. 不需要购买域名，Worker 可使用免费的 `*.workers.dev`。

## 2. 本地一次性部署（Node.js 22+）

```bash
git clone https://github.com/WilsonWukz/obsidian-knowledge-mcp.git
cd obsidian-knowledge-mcp
npm ci
npm test
cp .env.example .env
```

在你的 Mac 上用编辑器修改私密的 `.env`（该文件已加入 Git 忽略），填写：

```dotenv
CLOUDFLARE_ACCOUNT_ID=这里填你的AccountID
R2_BUCKET_NAME=wilson-research-vault
MCP_HOSTNAME=
VAULT_PREFIX=
```

然后依次执行：

```bash
npx wrangler login
npm run setup
npx wrangler secret put AUTH_PASSWORD
npx wrangler deploy
```

`AUTH_PASSWORD` 请使用新的长随机口令，**不要**复用 Zotero MCP 密码，**不要发到聊天里**。也不要设置 `UPLOAD_TOKEN`，v0.1 禁止上传。

`npm run setup` 会调用 Cloudflare API 创建 R2 bucket、OAuth KV 命名空间及本地私有 Wrangler 配置。部署后记下控制台返回的 `https://...workers.dev` URL。

## 3. 为 Obsidian 配置 R2 同步

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
