# DeepSeek 官方文件解析

通过官方 DeepSeek 文档解析 API（Files API + Anthropic 兼容 Messages）读取本地 PDF、Word、PowerPoint，并把解析结果交给 `deepseek-flash` 回答关于它的问题。解析方式与 DeepSeek 官方 Chat Demo（`deepseek-ai/chat-demo`）完全一致。

## 功能

两个工具：

- `document_qa` — 上传（或复用已上传的）文档，解析后回答一个问题。参数：`path` 必填；`question` 省略时做整体总结；`purpose` 选择解析模式；`model` 覆盖回答模型。
- `document_files` — `list` 列出账号下已存储的解析文件，`delete` 按 `fileId` 删除，用于回收配额。

`purpose` 的两种取值就是官方文档里的两种解析方式：

| purpose | 模型拿到什么 | 适用 |
| --- | --- | --- |
| `rich_layout_recognition`（默认） | 文字，加上按原位置裁出的图表、照片、示意图 | 带图表的报告、论文、幻灯片 |
| `text_recognition` | 只有文字，图被丢弃 | 合同、纯文字材料，更省 token |

## 为什么由插件再调用一次模型

Harness 的 DeepSeek 适配器目前只接受 `text` 与 `image` 两种内容块，不能把 `file_id` 作为 `document` 块并入当前会话的请求；而官方 API 规定解析结果不可下载，只能通过引用 `file_id` 的对话请求读取。因此插件用一次独立的 Messages 调用完成"读文档"，把答案作为工具结果返回给当前会话。这相当于把官方解析能力作为一个可调用的服务，而不是把整页文档渲染成图片再看。

## 配置

在 **插件** 页面该行的配置里可改（默认值如下）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://api.deepseek.com` | 官方 API 地址 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭证引用名，从 Harness 凭证库解析 |
| `model` | `deepseek-flash` | 回答文档问题的模型 |
| `maxTokens` | `8192` | 单次回答上限 |
| `timeoutMs` | `300000` | 单次上传/问答的超时（解析本身可能耗时较久） |
| `defaultPurpose` | `rich_layout_recognition` | 未指定时的解析模式 |

鉴权按以下顺序解析，和 Harness 模型请求保持一致：

1. Harness 凭证服务里的 `DEEPSEEK_API_KEY`（**设置 → 模型** 中填写的 API Key）；
2. 已登录的 DeepSeek 账号令牌（`x-dsh-auth-token`，与网页版登录一致）；
3. 启动环境变量 `DEEPSEEK_API_KEY`。

## 限制与计费

- 单文件最大 100 MiB、最多 1000 页；只接受 PDF、DOC、DOCX、PPT、PPTX。纯文本、Markdown、图片不经过此 API，用普通读文件/图片工具即可。
- 上传时按页计费，之后每次提问只计 token。同一文件（内容 sha256 + 解析模式 + API 主机相同）会复用已上传的 `file_id`，不重复解析；删除缓存或换模式会重新上传。
- 官方说明：文档里的图由版面分析自动裁出，**不保证每张图都被识别**；未裁出的图模型看不到。需要逐图确认时，用 `rich_layout_recognition` 并在问题里点名图号。
- 上传缓存位于 `~/.dsh/dsh-official-file-parse/files.json`，只保存 `file_id` 与文件名，不保存文档内容。

## 验证情况

在本地 Harness（deepseek-flash、账号登录）上实测通过：

- 单页 PDF（`rich_layout_recognition`）：正确读出正文中的 `MAGPIE-7`；重复提问复用上传，未重复解析。
- 单页 PDF 内嵌位图：`rich_layout_recognition` 正确读出"蓝色 / FIG-42"；`text_recognition` 只提取到图中的文字、读不出颜色，两种模式的差异与官方说明一致。
- 17 页论文（15 MiB）：同时正确读出 Table 1 的数值与 Figure 2 的曲线（α_s=4 饱和）。
- 上传/列表/删除、断网与错误响应、缓存失效后重传均有测试覆盖（`test/mock-test.mjs` 用本地 mock 服务校验 multipart 字段顺序、`document` 块结构与 SSE 解析）。

## 说明

插件不写 Harness 的会话日志，也不改变当前会话的请求内容：它只注册两个工具，并把文档内容转成文字答案。上传的文档会保存在 DeepSeek 账号下，直到用 `document_files` 删除或用尽配额。
