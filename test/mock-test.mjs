/**
 * Mock-server check for the DeepSeek document-parsing client.
 * Verifies the multipart field order, the document block shape, the reasoning
 * parameter, SSE parsing, the truncation signal, the empty-answer recovery, the
 * upload cache key, the purpose-per-extension rule, and list/delete calls
 * without touching the real API.
 *
 * Run: node test/mock-test.mjs
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, askWithRecovery, createClient, resolveConfig } from '../index.js'

// Keep upload ids out of the real harness cache.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-file-parse-'))

const received = { uploads: [], messages: [], list: 0, deleted: [] }

/** SSE replies handed out in order; the default answers normally. */
const NORMAL_SSE = 'event: message_start\ndata: {"type":"message_start"}\n\n'
  + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"The paper "}}\n\n'
  + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"proposes GazeVLM."}}\n\n'
  + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":12,"output_tokens":7}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
const truncatedSse = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"The paper proposes"}}\n\n'
  + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"input_tokens":12,"output_tokens":900}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
const emptyTruncatedSse = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"long silent reasoning"}}\n\n'
  + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"input_tokens":12,"output_tokens":8192}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
const replies = []

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString('utf8')

  if (req.method === 'POST' && url.pathname === '/anthropic/v1/files') {
    received.uploads.push({ headers: req.headers, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'file-api-test123', bytes: 4242, filename: 'paper.pdf', created_at: 1 }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/anthropic/v1/messages') {
    received.messages.push({ headers: req.headers, body: JSON.parse(body) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(replies.shift() ?? NORMAL_SSE)
    return
  }
  if (req.method === 'GET' && url.pathname === '/anthropic/v1/files') {
    received.list += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'file-a', filename: 'a.pdf', bytes: 10, created_at: 5 }], has_more: false }))
    return
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/anthropic/v1/files/')) {
    received.deleted.push(decodeURIComponent(url.pathname.split('/').pop()))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }
  res.writeHead(404)
  res.end('not found')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const baseURL = `http://127.0.0.1:${port}`

const config = resolveConfig({ baseURL, model: 'deepseek-flash', maxTokens: 1024, timeoutMs: 30_000 })
const client = createClient(config, async () => ({ 'x-api-key': 'test-key' }))

// 1. Upload: purpose must precede file, and the beta header must be present.
const upload = await client.upload({ bytes: new Uint8Array([1, 2, 3]), filename: 'paper.pdf', purpose: 'rich_layout_recognition' })
assert.equal(upload.fileId, 'file-api-test123')
assert.equal(upload.bytes, 4242)
assert.equal(upload.filename, 'paper.pdf')
const sent = received.uploads[0]
assert.equal(sent.headers['x-api-key'], 'test-key')
assert.equal(sent.headers['anthropic-beta'], 'files-api-2025-04-14')
const purposeAt = sent.body.indexOf('name="purpose"')
const fileAt = sent.body.indexOf('name="file"')
assert.ok(purposeAt >= 0 && fileAt > purposeAt, 'purpose must precede file')
assert.ok(sent.body.includes('rich_layout_recognition'))

// 2. Ask: a document block referencing the file id, then the question text.
const asked = await client.ask({ fileId: upload.fileId, question: 'What is this?', model: 'deepseek-flash' })
assert.equal(asked.answer, 'The paper proposes GazeVLM.')
assert.equal(asked.usage.inputTokens, 12)
const message = received.messages[0]
assert.equal(message.body.messages[0].content[0].type, 'document')
assert.equal(message.body.messages[0].content[0].source.file_id, 'file-api-test123')
assert.equal(message.body.messages[0].content[1].text, 'What is this?')
assert.equal(message.headers['anthropic-beta'], 'files-api-2025-04-14')

// 3. List and delete.
const listed = await client.listFiles({ limit: 5 })
assert.equal(listed.files.length, 1)
assert.equal(listed.files[0].id, 'file-a')
assert.equal(received.list, 1)
await client.deleteFile({ fileId: 'file-a' })
assert.deepEqual(received.deleted, ['file-a'])

// 4. The reasoning parameter: configured effort by default, overridable, omitted for "default".
assert.equal(received.messages[0].body.reasoning.effort, 'low')
assert.equal(received.messages[0].body.max_tokens, 1024)
await client.ask({ fileId: upload.fileId, question: 'q', model: 'deepseek-flash', effort: 'none' })
assert.equal(received.messages[1].body.reasoning.effort, 'none')
await client.ask({ fileId: upload.fileId, question: 'q', model: 'deepseek-flash', effort: 'default' })
assert.equal(received.messages[2].body.reasoning, undefined)

// 5. A max_tokens stop is reported instead of passing a half answer off as complete.
replies.push(truncatedSse)
const cut = await client.ask({ fileId: upload.fileId, question: 'q', model: 'deepseek-flash' })
assert.equal(cut.answer, 'The paper proposes')
assert.equal(cut.truncated, true)
assert.equal(cut.stopReason, 'max_tokens')

// 6. An answer-less max_tokens stop retries once with thinking disabled.
const state = { client, config }
replies.push(emptyTruncatedSse, NORMAL_SSE)
const recovered = await askWithRecovery(state, { fileId: upload.fileId, question: 'q', model: 'deepseek-flash' })
assert.equal(recovered.retried, true)
assert.equal(recovered.result.answer, 'The paper proposes GazeVLM.')
assert.equal(received.messages.at(-1).body.reasoning.effort, 'none')

// 7. Both attempts empty: the error blames the output budget, not the document.
replies.push(emptyTruncatedSse, emptyTruncatedSse)
await assert.rejects(
  () => askWithRecovery(state, { fileId: upload.fileId, question: 'q', model: 'deepseek-flash' }),
  /max_tokens 1024/,
)

// 8. Purpose follows the extension: text/tables use user_data, documents do not.
const tools = []
const fakeCtx = {
  get: (service) => (service === 'credentials'
    ? { resolve: async () => ({ value: 'test-key' }) }
    : undefined),
  inject: (_names, callback) => callback({ tools: { register: (tool) => tools.push(tool) } }),
}
apply(fakeCtx, { baseURL, model: 'deepseek-flash', maxTokens: 1024, timeoutMs: 30_000 })
const docQa = tools.find((tool) => tool.name === 'document_qa')
const exec = {}
const workdir = process.env.DSH_HOME
const csvPath = join(workdir, 'table.csv')
await writeFile(csvPath, 'a,b\n1,2\n')
const csv = await docQa.execute({ path: csvPath }, exec)
assert.equal(csv.purpose, 'user_data')
assert.ok(received.uploads.at(-1).body.includes('user_data'))

const pdfPath = join(workdir, 'paper.pdf')
await writeFile(pdfPath, '%PDF-1.4')
await assert.rejects(() => docQa.execute({ path: pdfPath, purpose: 'user_data' }, exec), /only applies/)
await assert.rejects(() => docQa.execute({ path: join(workdir, 'notes.zip') }, exec), /Unsupported file type/)
assert.equal(typeof docQa.output.render({}, {
  answer: 'x', fileId: 'f', filename: 'a.pdf', bytes: 1, purpose: 'text_recognition',
  model: 'm', reusedUpload: false, truncated: true, stopReason: 'max_tokens', retriedWithoutThinking: true,
})[0].text, 'string')

// 9. Provider errors surface as readable messages.
server.close()
const closed = createClient(resolveConfig({ baseURL, timeoutMs: 5000 }), async () => ({ 'x-api-key': 'k' }))
await assert.rejects(
  closed.listFiles({ limit: 1 }),
  /HTTP|fetch|ECONN/i,
)

console.log('mock-test: ok')
