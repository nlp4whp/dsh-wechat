/**
 * Inbound side: a long-running `lark-cli event consume im.message.receive_v1` and the parsing of
 * what it prints.
 *
 * This is the piece that crosses the LAN boundary. lark-cli keeps one outbound WebSocket to the
 * Feishu open platform (its "long connection" mode, `oapi-sdk-go/v3/ws`), so the machine running DSH
 * needs no public address. The subprocess contract, from the lark-event skill and `--help`:
 *
 * - stdout is NDJSON, one event per line;
 * - stderr prints `[event] ready event_key=…` once the subscription is live;
 * - closing stdin is a graceful shutdown for an unbounded run, so stdin is kept as an open pipe for
 *   the life of the process and closed on purpose to stop it;
 * - never SIGKILL: keys with server-side subscriptions leak them. SIGTERM only, as a fallback.
 *
 * @module @dsh-lark/core/channel
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

import { cliExecutable, extractEnvelope, globalArgs } from './cli.ts'
import type { LarkConnection, LarkMessageEvent, ResourceRef } from './types.ts'

/** The event this channel consumes. */
export const MESSAGE_EVENT_KEY = 'im.message.receive_v1'

/** Line lark-cli prints on stderr once the subscription is live. */
const READY_MARKER = '[event] ready'

/** How long a graceful stop may take before SIGTERM. */
const STOP_GRACE_MS = 5_000

/** Restart delays after an unexpected exit, growing to the last value. */
const RESTART_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000]

/** A connection that stayed ready this long counts as healthy, and resets the backoff. */
const STABLE_AFTER_MS = 60_000

/** How many message ids to remember for de-duplication. */
const SEEN_LIMIT = 500

/** A message ready for the router. */
export interface InboundMessage {
  /** App id the message arrived on; the account key in state. */
  accountId: string
  /** Sender open_id (`ou_…`). */
  peerId: string
  /** Chat the reply goes to (`oc_…`). */
  chatId: string
  chatType: string
  /** Stable conversation key: one per chat. */
  conversationId: string
  messageId: string
  messageType: string
  /** Readable text with resource placeholders removed. */
  text: string
  /** Resources to download, in content order. */
  resources: ResourceRef[]
  /** Parent message, when the user replied to one. */
  replyTo?: string
  raw: LarkMessageEvent
  receivedAt: number
}

/** Why the stream stopped. */
export type StreamStopReason = 'stopped' | 'fatal'

export interface StreamOptions {
  connection: LarkConnection
  /** Account key stamped on every message, usually the app id. */
  accountId: string
  /** Called once per new message, sequentially. */
  onMessage: (message: InboundMessage) => Promise<void>
  /** Called when the subscription becomes live, after every (re)start. */
  onReady?: () => void
  /** Every stderr line, for the log. */
  onLog?: (line: string) => void
  onError?: (error: Error) => void
  /**
   * Called when the stream gives up for good: an auth or validation failure that a restart cannot
   * fix (exit codes 2 and 3).
   */
  onFatal?: (reason: string) => void
  /** Spawn seam for tests. */
  spawnProcess?: (command: string, args: string[]) => ChildProcess
  /** Sleep seam for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * One supervised `event consume` process.
 *
 * `start()` returns at once; the stream restarts itself after crashes and network failures, and
 * stops for good on `stop()` or on a failure a restart cannot fix.
 */
export class EventStream {
  readonly #options: StreamOptions
  #child: ChildProcess | undefined
  #abort: AbortController | undefined
  #ready = false
  #failures = 0
  readonly #seen: string[] = []
  readonly #seenSet = new Set<string>()
  /** Inbound handling is serialised, so a reply to message 1 never races message 2. */
  #queue: Promise<void> = Promise.resolve()
  #lastError: string | undefined

  constructor(options: StreamOptions) {
    this.#options = options
  }

  /** True while the subscription is live. */
  get ready(): boolean {
    return this.#ready
  }

  /** True between start() and stop(). */
  get running(): boolean {
    return this.#abort !== undefined && !this.#abort.signal.aborted
  }

  /** Last failure text, for the settings page. */
  get lastError(): string | undefined {
    return this.#lastError
  }

  /** Begin consuming. Safe to call while running. */
  start(): void {
    if (this.running) return
    const abort = new AbortController()
    this.#abort = abort
    void this.#supervise(abort.signal)
  }

  /** Stop gracefully: close stdin, then SIGTERM after a grace period. */
  async stop(): Promise<void> {
    this.#abort?.abort()
    this.#abort = undefined
    await this.#terminate()
  }

  async #supervise(signal: AbortSignal): Promise<void> {
    const sleep = this.#options.sleep ?? defaultSleep
    while (!signal.aborted) {
      const outcome = await this.#runOnce(signal)
      this.#ready = false
      if (signal.aborted) return
      if (outcome.fatal) {
        this.#lastError = outcome.reason
        this.#options.onFatal?.(outcome.reason)
        this.#abort = undefined
        return
      }
      this.#failures += 1
      this.#lastError = outcome.reason
      this.#options.onError?.(new Error(`事件流退出，将重启：${outcome.reason}`))
      const delay = RESTART_DELAYS_MS[Math.min(this.#failures - 1, RESTART_DELAYS_MS.length - 1)]
      await sleep(delay, signal)
    }
  }

  /** Run one process to its end. */
  async #runOnce(signal: AbortSignal): Promise<{ fatal: boolean; reason: string }> {
    const { connection } = this.#options
    const args = [...globalArgs(connection), 'event', 'consume', MESSAGE_EVENT_KEY, '--as', 'bot']
    let child: ChildProcess
    try {
      child = this.#options.spawnProcess
        ? this.#options.spawnProcess(cliExecutable(connection), args)
        : spawn(cliExecutable(connection), args, {
            // stdin stays an open pipe: EOF on stdin is lark-cli's shutdown signal.
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
          })
    } catch (error) {
      return { fatal: false, reason: error instanceof Error ? error.message : String(error) }
    }
    this.#child = child

    const stderrTail: string[] = []
    let readyAt: number | undefined
    return await new Promise((resolve) => {
      let spawnError: NodeJS.ErrnoException | undefined

      if (child.stdout) {
        const lines = createInterface({ input: child.stdout })
        lines.on('line', (line) => this.#onLine(line))
      }
      if (child.stderr) {
        const lines = createInterface({ input: child.stderr })
        lines.on('line', (line) => {
          stderrTail.push(line)
          if (stderrTail.length > 60) stderrTail.shift()
          this.#options.onLog?.(line)
          if (!this.#ready && line.includes(READY_MARKER)) {
            this.#ready = true
            readyAt = Date.now()
            this.#lastError = undefined
            this.#options.onReady?.()
          }
        })
      }
      child.on('error', (error: NodeJS.ErrnoException) => {
        spawnError = error
      })
      child.on('close', (code) => {
        if (this.#child === child) this.#child = undefined
        // Backoff resets only after a connection that actually held. One that comes up and drops at
        // once would otherwise be restarted at the shortest delay forever.
        if (readyAt !== undefined && Date.now() - readyAt >= STABLE_AFTER_MS) this.#failures = 0
        if (signal.aborted) {
          resolve({ fatal: false, reason: 'stopped' })
          return
        }
        if (spawnError !== undefined) {
          const reason =
            spawnError.code === 'ENOENT'
              ? `找不到 lark-cli（${cliExecutable(connection)}）。请先安装：npm i -g @larksuite/cli`
              : spawnError.message
          // A missing executable will not appear by itself; stop retrying.
          resolve({ fatal: spawnError.code === 'ENOENT', reason })
          return
        }
        const envelope = extractEnvelope(stderrTail.join('\n'))
        const message =
          envelope?.error?.message ??
          stderrTail.filter((line) => line.trim() !== '').slice(-2).join(' ') ??
          ''
        const hint = envelope?.error?.hint === undefined ? '' : `（${envelope.error.hint}）`
        // 2 = validation (bad key, another bus connected), 3 = auth / missing scope. Neither is
        // fixed by restarting the same command.
        const fatal = code === 2 || code === 3
        resolve({ fatal, reason: `exit ${String(code)}: ${message}${hint}`.trim() })
      })
    })
  }

  /** Parse and dispatch one stdout line. */
  #onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return
    let event: LarkMessageEvent
    try {
      event = JSON.parse(trimmed) as LarkMessageEvent
    } catch {
      this.#options.onError?.(new Error(`无法解析事件：${trimmed.slice(0, 200)}`))
      return
    }
    const message = toInbound(this.#options.accountId, event)
    if (message === undefined) return
    // A reconnect can redeliver; message_id is the documented idempotency key.
    if (this.#seenSet.has(message.messageId)) return
    this.#remember(message.messageId)
    this.#queue = this.#queue.then(async () => {
      try {
        await this.#options.onMessage(message)
      } catch (error) {
        this.#options.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  #remember(id: string): void {
    this.#seen.push(id)
    this.#seenSet.add(id)
    while (this.#seen.length > SEEN_LIMIT) {
      const old = this.#seen.shift()
      if (old !== undefined) this.#seenSet.delete(old)
    }
  }

  async #terminate(): Promise<void> {
    const child = this.#child
    if (child === undefined || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        resolve()
      }, STOP_GRACE_MS)
      timer.unref?.()
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      // Graceful path: EOF on stdin.
      child.stdin?.end()
    })
  }
}

/**
 * Turn one event into an inbound message, or drop it.
 *
 * Dropped: anything a bot sent (including this one — it would loop), events without a sender, chat,
 * or id, and messages with neither text nor a resource.
 *
 * @param accountId - Account key to stamp.
 * @param event - Parsed stdout line.
 */
export function toInbound(accountId: string, event: LarkMessageEvent): InboundMessage | undefined {
  if (event.sender_type !== undefined && event.sender_type !== 'user') return undefined
  const peerId = event.sender_id?.trim()
  const chatId = event.chat_id?.trim()
  const messageId = (event.message_id ?? '').trim()
  if (!peerId || !chatId || messageId === '') return undefined

  const messageType = event.message_type ?? 'text'
  const parsed = parseContent(messageType, event.content ?? '', event.mentions)
  if (parsed.text === '' && parsed.resources.length === 0) return undefined

  return {
    accountId,
    peerId,
    chatId,
    chatType: event.chat_type ?? 'p2p',
    conversationId: conversationKey(accountId, chatId),
    messageId,
    messageType,
    text: parsed.text,
    resources: parsed.resources,
    ...(event.reply_to ? { replyTo: event.reply_to } : {}),
    raw: event,
    receivedAt: Date.now(),
  }
}

/** One conversation per chat, stable across restarts. */
export function conversationKey(accountId: string, chatId: string): string {
  return `${accountId}:${chatId}`
}

/**
 * The chat a conversation key names, so a reply can be addressed from a stored binding alone.
 *
 * @param conversationId - Key built by {@link conversationKey}.
 * @returns The `oc_…` chat id, or undefined for a key of another shape.
 */
export function chatOfConversation(conversationId: string): string | undefined {
  const chatId = conversationId.slice(conversationId.lastIndexOf(':') + 1)
  return chatId.startsWith('oc_') ? chatId : undefined
}

/**
 * Split pre-rendered content into readable text and the resources it references.
 *
 * lark-cli renders resources as placeholders (seen in its embedded docs and binary):
 *   `![Image](img_xxx)`, `<file key="file_xxx" name="a.pdf"/>`,
 *   `<audio key="file_xxx" duration="3s"/>`, `<video key="file_xxx" name="v.mp4"/>`.
 * Attributes are read by name, not position, so an extra attribute or another order still parses.
 * Mention placeholders (`@_user_1`) are replaced with the display name lark-cli supplied; a group
 * message's leading `@bot` is stripped so a command such as `/list` is still recognised.
 *
 * @param messageType - `message_type` from the event.
 * @param content - Pre-rendered content.
 * @param mentions - Mention table from the event.
 */
export function parseContent(
  messageType: string,
  content: string,
  mentions: LarkMessageEvent['mentions'] = [],
): { text: string; resources: ResourceRef[] } {
  if (messageType === 'interactive') {
    // A card the user forwarded: raw JSON, not something to execute. Hand it over as text.
    return { text: content.trim() === '' ? '' : `[卡片消息]\n${content.trim()}`, resources: [] }
  }

  const resources: ResourceRef[] = []
  let text = content

  text = text.replace(/!\[[^\]]*\]\((img_[^)\s]+)\)/g, (_match, key: string) => {
    resources.push({ key, type: 'image', kind: 'image' })
    return ''
  })

  text = text.replace(/<(file|audio|video|media)\b([^>]*?)\/?>/g, (match, tag: string, attrs: string) => {
    const read = (name: string): string | undefined => {
      const found = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
      return found?.[1]
    }
    const key = read('key') ?? read('file_key')
    if (key === undefined || key === '') return match
    const kind = tag === 'audio' ? 'audio' : tag === 'file' ? 'file' : 'video'
    const name = read('name') ?? read('file_name')
    const duration = read('duration')
    resources.push({
      key,
      type: 'file',
      kind,
      ...(name === undefined ? {} : { name }),
      ...(duration === undefined ? {} : { duration }),
    })
    return ''
  })

  // Bare keys for message types whose rendering this parser has not seen, as a last resort.
  if (resources.length === 0 && (messageType === 'image' || messageType === 'file' || messageType === 'audio' || messageType === 'media')) {
    const bare = /\b((?:img|file)_[A-Za-z0-9_-]{6,})\b/.exec(content)
    if (bare !== null) {
      const key = bare[1]
      const isImage = key.startsWith('img_')
      resources.push({
        key,
        type: isImage ? 'image' : 'file',
        kind: isImage ? 'image' : messageType === 'audio' ? 'audio' : messageType === 'media' ? 'video' : 'file',
      })
      text = text.replace(key, '')
    }
  }

  for (const mention of mentions ?? []) {
    if (mention.key === undefined || mention.key === '') continue
    text = text.split(mention.key).join(mention.name ? `@${mention.name}` : '')
  }

  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, resources }
}

/**
 * Remove a leading mention of the bot, so `@bot /list` in a group reads as `/list`.
 *
 * @param text - Parsed text.
 * @param botNames - Names the bot may be mentioned by.
 */
export function stripLeadingMention(text: string, botNames: readonly string[]): string {
  let out = text.trimStart()
  for (;;) {
    const name = botNames.find((candidate) => candidate !== '' && out.startsWith(`@${candidate}`))
    if (name === undefined) return out
    out = out.slice(name.length + 1).trimStart()
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
