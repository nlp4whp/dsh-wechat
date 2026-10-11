/**
 * Running `lark-cli` as a subprocess.
 *
 * Every Feishu call this channel makes goes through here, so lark-cli owns the app credentials, the
 * tenant token refresh, and the WebSocket long connection. The plugin never sees an app secret.
 *
 * Two lark-cli rules shape this module (both checked against lark-cli 1.0.69 `--help`):
 *
 * - **Local media paths must be relative to the working directory.** `--file` / `--image` /
 *   `--output` reject absolute paths and `..`. So a file is sent by spawning lark-cli *in the file's
 *   own directory* and passing `./<name>`, and a download runs inside the directory it writes to.
 * - **Every command prints a JSON envelope** `{ ok, data | error }` — on stdout when it succeeds and
 *   usually on stderr when it fails. Both streams are searched for it.
 *
 * @module @dsh-lark/core/cli
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { CliEnvelope, LarkConnection } from './types.ts'

/** Default ceiling for one ordinary call. Uploads of large files get more. */
export const DEFAULT_CLI_TIMEOUT_MS = 60_000

/** Ceiling for an upload or download, which scales with file size and network. */
export const TRANSFER_TIMEOUT_MS = 10 * 60_000

/** A lark-cli call that ran but reported failure, or could not run at all. */
export class LarkCliError extends Error {
  /** `error.type` from the envelope (`auth`, `validation`, `api`, …), or `spawn` / `timeout`. */
  readonly kind: string
  /** Process exit code, when the process ran. */
  readonly exitCode: number | undefined
  /** `error.hint` from the envelope, when lark-cli offered one. */
  readonly hint: string | undefined
  /** Scopes the app lacks, when the failure was `missing_scope`. */
  readonly missingScopes: string[] | undefined

  constructor(
    message: string,
    options: { kind: string; exitCode?: number; hint?: string; missingScopes?: string[] },
  ) {
    super(message)
    this.name = 'LarkCliError'
    this.kind = options.kind
    this.exitCode = options.exitCode
    this.hint = options.hint
    this.missingScopes = options.missingScopes
  }
}

/** Raw result of one process run. */
export interface CliRun {
  stdout: string
  stderr: string
  exitCode: number | null
}

/** Options for one call. */
export interface CliCallOptions {
  /** Working directory. Required for relative media paths. */
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * The argument prefix every call carries.
 *
 * `--profile` is a global flag, so it goes first and applies to whatever command follows.
 *
 * @param connection - Which profile to use.
 * @returns Arguments to put before the command.
 */
export function globalArgs(connection: LarkConnection): string[] {
  const profile = connection.profile?.trim()
  return profile ? ['--profile', profile] : []
}

/** The executable to spawn. */
export function cliExecutable(connection: LarkConnection): string {
  return connection.cliPath?.trim() || 'lark-cli'
}

/**
 * Spawn lark-cli once and collect its output.
 *
 * stdin is closed immediately: none of the one-shot commands read it, and an open pipe would only
 * keep a hung process alive. `shell: false` always, so a message body with quotes or `$` reaches
 * lark-cli exactly as written.
 *
 * @param connection - Executable and profile.
 * @param args - Command and flags, without the global prefix.
 * @param options - Working directory, timeout, cancellation.
 * @returns What the process printed and how it exited.
 * @throws {LarkCliError} When the process cannot start or times out.
 */
export async function runCli(
  connection: LarkConnection,
  args: readonly string[],
  options: CliCallOptions = {},
): Promise<CliRun> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS
  return await new Promise<CliRun>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cliExecutable(connection), [...globalArgs(connection), ...args], {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      })
    } catch (error) {
      reject(
        new LarkCliError(`无法启动 lark-cli：${error instanceof Error ? error.message : String(error)}`, {
          kind: 'spawn',
        }),
      )
      return
    }

    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const timer = setTimeout(() => {
      // SIGTERM, never SIGKILL: lark-cli cleans up server-side state on a graceful exit.
      child.kill('SIGTERM')
      finish(() =>
        reject(new LarkCliError(`lark-cli 超时（${String(timeoutMs)}ms）：${args.slice(0, 2).join(' ')}`, { kind: 'timeout' })),
      )
    }, timeoutMs)
    timer.unref?.()

    const onAbort = (): void => {
      child.kill('SIGTERM')
      finish(() => reject(new LarkCliError('已取消', { kind: 'aborted' })))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error: NodeJS.ErrnoException) => {
      const message =
        error.code === 'ENOENT'
          ? `找不到 lark-cli（${cliExecutable(connection)}）。请先安装：npm i -g @larksuite/cli，或在设置页填写完整路径。`
          : `无法启动 lark-cli：${error.message}`
      finish(() => reject(new LarkCliError(message, { kind: 'spawn' })))
    })
    child.on('close', (code) => {
      finish(() =>
        resolve({
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          exitCode: code,
        }),
      )
    })
  })
}

/**
 * Find the JSON envelope in a stream.
 *
 * lark-cli prints pretty-printed JSON, sometimes after a few `[event] …` diagnostic lines, so the
 * search starts at the first line that opens an object and parses from there to the end.
 *
 * @param text - stdout or stderr.
 * @returns The parsed envelope, or undefined when there is none.
 */
export function extractEnvelope<T = unknown>(text: string): CliEnvelope<T> | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const candidates: number[] = []
  if (trimmed.startsWith('{')) candidates.push(0)
  for (const match of trimmed.matchAll(/\n\{/g)) candidates.push((match.index ?? 0) + 1)
  for (const start of candidates) {
    try {
      const parsed = JSON.parse(trimmed.slice(start)) as unknown
      if (typeof parsed === 'object' && parsed !== null) return parsed as CliEnvelope<T>
    } catch {
      // Try the next opening brace.
    }
  }
  return undefined
}

/**
 * Run a command and return its `data`, throwing on any failure.
 *
 * @param connection - Executable and profile.
 * @param args - Command and flags.
 * @param options - Working directory, timeout, cancellation.
 * @returns The envelope's `data`.
 * @throws {LarkCliError} With lark-cli's own message and hint.
 */
export async function callCli<T = unknown>(
  connection: LarkConnection,
  args: readonly string[],
  options: CliCallOptions = {},
): Promise<T> {
  const run = await runCli(connection, args, options)
  const envelope = extractEnvelope<T>(run.stdout) ?? extractEnvelope<T>(run.stderr)
  if (envelope?.ok === true && run.exitCode === 0) return envelope.data as T
  const error = envelope?.error
  const detail =
    error?.message ??
    (run.stderr.trim().split('\n').slice(-3).join(' ') || `exit ${String(run.exitCode)}`)
  throw new LarkCliError(`lark-cli ${args.slice(0, 2).join(' ')} 失败：${detail}`, {
    kind: error?.type ?? 'exit',
    ...(run.exitCode === null ? {} : { exitCode: run.exitCode }),
    ...(error?.hint === undefined ? {} : { hint: error.hint }),
    ...(error?.missing_scopes === undefined ? {} : { missingScopes: error.missing_scopes }),
  })
}

/** Where a message goes: a chat (`oc_…`) or a user (`ou_…`). */
export type Recipient = { chatId: string } | { userId: string }

function recipientArgs(to: Recipient): string[] {
  return 'chatId' in to ? ['--chat-id', to.chatId] : ['--user-id', to.userId]
}

/** What a send returns. */
export interface SentMessage {
  messageId?: string
}

function readMessageId(data: unknown): SentMessage {
  const record = (data ?? {}) as { message_id?: unknown }
  return typeof record.message_id === 'string' ? { messageId: record.message_id } : {}
}

/**
 * Send a text reply.
 *
 * Markdown is the default because agent output is Markdown: lark-cli wraps it as a `post` with an
 * `md` element, so headings, lists and code render on the phone. Plain text is kept for content that
 * must not be interpreted.
 *
 * @param connection - Executable and profile.
 * @param params.to - Chat or user.
 * @param params.text - Body.
 * @param params.format - `markdown` (default) or `text`.
 * @param params.idempotencyKey - Optional dedup key, at most 50 characters.
 */
export async function sendText(
  connection: LarkConnection,
  params: { to: Recipient; text: string; format?: 'markdown' | 'text'; idempotencyKey?: string },
  options: CliCallOptions = {},
): Promise<SentMessage> {
  const format = params.format ?? 'markdown'
  const data = await callCli(
    connection,
    [
      'im',
      '+messages-send',
      '--as',
      'bot',
      ...recipientArgs(params.to),
      format === 'markdown' ? '--markdown' : '--text',
      params.text,
      ...(params.idempotencyKey === undefined
        ? []
        : ['--idempotency-key', params.idempotencyKey.slice(0, 50)]),
    ],
    options,
  )
  return readMessageId(data)
}

/** Extensions Feishu shows inline as a picture. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|heic|heif|ico|tiff?)$/i

/** How a local file will be sent. */
export function outboundKindOf(fileName: string): 'image' | 'file' {
  return IMAGE_EXTENSIONS.test(fileName) ? 'image' : 'file'
}

/**
 * Send a local file.
 *
 * lark-cli uploads and sends in one step, but only accepts a path inside its working directory, so
 * it is spawned in the file's directory with `./<name>`. Images go out as pictures; everything else,
 * video included, as a file attachment — a playable video needs a separate cover image, which an
 * arbitrary file does not have.
 *
 * @param connection - Executable and profile.
 * @param params.to - Chat or user.
 * @param params.path - Absolute path of the file.
 */
export async function sendFile(
  connection: LarkConnection,
  params: { to: Recipient; path: string },
  options: CliCallOptions = {},
): Promise<SentMessage & { kind: 'image' | 'file' }> {
  const name = basename(params.path)
  const kind = outboundKindOf(name)
  const data = await callCli(
    connection,
    ['im', '+messages-send', '--as', 'bot', ...recipientArgs(params.to), kind === 'image' ? '--image' : '--file', `./${name}`],
    { timeoutMs: TRANSFER_TIMEOUT_MS, ...options, cwd: dirname(params.path) },
  )
  return { ...readMessageId(data), kind }
}

/**
 * Add an emoji reaction to a message.
 *
 * Used as the "working on it" signal: Feishu has no typing indicator for bots.
 *
 * @param connection - Executable and profile.
 * @param messageId - `om_…`.
 * @param emojiType - One of Feishu's `emoji_type` values, such as `Typing` or `OnIt`.
 * @returns The reaction id, needed to remove it again.
 */
export async function addReaction(
  connection: LarkConnection,
  messageId: string,
  emojiType: string,
  options: CliCallOptions = {},
): Promise<string | undefined> {
  const data = await callCli<{ reaction_id?: unknown }>(
    connection,
    [
      'im',
      'reactions',
      'create',
      '--as',
      'bot',
      '--message-id',
      messageId,
      '--data',
      JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
    ],
    options,
  )
  return typeof data?.reaction_id === 'string' ? data.reaction_id : undefined
}

/** Remove a reaction this bot added. */
export async function deleteReaction(
  connection: LarkConnection,
  messageId: string,
  reactionId: string,
  options: CliCallOptions = {},
): Promise<void> {
  await callCli(
    connection,
    ['im', 'reactions', 'delete', '--as', 'bot', '--message-id', messageId, '--reaction-id', reactionId],
    options,
  )
}

/**
 * Download one resource of a message into a directory.
 *
 * No `--output` is passed, so lark-cli names the file from the server's `Content-Disposition` and
 * infers the extension — the only place the real file name and type are known. To find what it
 * wrote, the download runs in a fresh scratch directory, and the single file there is moved into
 * `dir` under a collision-proof name.
 *
 * @param connection - Executable and profile.
 * @param params.messageId - Message carrying the resource.
 * @param params.key - `img_…` or `file_…`.
 * @param params.type - `image` or `file`.
 * @param params.dir - Absolute directory to store into. Must exist.
 * @param params.prefix - Prepended to the stored name so repeated names never overwrite.
 * @returns Absolute path of the stored file.
 */
export async function downloadResource(
  connection: LarkConnection,
  params: { messageId: string; key: string; type: 'image' | 'file'; dir: string; prefix: string },
  options: CliCallOptions = {},
): Promise<string> {
  const scratch = await mkdtemp(join(params.dir, '.dl-'))
  try {
    await callCli(
      connection,
      [
        'im',
        '+messages-resources-download',
        '--as',
        'bot',
        '--message-id',
        params.messageId,
        '--file-key',
        params.key,
        '--type',
        params.type,
      ],
      { timeoutMs: TRANSFER_TIMEOUT_MS, ...options, cwd: scratch },
    )
    const written = (await readdir(scratch, { withFileTypes: true })).filter((entry) => entry.isFile())
    if (written.length === 0) throw new LarkCliError('下载成功但没有写出文件', { kind: 'download' })
    const original = written[0].name
    const safe = original.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(-100)
    const target = join(params.dir, `${params.prefix}-${safe}`)
    await rename(join(scratch, original), target)
    return target
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** One message as `+messages-mget` returns it, as far as this channel reads it. */
export interface FetchedMessage {
  messageId: string
  msgType?: string
  content?: string
  senderType?: string
}

/**
 * Read one message, for resolving what the user quoted.
 *
 * @param connection - Executable and profile.
 * @param messageId - `om_…`.
 * @returns The message, or undefined when it cannot be read.
 */
export async function fetchMessage(
  connection: LarkConnection,
  messageId: string,
  options: CliCallOptions = {},
): Promise<FetchedMessage | undefined> {
  const data = await callCli<{ messages?: unknown[] }>(
    connection,
    ['im', '+messages-mget', '--as', 'bot', '--no-reactions', '--message-ids', messageId],
    options,
  )
  const first = (data?.messages ?? [])[0] as
    | { message_id?: unknown; msg_type?: unknown; content?: unknown; sender?: { sender_type?: unknown } }
    | undefined
  if (first === undefined) return undefined
  return {
    messageId: typeof first.message_id === 'string' ? first.message_id : messageId,
    ...(typeof first.msg_type === 'string' ? { msgType: first.msg_type } : {}),
    ...(typeof first.content === 'string' ? { content: first.content } : {}),
    ...(typeof first.sender?.sender_type === 'string' ? { senderType: first.sender.sender_type } : {}),
  }
}

/** What `auth status` reports, as far as this channel needs it. */
export interface AuthStatus {
  appId?: string
  brand?: string
  botReady: boolean
  message?: string
}

/**
 * Check that lark-cli is installed and its bot identity is usable.
 *
 * `auth status` prints a bare JSON object rather than the `{ ok, data }` envelope, so it is parsed
 * directly.
 *
 * @param connection - Executable and profile.
 * @returns App id and whether the bot identity is ready.
 * @throws {LarkCliError} When lark-cli cannot run or prints nothing readable.
 */
export async function authStatus(
  connection: LarkConnection,
  options: CliCallOptions = {},
): Promise<AuthStatus> {
  const run = await runCli(connection, ['auth', 'status'], { timeoutMs: 20_000, ...options })
  const parsed = extractEnvelope(run.stdout) ?? extractEnvelope(run.stderr)
  const record = (parsed ?? {}) as {
    appId?: unknown
    brand?: unknown
    identities?: { bot?: { available?: unknown; status?: unknown; message?: unknown } }
    error?: { message?: unknown }
  }
  if (parsed === undefined) {
    throw new LarkCliError(
      `lark-cli auth status 没有输出可读结果：${(run.stderr || run.stdout).trim().slice(0, 300)}`,
      { kind: 'exit', ...(run.exitCode === null ? {} : { exitCode: run.exitCode }) },
    )
  }
  const bot = record.identities?.bot
  const message =
    typeof bot?.message === 'string'
      ? bot.message
      : typeof record.error?.message === 'string'
        ? record.error.message
        : undefined
  return {
    ...(typeof record.appId === 'string' ? { appId: record.appId } : {}),
    ...(typeof record.brand === 'string' ? { brand: record.brand } : {}),
    botReady: bot?.available === true || bot?.status === 'ready',
    ...(message === undefined ? {} : { message }),
  }
}
