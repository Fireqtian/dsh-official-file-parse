/**
 * DeepSeek document parsing for DeepSeek Harness.
 *
 * Uploads a local document to the official DeepSeek Files API with the same
 * `purpose` values the official chat demo uses (`text_recognition` drops
 * figures, `rich_layout_recognition` keeps them), then answers questions about
 * it through the Anthropic-compatible Messages API by referencing the returned
 * `file_id` as a `document` content block.
 *
 * This file deliberately imports only Node builtins: a profile-installed bundle
 * resolves the harness packages from the dsh installation, and the plain tool
 * object accepted by `ctx.tools.register()` needs no harness imports.
 *
 * @module @local/deepseek-doc-parse
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'

/** Plugin name shown in diagnostics. */
export const name = 'deepseek-doc-parse'

/** The tools service supplies `ctx.tools`; everything else is optional. */
export const inject = ['tools']

/** Values used when the bundle's row config omits a key. */
const DEFAULTS = {
  baseURL: 'https://api.deepseek.com',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  model: 'deepseek-flash',
  maxTokens: 8192,
  timeoutMs: 300_000,
  defaultPurpose: 'rich_layout_recognition',
}

/** Files API limits from the official document-parsing guide. */
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024

/** Purposes accepted by the Files API for document parsing. */
const PURPOSES = ['text_recognition', 'rich_layout_recognition']

/** Extensions the parsing endpoint accepts. */
const DOCUMENT_EXTS = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx'])

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** Files API beta header required by the Anthropic-compatible surface. */
const FILES_BETA = 'files-api-2025-04-14'

/** Resolve the bundle row config with defaults. */
export function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const num = (value, fallback) => (Number.isFinite(value) ? Number(value) : fallback)
  const baseURL = typeof raw.baseURL === 'string' && raw.baseURL !== ''
    ? raw.baseURL.replace(/\/+$/u, '')
    : DEFAULTS.baseURL
  return {
    baseURL,
    apiKeyEnv: typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv !== '' ? raw.apiKeyEnv : DEFAULTS.apiKeyEnv,
    model: typeof raw.model === 'string' && raw.model !== '' ? raw.model : DEFAULTS.model,
    maxTokens: Math.max(256, Math.trunc(num(raw.maxTokens, DEFAULTS.maxTokens))),
    timeoutMs: Math.max(10_000, Math.trunc(num(raw.timeoutMs, DEFAULTS.timeoutMs))),
    defaultPurpose: PURPOSES.includes(raw.defaultPurpose) ? raw.defaultPurpose : DEFAULTS.defaultPurpose,
  }
}

/** Harness home; the upload cache lives beside other harness state. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** On-disk cache path for uploaded file ids. */
function cachePath() {
  return join(dshHome(), 'deepseek-doc-parse', 'files.json')
}

/** Read the cache, tolerating a missing or corrupt file. */
async function readCache() {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.files && typeof parsed.files === 'object') {
      return parsed
    }
  } catch {
    // A missing or unreadable cache only costs one redundant upload.
  }
  return { version: 1, files: {} }
}

/** Atomically persist the cache; failures never fail the tool call. */
async function writeCache(cache) {
  const path = cachePath()
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await mkdir(join(dshHome(), 'deepseek-doc-parse'), { recursive: true })
    await writeFile(temporary, JSON.stringify(cache, null, 2), 'utf8')
    await rename(temporary, path)
  } catch {
    // Best effort: an unwritable cache still yields a correct answer.
  }
}

/** One readable provider error, trimmed for a tool result. */
function providerError(status, body) {
  let detail = ''
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body
    detail = parsed?.error?.message ?? parsed?.message ?? ''
  } catch {
    detail = typeof body === 'string' ? body : ''
  }
  const text = String(detail).replace(/\s+/gu, ' ').trim().slice(0, 600)
  return new Error(`DeepSeek API returned HTTP ${status}${text === '' ? '' : `: ${text}`}`)
}

/** Combine caller cancellation with the configured per-call deadline. */
function withDeadline(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** Read one `text/event-stream` body and yield (event, JSON) pairs. */
async function* readServerSentEvents(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const index = buffer.indexOf('\n\n')
        if (index < 0) break
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        let eventName = 'message'
        const dataLines = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          else if (line.startsWith(':')) continue
        }
        if (dataLines.length === 0) continue
        const data = dataLines.join('\n')
        if (data === '[DONE]') return
        try {
          yield { event: eventName, payload: JSON.parse(data) }
        } catch {
          // Ignore frames that are not JSON.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Build the provider client bound to one resolved configuration.
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {() => Promise<Record<string, string>>} resolveAuth
 */
export function createClient(config, resolveAuth) {
  const filesURL = `${config.baseURL}/anthropic/v1/files`
  const messagesURL = `${config.baseURL}/anthropic/v1/messages`

  /** Headers shared by every Anthropic-compatible call. */
  const headers = async () => ({
    ...await resolveAuth(),
    'anthropic-beta': FILES_BETA,
  })

  /**
   * Upload one document; the provider parses it before responding.
   * @returns {{ fileId: string, bytes: number, filename: string }}
   */
  async function upload({ bytes, filename, purpose, signal }) {
    const form = new FormData()
    // The provider requires `purpose` to precede `file`.
    form.append('purpose', purpose)
    const mediaType = MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream'
    form.append('file', new Blob([bytes], { type: mediaType }), filename)
    const response = await fetch(filesURL, {
      method: 'POST',
      headers: await headers(),
      body: form,
      signal: withDeadline(signal, config.timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) throw providerError(response.status, text)
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('DeepSeek Files API returned a non-JSON response.')
    }
    const fileId = parsed?.id ?? parsed?.file_id
    if (typeof fileId !== 'string' || fileId === '') {
      throw new Error('DeepSeek Files API response carried no file id.')
    }
    return {
      fileId,
      bytes: Number(parsed?.bytes ?? parsed?.size_bytes ?? bytes.length),
      filename: typeof parsed?.filename === 'string' ? parsed.filename : filename,
    }
  }

  /** List the account's stored provider files. */
  async function listFiles({ limit = 20, signal }) {
    const response = await fetch(`${filesURL}?limit=${encodeURIComponent(String(limit))}`, {
      method: 'GET',
      headers: await headers(),
      signal: withDeadline(signal, 60_000),
    })
    const text = await response.text()
    if (!response.ok) throw providerError(response.status, text)
    const parsed = JSON.parse(text)
    const data = Array.isArray(parsed?.data) ? parsed.data : []
    return {
      files: data.map((entry) => ({
        id: String(entry?.id ?? ''),
        filename: String(entry?.filename ?? ''),
        bytes: finiteOr(entry?.bytes ?? entry?.size_bytes, 0),
        createdAt: finiteOr(entry?.created_at, 0),
      })).filter((entry) => entry.id !== ''),
      hasMore: Boolean(parsed?.has_more ?? false),
    }
  }

  /** Remove one stored provider file. */
  async function deleteFile({ fileId, signal }) {
    const response = await fetch(`${filesURL}/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: await headers(),
      signal: withDeadline(signal, 60_000),
    })
    if (!response.ok) throw providerError(response.status, await response.text())
  }

  /**
   * Ask one question about a parsed document; the file id is sent as a
   * `document` content block exactly as the official chat demo does.
   * @returns {{ answer: string, model: string, usage: object }}
   */
  async function ask({ fileId, question, model, signal }) {
    const body = {
      model,
      max_tokens: config.maxTokens,
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'file', file_id: fileId } },
            { type: 'text', text: question },
          ],
        },
      ],
    }
    const response = await fetch(messagesURL, {
      method: 'POST',
      headers: {
        ...await headers(),
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: withDeadline(signal, config.timeoutMs),
    })
    if (!response.ok) throw providerError(response.status, await response.text())
    if (response.body === null) throw new Error('DeepSeek Messages API returned no response body.')

    let answer = ''
    let usage = {}
    let failure = null
    for await (const { payload } of readServerSentEvents(response.body)) {
      if (payload?.type === 'content_block_delta' && payload?.delta?.type === 'text_delta') {
        answer += String(payload.delta.text ?? '')
      } else if (payload?.type === 'message_delta' && payload?.usage) {
        usage = { inputTokens: Number(payload.usage.input_tokens ?? 0), outputTokens: Number(payload.usage.output_tokens ?? 0) }
      } else if (payload?.type === 'error') {
        failure = new Error(`DeepSeek Messages API error: ${String(payload?.error?.message ?? 'unknown error')}`)
      } else if (payload?.type === 'message_stop') {
        break
      }
    }
    if (failure !== null) throw failure
    if (answer.trim() === '') throw new Error('DeepSeek returned an empty answer for this document.')
    return { answer: answer.trim(), usage }
  }

  return { upload, listFiles, deleteFile, ask }
}

/** Whether a provider failure means the cached file id is unusable. */
function looksLikeStaleFileId(message) {
  return /file.{0,40}(?:not[_ -]?found|expired|deleted|invalid|not created under)/iu.test(message)
    || /(?:invalid|missing).{0,20}file[_ -]?(?:id|api)/iu.test(message)
}

/** A finite number, or the fallback when the provider field is missing or not numeric. */
function finiteOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/** One file's display size. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Read one document body through the harness filesystem when available. */
async function readDocumentBytes(ctx, inputPath, cwd, signal) {
  const fs = ctx.get('fs')
  if (fs !== undefined && typeof fs.resolve === 'function' && typeof fs.readBytes === 'function') {
    const target = await fs.resolve(inputPath, { cwd, signal })
    const info = await fs.stat(target, signal)
    if (info === undefined) throw new Error(`No such file: ${inputPath}`)
    const size = Number(info.size ?? info.bytes ?? 0)
    if (size > MAX_DOCUMENT_BYTES) {
      throw new Error(`${basename(inputPath)} is ${formatBytes(size)}; the parsing API accepts at most 100 MiB.`)
    }
    const bytes = await fs.readBytes(target, signal, MAX_DOCUMENT_BYTES)
    return { bytes: new Uint8Array(bytes), size, name: basename(inputPath) }
  }
  const absolute = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath)
  const info = await stat(absolute)
  if (!info.isFile()) throw new Error(`Not a file: ${inputPath}`)
  if (info.size > MAX_DOCUMENT_BYTES) {
    throw new Error(`${basename(absolute)} is ${formatBytes(info.size)}; the parsing API accepts at most 100 MiB.`)
  }
  return { bytes: new Uint8Array(await readFile(absolute)), size: info.size, name: basename(absolute) }
}

/** Build the state shared by both tools. */
function createState(ctx, config) {
  const resolved = resolveConfig(config)
  const cache = { promise: undefined, value: undefined }

  /** Resolve authentication: harness credentials, the signed-in account, then the environment. */
  const resolveAuth = async () => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(resolved.apiKeyEnv)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value !== '') {
        return { 'x-api-key': hit.value }
      }
    }
    const account = ctx.get('deepseekAccount')
    if (account !== undefined && typeof account.resolveToken === 'function') {
      const token = await account.resolveToken(resolved.baseURL)
      if (typeof token === 'string' && token !== '') return { 'x-dsh-auth-token': token }
    }
    const ambient = process.env[resolved.apiKeyEnv]
    if (typeof ambient === 'string' && ambient !== '') return { 'x-api-key': ambient }
    throw new Error(
      `No DeepSeek credential: sign in to DeepSeek in the harness, or store ${resolved.apiKeyEnv}`
      + ' in Settings → Models, or export it before launching the harness.'
      + ' The parser calls the same official API as DeepSeek Chat.',
    )
  }

  const client = createClient(resolved, resolveAuth)

  const loadCache = async () => {
    cache.value ??= await readCache()
    return cache.value
  }

  /** Session working directory for relative paths, when the service is mounted. */
  const workingDirectoryOf = (exec) => {
    try {
      const service = ctx.get('workingDirectory')
      const session = exec?.agent?.session
      if (service !== undefined && session !== undefined && typeof service.get === 'function') {
        const directory = service.get(session)
        if (typeof directory === 'string' && directory !== '') return directory
      }
    } catch {
      // Fall through to the process directory.
    }
    return process.cwd()
  }

  return { ctx, config: resolved, client, loadCache, resolveAuth, workingDirectoryOf }
}

/** Upload (or reuse) a parsed document, retrying once when a cached id went stale. */
async function ensureUploaded(state, { bytes, filename, purpose, signal }) {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const key = `${new URL(state.config.baseURL).host}\u0000${purpose}\u0000${digest}`
  const cache = await state.loadCache()
  const cached = cache.files[key]
  if (cached !== undefined && typeof cached.fileId === 'string') {
    return { fileId: cached.fileId, purpose, filename: cached.filename ?? filename, reused: true }
  }
  const uploaded = await state.client.upload({ bytes, filename, purpose, signal })
  cache.files[key] = {
    fileId: uploaded.fileId,
    purpose,
    filename: uploaded.filename,
    bytes: uploaded.bytes,
    createdAt: Date.now(),
  }
  await writeCache(cache)
  return { fileId: uploaded.fileId, purpose, filename: uploaded.filename, reused: false }
}

/** Drop one cached mapping after the provider rejected its file id. */
async function forgetUpload(state, { bytes, purpose }) {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const key = `${new URL(state.config.baseURL).host}\u0000${purpose}\u0000${digest}`
  const cache = await state.loadCache()
  if (cache.files[key] !== undefined) {
    delete cache.files[key]
    await writeCache(cache)
  }
}

/** The `document_qa` tool: parse one local document and answer a question about it. */
function documentQaTool(state) {
  return {
    name: 'document_qa',
    description:
      'Read a local PDF, Word, or PowerPoint file through the official DeepSeek document-parsing API,'
      + ' then answer a question about it. The provider parses the file once on upload:'
      + ' "rich_layout_recognition" keeps figures, charts, and their positions; "text_recognition" keeps text only.'
      + ' Use it for questions that need the document\'s figures or layout, not for plain text files or images.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path, or a path relative to the session working directory. PDF, DOC/DOCX, PPT/PPTX.',
        },
        question: {
          type: 'string',
          description: 'What to ask about the document. Omit for a general summary.',
        },
        purpose: {
          type: 'string',
          enum: PURPOSES,
          description: 'Parse mode. Defaults to rich_layout_recognition; text_recognition is cheaper and drops figures.',
        },
        model: {
          type: 'string',
          description: `Model that answers about the parsed document. Defaults to ${DEFAULTS.model}.`,
        },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string' },
          fileId: { type: 'string' },
          filename: { type: 'string' },
          bytes: { type: 'number' },
          purpose: { type: 'string' },
          model: { type: 'string' },
          reusedUpload: { type: 'boolean' },
        },
        required: ['answer', 'fileId', 'filename', 'bytes', 'purpose', 'model', 'reusedUpload'],
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: `${value.answer}\n\n(parsed ${value.filename}, ${formatBytes(value.bytes)}, ${value.purpose}`
            + `${value.reusedUpload ? ', reused upload' : ''}; answered by ${value.model})`,
        }]
      },
    },
    async execute(args, exec) {
      const inputPath = String(args?.path ?? '').trim()
      if (inputPath === '') throw new Error('path is required.')
      const purpose = PURPOSES.includes(args?.purpose) ? args.purpose : state.config.defaultPurpose
      const extension = extname(inputPath).toLowerCase()
      if (!DOCUMENT_EXTS.has(extension)) {
        throw new Error(`Unsupported document type "${extension || '(none)'}": use PDF, DOC/DOCX, or PPT/PPTX.`)
      }
      const question = typeof args?.question === 'string' && args.question.trim() !== ''
        ? args.question.trim()
        : 'Summarize this document in detail: its purpose, its structure, and the key claims or data it contains.'
      const model = typeof args?.model === 'string' && args.model !== '' ? args.model : state.config.model
      const cwd = state.workingDirectoryOf(exec)
      const { bytes, name } = await readDocumentBytes(state.ctx, inputPath, cwd, exec?.signal)
      const upload = await ensureUploaded(state, { bytes, filename: name, purpose, signal: exec?.signal })

      let answer
      try {
        ({ answer } = await state.client.ask({
          fileId: upload.fileId,
          question,
          model,
          signal: exec?.signal,
        }))
      } catch (error) {
        if (!upload.reused || !looksLikeStaleFileId(String(error?.message ?? ''))) throw error
        await forgetUpload(state, { bytes, purpose })
        const fresh = await ensureUploaded(state, { bytes, filename: name, purpose, signal: exec?.signal })
        ({ answer } = await state.client.ask({ fileId: fresh.fileId, question, model, signal: exec?.signal }))
        return {
          answer,
          fileId: fresh.fileId,
          filename: fresh.filename,
          bytes: bytes.length,
          purpose,
          model,
          reusedUpload: false,
        }
      }

      return {
        answer,
        fileId: upload.fileId,
        filename: upload.filename,
        bytes: bytes.length,
        purpose,
        model,
        reusedUpload: upload.reused,
      }
    },
  }
}

/** The `document_files` tool: list or delete the account's stored parse uploads. */
function documentFilesTool(state) {
  return {
    name: 'document_files',
    description:
      'List or delete documents stored by the DeepSeek Files API for this account.'
      + ' Uploads are charged per page when parsed and count against the account file quota, so delete files you no longer need.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'delete'] },
        fileId: { type: 'string', description: 'File id to delete; required for action "delete".' },
        limit: { type: 'integer', description: 'Maximum files to list (1-100). Defaults to 20.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                filename: { type: 'string' },
                bytes: { type: 'number' },
                createdAt: { type: 'number' },
              },
              required: ['id', 'filename', 'bytes', 'createdAt'],
            },
          },
          deleted: { type: 'string' },
          hasMore: { type: 'boolean' },
        },
        required: ['action', 'files', 'deleted', 'hasMore'],
      },
      render(_args, value) {
        if (value.action === 'delete') {
          return [{ type: 'text', text: `Deleted provider file ${value.deleted}.` }]
        }
        if (value.files.length === 0) return [{ type: 'text', text: 'No stored provider files.' }]
        const lines = value.files.map((file) => `- ${file.id}  ${file.filename}  ${formatBytes(file.bytes)}`)
        return [{
          type: 'text',
          text: `${value.files.length} stored provider file(s)${value.hasMore ? ' (more available)' : ''}:\n${lines.join('\n')}`,
        }]
      },
    },
    async execute(args, exec) {
      const action = args?.action
      if (action === 'list') {
        const limit = Math.min(100, Math.max(1, Math.trunc(Number(args?.limit ?? 20))))
        const { files, hasMore } = await state.client.listFiles({ limit, signal: exec?.signal })
        return { action, files, deleted: '', hasMore }
      }
      if (action === 'delete') {
        const fileId = String(args?.fileId ?? '').trim()
        if (fileId === '') throw new Error('fileId is required for action "delete".')
        await state.client.deleteFile({ fileId, signal: exec?.signal })
        const cache = await state.loadCache()
        for (const [key, entry] of Object.entries(cache.files)) {
          if (entry?.fileId === fileId) delete cache.files[key]
        }
        await writeCache(cache)
        return { action, files: [], deleted: fileId, hasMore: false }
      }
      throw new Error('action must be "list" or "delete".')
    },
  }
}

/**
 * Mount both tools.
 * @param {object} ctx - plugin context.
 * @param {object} config - the bundle row's config.
 */
export function apply(ctx, config) {
  const state = createState(ctx, config)
  ctx.inject(['tools'], (scoped) => {
    scoped.tools.register(documentQaTool(state))
    scoped.tools.register(documentFilesTool(state))
  })
}
