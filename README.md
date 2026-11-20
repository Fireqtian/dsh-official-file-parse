# deepseek-doc-parse

[English](README.en.md) | 简体中文

DeepSeek Harness 的文档解析插件：把本地 PDF、Word、PowerPoint 通过**官方 DeepSeek 文档解析 API**（Files API + Anthropic 兼容 Messages）解析，再基于解析结果回答问题。解析方式与 DeepSeek 官方 Chat Demo（[`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo)）完全一致。

- **`rich_layout_recognition`（默认）**：文字 + 按原位置裁出的图表、照片、示意图，适合论文、财报、幻灯片。
- **`text_recognition`**：只要文字，图被丢弃，更省 token，适合合同、纯文字材料。

不裁剪、不重编码图片，也不需要把整页渲染成截图；解析和问答都在服务端完成。

## 安装

需要 DeepSeek Harness（`dsh`）。本插件是标准 Bundle：`package.json` 通过 `dsh.bundle.patch` 声明一行 Host 插件，两个工具在 `apply` 里用 `ctx.tools.register()` 注册。

**方式一：本地目录**（最简单）

```sh
git clone https://github.com/Fireqtian/deepseek-doc-parse.git
```

然后在 Harness 打开 **插件 → 添加插件 → 选择本地目录**（或插件页的“从本地目录安装”），指向 clone 下来的 `deepseek-doc-parse` 目录。安装后插件行 `deepseek-doc-parse` 出现并自动生效。

> 也可以把该包发布到 npm 后按包名安装；插件管理器与 `dsh plugin --profile <name> add` 都会把包安装进 profile。

安装后新开会话即可使用；改代码后需要在插件页 disable/enable 一次（或重启 Harness）才会加载新的 JS。

## 鉴权

插件与 Harness 模型请求使用同一套凭据，按顺序解析：

1. Harness 凭证服务里的 `DEEPSEEK_API_KEY`（**设置 → 模型** 中填写，`x-api-key`）；
2. 已登录的 DeepSeek 账号令牌（`x-dsh-auth-token`）；
3. 启动环境变量 `DEEPSEEK_API_KEY`。

三者都没有时，工具会返回一条明确的提示，不会静默失败。

## 使用

安装后模型会多出两个工具，直接说人话即可触发。

```text
document_qa(path="C:\docs\report.pdf", question="这张表里 2025 年的营收是多少？")
document_qa(path="paper.pdf", purpose="text_recognition", question="总结这篇论文的贡献")
document_qa(path="slides.pptx")            # 不传 question 时做整体总结
document_files(action="list")              # 查看账号下已存储的解析文件
document_files(action="delete", fileId="file-api-...")
```

| 参数 | 说明 |
| --- | --- |
| `path` | 绝对路径，或相对会话工作目录的路径；支持 PDF / DOC / DOCX / PPT / PPTX |
| `question` | 想问的问题；省略时做整体总结 |
| `purpose` | `rich_layout_recognition`（默认）或 `text_recognition` |
| `model` | 回答文档问题的模型，默认 `deepseek-flash` |

## 配置

插件行配置（也可在 **插件** 页修改）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://api.deepseek.com` | 官方 API 地址 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭证引用名 |
| `model` | `deepseek-flash` | 回答模型 |
| `maxTokens` | `8192` | 单次回答上限 |
| `timeoutMs` | `300000` | 单次上传/问答超时（解析可能较慢） |
| `defaultPurpose` | `rich_layout_recognition` | 未指定时的解析模式 |

## 实现要点

- `POST /anthropic/v1/files`：multipart 上传，`purpose` 必须排在 `file` 之前；服务端解析完成后才返回 `file_id`。
- `POST /anthropic/v1/messages`：内容块 `{type:'document', source:{type:'file', file_id}}` + 问题文本，`anthropic-beta: files-api-2025-04-14`。
- 按 `sha256(文件内容) + purpose + API 主机` 缓存 `file_id`（`~/.dsh/deepseek-doc-parse/files.json`），同一文件不会重复解析计费；缓存 id 失效时自动重传一次。
- 文件通过 Harness 的 `ctx.fs` 读取（遵守沙箱与观察策略），仅在服务缺失时回退 Node `fs`。
- 只依赖 Node 内置模块，不引入任何 `@deepseek-ai/*` 依赖，避免插件与宿主版本耦合。

> 为什么要"再调用一次模型"：Harness 的 DeepSeek 适配器目前只接受 `text` / `image` 内容块，不能把 `file_id` 并入当前会话请求；而官方规定解析结果不可下载。因此插件用一次独立 Messages 调用完成读文档，把答案作为工具结果返回。

## 限制

- 单文件 ≤ 100 MiB、≤ 1000 页；不支持纯文本/Markdown/图片（直接读文件或用图片工具更快）。
- 上传时按页计费，之后每次提问按 token 计费。
- 官方说明：文档里的图由版面分析自动裁出，**不保证每张图都被识别**；未裁出的图模型看不到。
- 上传的文档保存在 DeepSeek 账号下，用 `document_files` 删除。

## 开发

```sh
node --check index.js
node test/mock-test.mjs      # 本地 mock 服务，校验 multipart 顺序、document 块、SSE 解析、列表/删除
```

`test/mock-test.mjs` 不需要网络和 API Key。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | 插件入口：两个工具、Files/Messages 客户端、上传缓存 |
| `cordis.patch.yml` | Bundle 的 Host 插件行与默认配置 |
| `locale/{en,zh}.json` | 插件管理器里的标题、描述、详情页路径 |
| `icon.svg` | 插件图标（36×36，自包含 SVG） |
| `docs/DETAIL.md` | 插件详情页正文 |
| `test/mock-test.mjs` | 离线集成测试 |

## 验证情况

在 DeepSeek Harness（`deepseek-flash`、账号登录）上实测：

- 单页 PDF：正确读出正文中的关键词；重复提问复用上传（`reused upload`）。
- 带内嵌位图的单页 PDF：`rich_layout_recognition` 正确回答"蓝色 / FIG-42"；`text_recognition` 只提到图中文字、读不出颜色，与官方模式说明一致。
- 17 页、15 MiB 论文：正确读出表格数值与曲线结论。
- 上传 / 列表 / 删除 / 缓存失效重传 / 错误响应均有测试覆盖。

## 许可证

MIT，见 [LICENSE](LICENSE)。
