# dsh-official-file-parse

English | [简体中文](README.md)

Document parsing for DeepSeek Harness: upload a local PDF, Word, or PowerPoint file to the **official DeepSeek document-parsing API** (Files API + Anthropic-compatible Messages), then answer questions about it. The parsing flow matches the official [DeepSeek Chat demo](https://github.com/deepseek-ai/chat-demo).

- `rich_layout_recognition` (default): text plus figures, charts, and their positions.
- `text_recognition`: text only, cheaper and without figures.

## Install

A standard DSH bundle: `package.json` declares a Host row through `dsh.bundle.patch`, and `index.js` registers both tools with `ctx.tools.register()`.

```sh
git clone https://github.com/Fireqtian/dsh-official-file-parse.git
```

Then in Harness choose **Plugins → Add plugin → local directory** and select the cloned folder. Once published to npm, the package name alone is enough for the plugin manager or `dsh plugin --profile <name> add`. New sessions get the tools; after editing the code, disable/enable the row (or restart) to load the new module generation.

## Authentication

The plugin uses the same credential as the Harness model requests, in order: the harness credential `DEEPSEEK_API_KEY` (`x-api-key`), the signed-in DeepSeek account token (`x-dsh-auth-token`), then the `DEEPSEEK_API_KEY` environment variable.

## Tools

- `document_qa(path, question?, purpose?, model?)` — parse and ask; omitting `question` summarizes the document.
- `document_files(action: "list" | "delete", fileId?, limit?)` — inspect or remove stored uploads.

| Config | Default |
| --- | --- |
| `baseURL` | `https://api.deepseek.com` |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` |
| `model` | `deepseek-flash` |
| `reasoningEffort` | `low` (`default`/`none`/`low`/`high`/`max`; `default` omits the field) |
| `maxTokens` | `32768` (shared with thinking tokens) |
| `timeoutMs` | `300000` |
| `defaultPurpose` | `rich_layout_recognition` |

## How it works

`POST /anthropic/v1/files` with multipart (`purpose` before `file`) parses the file server-side and returns a `file_id`; `POST /anthropic/v1/messages` then sends `{type:'document', source:{type:'file', file_id}}` with the question and the `files-api-2025-04-14` beta header. Uploads are cached by file digest, purpose, and API host, so a document is never parsed twice; a stale id is retried once.

Thinking is enabled by default at effort `high` and shares `max_tokens` with the answer, so the request sets `reasoning: {effort}` (default `low`) and exposes `stop_reason`: a `max_tokens` stop marks the result as truncated instead of passing a half answer off as complete, and an answer-less stop retries once with thinking disabled before failing with an output-budget error.

The adapter currently accepts only `text` and `image` content blocks, and the API does not expose parsed text for download, so the plugin answers through one isolated Messages call and returns the answer as the tool result.

## Limits

- ≤ 100 MiB and ≤ 1000 pages per file for PDF / DOC / DOCX / PPT / PPTX and images (PNG, JPEG, WebP, GIF, BMP, TIFF); plain text, tables and ebooks go through `user_data` (≤ 32 MiB, not billed for parsing).
- Parsing is billed per page at upload; questions are billed as tokens.
- Figure cropping is best effort: the provider does not guarantee every figure is detected.
- Parse results cannot be downloaded, so the cropped figures never leave the provider's context.

## Development

```sh
node --check index.js
node test/mock-test.mjs
```

## License

MIT — see [LICENSE](LICENSE).
