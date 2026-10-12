/**
 * Host half of the Feishu/Lark channel.
 *
 * It owns one supervised `lark-cli event consume` stream, routes inbound messages into DSH sessions,
 * and forwards assistant output back to the chat. All Feishu work lives in `@dsh-lark/core`; this
 * file is the glue to the DSH host, and most of it is carried over unchanged from the WeChat build
 * (session routing, reply buffering, permission prompts, the tools).
 *
 * @module dsh-lark-plugin/host
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import {
  EventStream,
  LarkCliError,
  SessionRouter,
  StateStore,
  addReaction,
  authStatus,
  chatOfConversation,
  deleteReaction,
  downloadResource,
  fetchMessage,
  isAllowed,
  isSameWorkspace,
  listAllStoredSessions,
  normalizeSettings,
  renderSessionRow,
  resolveSettings,
  sendFile,
  sendText,
  storedSessionWorkspace,
  stripLeadingMention,
  type AuthStatus,
  type BindingStore,
  type ChannelSettings,
  type ChannelState,
  type FetchedMessage,
  type InboundMessage,
  type LarkConnection,
  type Recipient,
  type ResourceRef,
  type RouteDecision,
  type SessionBinding,
  type SessionGateway,
  type StreamOptions,
} from '@dsh-lark/core'

import {
  ROUTE_CHECK,
  ROUTE_CLIENT_ERROR,
  ROUTE_CONNECTION,
  ROUTE_SETTINGS,
  ROUTE_STATUS,
  ROUTE_TOGGLE,
  type ChannelStatus,
} from './routes.ts'
import {
  parseApprovalReply,
  parseQuestionReply,
  presentApproval,
  presentQuestions,
  type ApprovalOutcome,
  type QuestionAnswerBatch,
  type QuestionItem,
} from './interactions.ts'
import {
  readStreamFrame,
  type AssistantStreamPayload,
  type Disposer,
  type LarkContext,
  type ToolDefinition,
} from './services.ts'

/** Cordis plugin name. Must match the patch row id and the client module id. */
export const name = 'dsh-lark-plugin'

/** Host services this plugin reads. A missing one keeps the plugin pending. */
export const inject = ['sessionController', 'sessions', 'workspaceRegistry', 'tools']

/**
 * Directory for this channel's sessions, under the DSH home.
 *
 * Constant on purpose: the host compares `cwd` on every adopt and refuses a mismatch, so a session
 * created here can only ever be re-attached from here.
 */
const WORKSPACE_DIR_NAME = 'dsh_lark'

/** Folder name the channel's sessions appear under on the desktop. */
const WORKSPACE_TITLE = '飞书会话'

/** Where inbound attachments and long replies are written, inside the workspace. */
const MEDIA_DIR_NAME = '媒体'

/** Directory under the DSH home for the state file and the boot log. */
const STATE_DIR_NAME = 'lark'

const BOOT_LOG_NAME = 'boot.log'

/** How long a "working" reaction may stay before it is removed regardless. */
const WORKING_MAX_MS = 30 * 60 * 1000

/** How often a stranger is told their open_id, at most. */
const REJECT_NOTICE_INTERVAL_MS = 10 * 60 * 1000

/** How much of a quoted message is handed to the agent. */
const QUOTE_LIMIT = 1_500

/**
 * The session tool's description, which carries the confirmation policy.
 *
 * @param requireConfirmation - Whether the user wants actions confirmed first.
 */
export function sessionToolDescription(requireConfirmation: boolean): string {
  const base =
    'Manage which DSH conversation (session) this Feishu chat is talking to. Call this whenever the ' +
    'user asks to see their conversations, switch between them, start a new one, find out which ' +
    'one is in use, or stop what is running — in any wording. Do not merely describe these ' +
    'actions in a reply; call the tool. The user is on Feishu, probably on a phone, and cannot see ' +
    'the desktop session list. ' +
    'Switching, creating and listing are announced to the user by the channel itself — including ' +
    'failures — so do not repeat that outcome. Read the result\'s `ok` field; never claim success ' +
    'when it is false. ' +
    'The list shows this channel\'s own conversations by default and reports how many others exist ' +
    'in other workspaces; when the user asks to see those as well, call list with target "all".'
  if (requireConfirmation) {
    return (
      `${base} IMPORTANT: before acting, state what you are about to do and wait for the user to ` +
      'agree; only then call this tool. Action "list" changes nothing and may be called straight away.'
    )
  }
  return `${base} The user has turned confirmation off, so act on the request directly.`
}

function switchConfirmation(action: string, resolvedTitle: string): string {
  const title = resolvedTitle.trim()
  if (action === 'new') {
    return title === '' ? '已新建对话，从现在起你的消息发到这里。' : `已新建对话「${title}」，从现在起你的消息发到这里。`
  }
  return title === '' ? '已切换对话。' : `已切换到「${title}」。`
}

function switchFailure(action: string, target: string | undefined, reason: string): string {
  const headline = reason.split('\n')[0]?.trim() ?? ''
  const what =
    action === 'switch' ? (target === undefined || target === '' ? '切换对话' : `切换到「${target}」`) : '新建对话'
  return `${what}没有成功。${headline}\n\n发「/list」看清单，直接回数字也能切。`
}

function renderTable(
  sessions: readonly { sessionId: string; title: string; updatedAt: number; current: boolean }[],
  currentId: string | undefined,
): string {
  return sessions.map((row, index) => renderSessionRow(row, index, currentId)).join('\n\n')
}

function workspaceLabel(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  return parts.at(-1) ?? path
}

/** Read a session id off a host-owned agent object. */
function sessionIdOf(agent: unknown): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const candidate = (agent as { session?: { id?: unknown } }).session?.id
  return typeof candidate === 'string' ? candidate : undefined
}

/** Truncate, saying so. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n…（已截断，完整内容见桌面端）`
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const hint = error instanceof LarkCliError && error.hint !== undefined ? `（${error.hint}）` : ''
  const cause = error.cause === undefined ? '' : ` <- cause: ${describeError(error.cause)}`
  return `${error.message}${hint}${cause}`
}

/** One downloaded attachment. */
interface StoredAttachment {
  resource: ResourceRef
  path: string
  size: number
}

/** One line describing an attachment for the agent, including where it landed. */
function describeAttachment(entry: StoredAttachment): string {
  const readable = entry.size < 1024 ? `${entry.size} B` : `${(entry.size / 1024).toFixed(1)} KB`
  const label = { image: '图片', file: '文件', audio: '语音', video: '视频' }[entry.resource.kind]
  const parts = [`[${label}] ${entry.path} (${readable})`]
  if (entry.resource.name !== undefined) parts.push(`原文件名：${entry.resource.name}`)
  if (entry.resource.duration !== undefined) parts.push(`时长：${entry.resource.duration}`)
  if (entry.resource.kind === 'audio') parts.push('（飞书语音，通常是 Opus 编码）')
  return parts.join('\n')
}

/** Non-text messages awaiting an instruction, batched per conversation. */
interface PendingBatch {
  attachments: StoredAttachment[]
  text: string
  timer: NodeJS.Timeout | undefined
}

/** One permission prompt or question waiting for the user's reply. */
interface PendingInteraction {
  kind: 'approval' | 'question'
  accept: (reply: string) => unknown | undefined
  settle: (value: never) => void
  reprompt: () => void
}

/**
 * Everything the runtime does on Feishu, behind one seam.
 *
 * The default goes through lark-cli; tests substitute a recorder so the whole pipeline runs without
 * spawning anything.
 */
export interface LarkTransport {
  sendText(to: Recipient, text: string, format: 'markdown' | 'text'): Promise<{ messageId?: string }>
  sendFile(to: Recipient, path: string): Promise<{ messageId?: string; kind: 'image' | 'file' }>
  addReaction(messageId: string, emojiType: string): Promise<string | undefined>
  deleteReaction(messageId: string, reactionId: string): Promise<void>
  download(params: { messageId: string; key: string; type: 'image' | 'file'; dir: string; prefix: string }): Promise<string>
  fetchMessage(messageId: string): Promise<FetchedMessage | undefined>
  authStatus(): Promise<AuthStatus>
}

/** The parts of the event stream the runtime uses. */
export interface StreamHandle {
  start(): void
  stop(): Promise<void>
  readonly ready: boolean
  readonly running: boolean
  readonly lastError: string | undefined
}

/** Test seams. The loader never sets these. */
export interface Internals {
  transport?: LarkTransport
  createStream?: (options: StreamOptions) => StreamHandle
}

/** A transport that runs lark-cli with whatever connection the state currently holds. */
function cliTransport(connection: () => LarkConnection): LarkTransport {
  return {
    sendText: async (to, text, format) => await sendText(connection(), { to, text, format }),
    sendFile: async (to, path) => await sendFile(connection(), { to, path }),
    addReaction: async (messageId, emoji) => await addReaction(connection(), messageId, emoji),
    deleteReaction: async (messageId, reactionId) => await deleteReaction(connection(), messageId, reactionId),
    download: async (params) => await downloadResource(connection(), params),
    fetchMessage: async (messageId) => await fetchMessage(connection(), messageId),
    authStatus: async () => await authStatus(connection()),
  }
}

interface RuntimeOptions {
  home: string
  stateFile: string
  workspace: string
  internals?: Internals
}

/** A resolved place to send to. */
interface Target {
  conversationId: string
  chatId: string
  peerId: string
}

/**
 * The whole channel at runtime: the stream, routing, the outbound buffer, and the interactions.
 */
class LarkRuntime {
  readonly #ctx: LarkContext
  readonly #store: StateStore
  readonly #stateFilePath: string
  readonly #router: SessionRouter
  readonly #workspace: string
  readonly #home: string
  readonly #transport: LarkTransport
  readonly #createStream: (options: StreamOptions) => StreamHandle
  /** Connection as last read from state, for the synchronous transport getter. */
  #connection: LarkConnection = {}
  #stream: StreamHandle | undefined
  #auth: AuthStatus | undefined
  #authError: string | undefined
  readonly #replies = new Map<string, { text: string; conversationId: string; timer: NodeJS.Timeout | undefined }>()
  readonly #errors: string[] = []
  readonly #pending = new Map<string, PendingBatch>()
  readonly #interactions = new Map<string, PendingInteraction>()
  /** "Working" reactions, per conversation. */
  readonly #working = new Map<string, { messageId: string; reaction: Promise<string | undefined>; cap: NodeJS.Timeout }>()
  /** Strangers who messaged the bot, newest last, and when each was last told why not. */
  readonly #rejected = new Map<string, number>()
  #settingsCache: Required<ChannelSettings> | undefined
  #workspaceId: string | undefined
  #sessionToolDisposer: Disposer | undefined

  constructor(ctx: LarkContext, options: RuntimeOptions) {
    this.#ctx = ctx
    this.#workspace = options.workspace
    this.#home = options.home
    this.#store = new StateStore(options.stateFile)
    this.#stateFilePath = options.stateFile
    this.#transport = options.internals?.transport ?? cliTransport(() => this.#connection)
    this.#createStream = options.internals?.createStream ?? ((streamOptions) => new EventStream(streamOptions))
    const bindings: BindingStore = {
      load: async () => (await this.#store.read()).bindings,
      save: async (next: Record<string, SessionBinding>) => {
        await this.#store.update((state) => {
          state.bindings = next
        })
      },
    }
    this.#router = new SessionRouter({ gateway: this.#gateway(), store: bindings, titlePrefix: '飞书' })
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async enabled(): Promise<boolean> {
    return (await this.#store.read()).autoStart === true
  }

  /** Check lark-cli and start the stream. Safe to call repeatedly. */
  async start(): Promise<void> {
    const state = await this.#store.read()
    this.#connection = { ...state.connection }
    if (this.#stream?.running === true) return

    await this.checkConnection()
    const accountId = (await this.#store.read()).connection.appId ?? 'lark'
    const stream = this.#createStream({
      connection: this.#connection,
      accountId,
      onMessage: async (message) => {
        await this.#handleInbound(message)
      },
      onReady: () => this.#recordBoot('stream: ready'),
      onLog: (line) => {
        // Diagnostic lines only; the ready marker and exit summary are the useful ones.
        if (line.startsWith('[event]') || line.includes('"ok": false')) this.#recordBoot(`stream: ${line}`)
      },
      onError: (error) => this.#recordError(error.message),
      onFatal: (reason) => this.#recordError(`事件流已停止，需要处理后重新启用：${reason}`),
    })
    this.#stream = stream
    stream.start()
    this.#recordBoot(`stream: starting (account=${accountId}, profile=${this.#connection.profile ?? '(默认)'})`)
  }

  async stop(): Promise<void> {
    const stream = this.#stream
    this.#stream = undefined
    await stream?.stop()
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.#store.update((state) => {
      state.autoStart = enabled
    })
    if (enabled) await this.start()
    else await this.stop()
  }

  /** Tear everything down for plugin disposal. */
  async halt(): Promise<void> {
    for (const entry of this.#replies.values()) clearTimeout(entry.timer)
    this.#replies.clear()
    for (const parked of this.#pending.values()) clearTimeout(parked.timer)
    this.#pending.clear()
    for (const conversationId of [...this.#working.keys()]) this.#stopWorking(conversationId)
    await this.stop()
  }

  /** Run `auth status` and record the app id. Never throws. */
  async checkConnection(): Promise<void> {
    try {
      const auth = await this.#transport.authStatus()
      this.#auth = auth
      this.#authError = undefined
      if (auth.appId !== undefined) {
        await this.#store.update((state) => {
          state.connection.appId = auth.appId
        })
      }
      if (!auth.botReady) this.#recordError(`lark-cli 的 bot 身份不可用：${auth.message ?? '未知原因'}`)
    } catch (error) {
      this.#auth = undefined
      this.#authError = describeError(error)
      this.#recordError(this.#authError)
    }
  }

  /** Save the lark-cli connection and restart the stream if it was running. */
  async saveConnection(patch: { cliPath?: string; profile?: string }): Promise<void> {
    const wasRunning = this.#stream?.running === true
    await this.#store.update((state) => {
      if (patch.cliPath !== undefined) {
        if (patch.cliPath.trim() === '') delete state.connection.cliPath
        else state.connection.cliPath = patch.cliPath.trim()
      }
      if (patch.profile !== undefined) {
        if (patch.profile.trim() === '') delete state.connection.profile
        else state.connection.profile = patch.profile.trim()
      }
      // A different profile may be a different app.
      delete state.connection.appId
    })
    this.#connection = { ...(await this.#store.read()).connection }
    if (wasRunning) {
      await this.stop()
      await this.start()
    } else {
      await this.checkConnection()
    }
  }

  async status(): Promise<ChannelStatus> {
    const state = await this.#store.read()
    return {
      enabled: state.autoStart === true,
      connection: {
        cliPath: state.connection.cliPath ?? '',
        profile: state.connection.profile ?? '',
        ...(state.connection.appId === undefined ? {} : { appId: state.connection.appId }),
        ...(this.#auth?.brand === undefined ? {} : { brand: this.#auth.brand }),
        ...(this.#auth === undefined ? {} : { botReady: this.#auth.botReady }),
        ...(this.#authError !== undefined
          ? { checkMessage: this.#authError }
          : this.#auth?.message === undefined
            ? {}
            : { checkMessage: this.#auth.message }),
      },
      stream: {
        running: this.#stream?.running === true,
        ready: this.#stream?.ready === true,
        ...(this.#stream?.lastError === undefined ? {} : { lastError: this.#stream.lastError }),
      },
      rejectedSenders: [...this.#rejected.keys()].slice(-10),
      errors: [...this.#errors].slice(-10),
      diagnostics: {
        logPath: join(this.#home, STATE_DIR_NAME, BOOT_LOG_NAME),
        statePath: this.#store.file,
        workspace: this.#workspace,
        logTail: this.#bootLogTail(),
      },
    }
  }

  #bootLogTail(limit = 200): string[] {
    try {
      const text = readFileSync(join(this.#home, STATE_DIR_NAME, BOOT_LOG_NAME), 'utf8')
      return text.split(/\r?\n/).filter((line) => line !== '').slice(-limit)
    } catch {
      return []
    }
  }

  async bindings(): Promise<SessionBinding[]> {
    return Object.values((await this.#store.read()).bindings)
  }

  /** Feed one message through the real pipeline. For tests. */
  async ingest(message: InboundMessage): Promise<void> {
    await this.#handleInbound(message)
  }

  // ───────────────────────────── settings ─────────────────────────────

  async #settings(): Promise<Required<ChannelSettings>> {
    this.#settingsCache ??= resolveSettings(await this.#store.read())
    return this.#settingsCache
  }

  #settingsNow(): Required<ChannelSettings> {
    return this.#settingsCache ?? this.#settingsFromDisk()
  }

  /** Synchronous read, for tool registration during `apply`. */
  #settingsFromDisk(): Required<ChannelSettings> {
    if (this.#settingsCache !== undefined) return this.#settingsCache
    let settings: ChannelSettings | undefined
    try {
      const parsed = JSON.parse(readFileSync(this.#stateFilePath, 'utf-8')) as { settings?: Record<string, unknown> }
      settings = parsed.settings === undefined ? undefined : normalizeSettings(parsed.settings)
    } catch {
      settings = undefined
    }
    this.#settingsCache = resolveSettings({ settings: settings ?? {} })
    return this.#settingsCache
  }

  async settingsForPage(): Promise<{ settings: Required<ChannelSettings>; defaults: Required<ChannelSettings> }> {
    return { settings: await this.#settings(), defaults: resolveSettings({}) }
  }

  async saveSettings(patch: ChannelSettings): Promise<Required<ChannelSettings>> {
    const before = this.#settingsNow().requireConfirmation
    let next = this.#settingsNow()
    await this.#store.update((state) => {
      state.settings = { ...(state.settings ?? {}), ...patch }
      next = resolveSettings(state)
    })
    this.#settingsCache = next
    if (next.requireConfirmation !== before) this.refreshSessionTool()
    return next
  }

  // ───────────────────────────── inbound ─────────────────────────────

  async #handleInbound(message: InboundMessage): Promise<void> {
    const settings = await this.#settings()

    if (message.chatType !== 'p2p' && !settings.allowGroups) {
      this.#recordBoot(`ignored group message from ${message.peerId} in ${message.chatId} (群聊未开启)`)
      return
    }

    /*
     * The allowlist is the security boundary. Feishu delivers messages from anyone in the app's
     * availability scope, and the agent acts with this user's permissions, so a sender who is not
     * listed never reaches a session. In a direct chat they are told their own open_id — which is
     * also how the owner finds the id to add on first use.
     */
    if (!isAllowed(settings, message.peerId)) {
      const last = this.#rejected.get(message.peerId)
      this.#rejected.delete(message.peerId)
      this.#rejected.set(message.peerId, last ?? 0)
      this.#recordBoot(`rejected sender ${message.peerId} (不在白名单)`)
      if (message.chatType === 'p2p' && (last === undefined || Date.now() - last > REJECT_NOTICE_INTERVAL_MS)) {
        this.#rejected.set(message.peerId, Date.now())
        await this.#sendText(
          { conversationId: message.conversationId, chatId: message.chatId, peerId: message.peerId },
          `这台电脑上的 DSH 没有授权你使用。\n\n你的 open_id 是：${message.peerId}\n\n如果你是机器主人，把它加入 DSH「设置 → 飞书 → 允许的用户」即可。`,
          'text',
        ).catch((error: unknown) => this.#recordError(`拒绝通知发送失败: ${describeError(error)}`))
      }
      return
    }

    // In a group the bot is usually @-mentioned first; `@bot /list` must still read as `/list`.
    if (message.chatType !== 'p2p') {
      const names = (message.raw.mentions ?? []).map((mention) => mention.name ?? '').filter((n) => n !== '')
      message = { ...message, text: stripLeadingMention(message.text, names) }
    }

    this.#startWorking(message.conversationId, message.messageId)
    let handedOff = false
    try {
      const attachments = await this.#fetchAttachments(message)

      if (attachments.length === 0 && this.#settleInteraction(message)) return

      if (attachments.length > 0) {
        this.#parkAttachments(message, attachments, settings)
        return
      }

      handedOff = await this.#deliver(message, message.text, [])
    } catch (error) {
      this.#recordError(`处理消息失败: ${describeError(error)}`)
      await this.#reply(this.#targetOf(message), '处理这条消息时出错了。')
    } finally {
      if (!handedOff && !this.#pending.has(message.conversationId)) this.#stopWorking(message.conversationId)
    }
  }

  #targetOf(message: InboundMessage): Target {
    return { conversationId: message.conversationId, chatId: message.chatId, peerId: message.peerId }
  }

  /** Download every resource on a message into the media folder. Failures are logged and skipped. */
  async #fetchAttachments(message: InboundMessage): Promise<StoredAttachment[]> {
    if (message.resources.length === 0) return []
    const dir = this.#mediaDir()
    const stored: StoredAttachment[] = []
    for (const resource of message.resources) {
      try {
        const path = await this.#transport.download({
          messageId: message.messageId,
          key: resource.key,
          type: resource.type,
          dir,
          prefix: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        })
        const size = (await stat(path)).size
        stored.push({ resource, path, size })
        this.#recordBoot(`media: ${resource.kind} ${String(size)}B -> ${path}`)
      } catch (error) {
        this.#recordError(`附件下载失败（${resource.kind} ${resource.key}）: ${describeError(error)}`)
      }
    }
    return stored
  }

  #parkAttachments(message: InboundMessage, attachments: StoredAttachment[], settings: Required<ChannelSettings>): void {
    const existing = this.#pending.get(message.conversationId)
    if (existing !== undefined) clearTimeout(existing.timer)
    const text = [existing?.text ?? '', message.text].map((part) => part.trim()).filter((part) => part !== '').join('\n\n')
    const timer = settings.autoReplyAttachments
      ? setTimeout(() => {
          void this.#deliver(message, '', [])
        }, settings.mergeWindowMs)
      : undefined
    timer?.unref?.()
    this.#pending.set(message.conversationId, {
      attachments: [...(existing?.attachments ?? []), ...attachments],
      text,
      timer,
    })
  }

  #claimParked(conversationId: string): { attachments: StoredAttachment[]; text: string } {
    const parked = this.#pending.get(conversationId)
    if (parked === undefined) return { attachments: [], text: '' }
    clearTimeout(parked.timer)
    this.#pending.delete(conversationId)
    return { attachments: parked.attachments, text: parked.text }
  }

  #settleInteraction(message: InboundMessage): boolean {
    const pending = this.#interactions.get(message.conversationId)
    if (pending === undefined) return false
    const value = pending.accept(message.text)
    if (value === undefined) {
      pending.reprompt()
      return false
    }
    this.#interactions.delete(message.conversationId)
    this.#recordBoot(`interaction settled: ${pending.kind}`)
    pending.settle(value as never)
    return true
  }

  /** Read the message the user replied to, as context for the agent. Best effort. */
  async #resolveQuote(message: InboundMessage): Promise<string | undefined> {
    if (message.replyTo === undefined) return undefined
    try {
      const quoted = await this.#transport.fetchMessage(message.replyTo)
      if (quoted?.content === undefined || quoted.content.trim() === '') {
        return `[引用了一条消息，但读不到内容（${message.replyTo}）]`
      }
      const who = quoted.senderType === 'app' || quoted.senderType === 'bot' ? '我此前发送的' : '一条'
      return `[引用${who}消息]\n${truncate(quoted.content.trim(), QUOTE_LIMIT)}`
    } catch (error) {
      this.#recordBoot(`quote fetch failed ${message.replyTo}: ${describeError(error)}`)
      return `[引用了一条消息，但读取失败（${message.replyTo}）]`
    }
  }

  /**
   * Hand one turn to the agent, with whatever is parked for the conversation.
   *
   * @returns Whether the turn went to a session (so the working indicator stays on).
   */
  async #deliver(message: InboundMessage, incomingText: string, incoming: StoredAttachment[]): Promise<boolean> {
    const target = this.#targetOf(message)
    try {
      const parked = this.#claimParked(message.conversationId)
      const attachments = [...parked.attachments, ...incoming]
      const quoted = await this.#resolveQuote(message)
      const text = [parked.text, incomingText].map((part) => part.trim()).filter((part) => part !== '').join('\n\n')

      if (attachments.length === 0) {
        const routed = await this.#router.route({
          conversationId: message.conversationId,
          accountId: message.accountId,
          peerId: message.peerId,
          text,
        })
        if (routed.kind === 'reply') {
          await this.#reply(target, routed.text)
          return false
        }
        await this.#prompt(routed.decision, target, [], quoted)
        return true
      }

      // With an attachment, the text is an instruction for the agent even if it starts with `/`.
      const bound = await this.#router.route({
        conversationId: message.conversationId,
        accountId: message.accountId,
        peerId: message.peerId,
        text: '',
      })
      if (bound.kind === 'reply') {
        await this.#reply(target, bound.text)
        return false
      }
      await this.#prompt({ ...bound.decision, prompt: text }, target, attachments, quoted)
      return true
    } catch (error) {
      this.#recordError(`处理消息失败: ${describeError(error)}`)
      await this.#reply(target, '处理这条消息时出错了。')
      return false
    }
  }

  async #isFirstMessage(sessionId: string): Promise<boolean> {
    try {
      return (await storedSessionWorkspace(this.#home, sessionId)) === undefined
    } catch {
      return false
    }
  }

  /**
   * Hand a prompt to its session.
   *
   * On a session's first message the user's words go alone and the channel note follows as its own
   * message, because DSH names a session from its first prompt.
   */
  async #prompt(decision: RouteDecision, target: Target, attachments: StoredAttachment[], quoted?: string): Promise<void> {
    const settings = await this.#settings()
    const naming = await this.#isFirstMessage(decision.sessionId)
    const lines = [
      decision.prompt,
      ...(quoted === undefined ? [] : [quoted]),
      ...attachments.map(describeAttachment),
      ...(naming || settings.presenceNote === '' ? [] : [settings.presenceNote]),
    ].filter((line) => line !== '')
    const prompt = lines.join('\n\n')
    const outbound = (naming && settings.presenceNote !== '' ? [prompt, settings.presenceNote] : [prompt]).filter(
      (text) => text !== '',
    )

    let delivered = false
    for (const text of outbound) {
      if (await this.#submit(decision.sessionId, text, 'steer')) delivered = true
      else if (await this.#submit(decision.sessionId, text, 'queue')) delivered = true
    }
    if (delivered) return
    this.#recordError('提交任务失败: 插话与排队都未成功')
    await this.#reply(target, `没能把消息交给会话，请重发一次。\n\n你的内容：\n${truncate(prompt, 4_000)}`)
  }

  async #submit(sessionId: string, prompt: string, mode: 'queue' | 'steer'): Promise<boolean> {
    try {
      await this.#ctx.sessionController.prompt(
        { requestId: `lark-${randomUUID()}`, sessionId, mode, content: [{ type: 'text', text: prompt }] },
        new AbortController().signal,
      )
      return true
    } catch (error) {
      if (mode === 'steer') this.#recordBoot(`steer refused: ${describeError(error)}`)
      else this.#recordError(`提交任务失败: ${describeError(error)}`)
      return false
    }
  }

  // ───────────────────────────── outbound ─────────────────────────────

  /**
   * Feed one assistant stream frame into the reply buffer.
   *
   * Deltas are joined behind a short quiet window so a stream becomes one coherent message; the
   * frame that ends the turn flushes at once. The handler stays synchronous up to the buffer write,
   * so two frames of one answer cannot interleave.
   */
  onAssistantFrame(payload: AssistantStreamPayload): void {
    const { sessionId, text, completed } = readStreamFrame(payload)
    if (sessionId === undefined) return
    if ((text === undefined || text === '') && completed !== true) return

    void (async () => {
      const bindings = (await this.#store.read()).bindings
      const conversation = Object.values(bindings).find((entry) => entry.sessionId === sessionId)
      if (conversation === undefined) return

      const existing = this.#replies.get(sessionId)
      if (existing !== undefined) clearTimeout(existing.timer)
      const entry = existing ?? { text: '', conversationId: conversation.conversationId, timer: undefined }
      if (text !== undefined) entry.text += text

      if (completed === true) {
        this.#replies.set(sessionId, entry)
        await this.#flushReply(sessionId)
        // A turn that produced no text still ends the "working" state.
        this.#stopWorking(conversation.conversationId)
        return
      }

      const { settleMs } = this.#settingsNow()
      entry.timer = setTimeout(() => {
        void this.#flushReply(sessionId)
      }, settleMs)
      entry.timer.unref?.()
      this.#replies.set(sessionId, entry)
    })()
  }

  async #flushReply(sessionId: string): Promise<void> {
    const entry = this.#replies.get(sessionId)
    if (entry === undefined) return
    this.#replies.delete(sessionId)
    const text = entry.text.trim()
    if (text === '') return
    const target = await this.#targetForConversation(entry.conversationId)
    if (target === undefined) return
    await this.#reply(target, text)
  }

  async flushReplies(): Promise<void> {
    for (const sessionId of [...this.#replies.keys()]) {
      const entry = this.#replies.get(sessionId)
      if (entry !== undefined) clearTimeout(entry.timer)
      await this.#flushReply(sessionId)
    }
  }

  /** Send a reply into a conversation; failures are logged, not thrown. */
  async #reply(target: Target, text: string): Promise<void> {
    this.#stopWorking(target.conversationId)
    try {
      await this.#sendWithinLimit(target, text)
    } catch (error) {
      this.#recordError(`发送失败: ${describeError(error)}`)
    }
  }

  /** A reply over the limit is sent as a Markdown file rather than cut short. */
  async #sendWithinLimit(target: Target, text: string): Promise<void> {
    const limit = (await this.#settings()).maxReplyChars
    if (limit <= 0 || text.length <= limit) {
      await this.#sendText(target, text)
      return
    }
    await this.#sendText(target, `回复较长（${String(text.length)} 字），已作为文件发送。`, 'text')
    const fileName = `回复-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
    const path = join(this.#mediaDir(), fileName)
    await writeFile(path, text, 'utf8')
    await this.#conveyFile(target, path)
    this.#recordBoot(`long reply ${String(text.length)} chars -> ${fileName}`)
  }

  /**
   * Send one text message. Markdown first; if Feishu rejects the rendered post, plain text.
   */
  async #sendText(target: Target, text: string, format: 'markdown' | 'text' = 'markdown'): Promise<void> {
    const to: Recipient = { chatId: target.chatId }
    try {
      const sent = await this.#transport.sendText(to, text, format)
      this.#recordBoot(`outbound text id=${sent.messageId ?? '(none)'} len=${String(text.length)} body=${text.replace(/\s+/g, ' ').slice(0, 80)}`)
    } catch (error) {
      if (format !== 'markdown' || !(error instanceof LarkCliError) || error.kind === 'spawn' || error.kind === 'auth') throw error
      this.#recordBoot(`markdown send failed, retrying as text: ${describeError(error)}`)
      await this.#transport.sendText(to, text, 'text')
    }
  }

  /** Upload and send one local file. */
  async #conveyFile(target: Target, path: string, caption?: string): Promise<string> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`不是文件：${path}`)
    if (caption !== undefined && caption.trim() !== '') await this.#sendText(target, caption.trim())
    const sent = await this.#transport.sendFile({ chatId: target.chatId }, path)
    const fileName = basename(path)
    this.#recordBoot(`outbound ${sent.kind}: ${fileName} ${String(info.size)}B -> ${target.chatId} id=${sent.messageId ?? '(none)'}`)
    return `已发送 ${fileName}（${String(info.size)} 字节）到飞书`
  }

  #mediaDir(): string {
    const dir = join(this.#workspace, MEDIA_DIR_NAME)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  // ───────────────────────────── working indicator ─────────────────────────────

  /**
   * Mark the user's message with an emoji while the agent works.
   *
   * Feishu has no typing indicator for bots; a reaction on the message being worked on is the
   * nearest visible signal. Cosmetic: every failure is logged and ignored.
   */
  #startWorking(conversationId: string, messageId: string): void {
    const emoji = this.#settingsNow().workingEmoji
    if (emoji === '') return
    this.#stopWorking(conversationId)
    const reaction = this.#transport.addReaction(messageId, emoji).catch((error: unknown) => {
      this.#recordBoot(`reaction add failed: ${describeError(error)}`)
      return undefined
    })
    const cap = setTimeout(() => this.#stopWorking(conversationId), WORKING_MAX_MS)
    cap.unref?.()
    this.#working.set(conversationId, { messageId, reaction, cap })
  }

  #stopWorking(conversationId: string): void {
    const entry = this.#working.get(conversationId)
    if (entry === undefined) return
    this.#working.delete(conversationId)
    clearTimeout(entry.cap)
    void entry.reaction.then(async (reactionId) => {
      if (reactionId === undefined) return
      try {
        await this.#transport.deleteReaction(entry.messageId, reactionId)
      } catch (error) {
        this.#recordBoot(`reaction delete failed: ${describeError(error)}`)
      }
    })
  }

  // ───────────────────────────── resolution ─────────────────────────────

  async #targetForConversation(conversationId: string): Promise<Target | undefined> {
    const binding = (await this.#store.read()).bindings[conversationId]
    return binding === undefined ? undefined : this.#targetOfBinding(binding)
  }

  #targetOfBinding(binding: SessionBinding): Target | undefined {
    const chatId = chatOfConversation(binding.conversationId)
    if (chatId === undefined) return undefined
    return { conversationId: binding.conversationId, chatId, peerId: binding.peerId }
  }

  /** The conversation a session may speak for: only the one it is currently bound to. */
  async #conversationForAgentSession(sessionId: string | undefined): Promise<string | undefined> {
    if (sessionId === undefined) return undefined
    const found = Object.values((await this.#store.read()).bindings).find((entry) => entry.sessionId === sessionId)
    return found?.conversationId
  }

  async #targetForAgent(agent: unknown): Promise<Target | undefined> {
    const conversationId = await this.#conversationForAgentSession(sessionIdOf(agent))
    return conversationId === undefined ? undefined : await this.#targetForConversation(conversationId)
  }

  /**
   * Where a proactive message goes when the caller is not a bound session.
   *
   * The most recently used conversation whose user is still allowed. Unlike WeChat, one Feishu bot
   * can sit in a direct chat and several groups, so "the conversation the user is in" is read as
   * "the one they last talked in", never chosen by the agent.
   */
  async #lastConversation(): Promise<{ ok: true; target: Target } | { ok: false; reason: string }> {
    const settings = await this.#settings()
    const candidates = Object.values((await this.#store.read()).bindings)
      .filter((binding) => isAllowed(settings, binding.peerId))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    const binding = candidates[0]
    if (binding === undefined) {
      return { ok: false, reason: '还没有飞书对话。请先在飞书里给机器人发一条消息，之后才能主动推送。' }
    }
    const target = this.#targetOfBinding(binding)
    if (target === undefined) return { ok: false, reason: '绑定记录损坏，请在飞书里重新发一条消息。' }
    return { ok: true, target }
  }

  // ───────────────────────────── interactions ─────────────────────────────

  async #ask<T>(
    target: Target,
    body: string,
    kind: 'approval' | 'question',
    parse: (reply: string) => T | undefined,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const settled = Promise.withResolvers<T | undefined>()
    const previous = this.#interactions.get(target.conversationId)
    if (previous !== undefined) {
      this.#interactions.delete(target.conversationId)
      previous.settle(undefined as never)
    }
    this.#interactions.set(target.conversationId, {
      kind,
      accept: parse as (reply: string) => unknown | undefined,
      settle: settled.resolve as (value: never) => void,
      reprompt: () => {
        void this.#reply(target, `请先回复上一条提示。\n\n${body}`)
      },
    })
    const onAbort = (): void => {
      this.#interactions.delete(target.conversationId)
      settled.resolve(undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.#reply(target, body)
      this.#recordBoot(`interaction asked: ${kind} -> ${target.chatId}`)
      return await settled.promise
    } finally {
      signal?.removeEventListener('abort', onAbort)
      const current = this.#interactions.get(target.conversationId)
      if (current?.settle === (settled.resolve as (value: never) => void)) this.#interactions.delete(target.conversationId)
    }
  }

  /**
   * Claim permission prompts for sessions bound to a Feishu chat; delegate everything else.
   *
   * @returns The listener for `ctx.on('approval/request', …)`.
   */
  approvalListener(): (request: unknown, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome> {
    return async (request, next) => {
      const record = (request ?? {}) as {
        agent?: unknown
        toolName?: unknown
        displayReason?: unknown
        reason?: unknown
        command?: unknown
        signal?: AbortSignal
      }
      const sessionId = sessionIdOf(record.agent)
      const conversationId = await this.#conversationForAgentSession(sessionId)
      this.#recordBoot(
        `approval seen: tool=${String(record.toolName)} session=${sessionId ?? '(none)'} ${conversationId === undefined ? '-> delegate' : '-> claiming'}`,
      )
      if (conversationId === undefined) return await next()
      const target = await this.#targetForConversation(conversationId)
      if (target === undefined) return await next()
      const answer = await this.#ask(target, presentApproval(record).body, 'approval', parseApprovalReply, record.signal)
      // Withdrawn or unanswered: hand back rather than guess on a permission.
      return answer ?? (await next())
    }
  }

  /** @returns The listener for `ctx.on('user-questions/request', …)`. */
  questionListener(): (request: unknown, next: () => Promise<QuestionAnswerBatch>) => Promise<QuestionAnswerBatch> {
    return async (request, next) => {
      const record = (request ?? {}) as { agent?: unknown; questions?: QuestionItem[]; signal?: AbortSignal }
      const questions = record.questions
      if (!Array.isArray(questions) || questions.length === 0) return await next()
      const sessionId = sessionIdOf(record.agent)
      const conversationId = await this.#conversationForAgentSession(sessionId)
      this.#recordBoot(
        `question seen: count=${String(questions.length)} session=${sessionId ?? '(none)'} ${conversationId === undefined ? '-> delegate' : '-> claiming'}`,
      )
      if (conversationId === undefined) return await next()
      const target = await this.#targetForConversation(conversationId)
      if (target === undefined) return await next()
      const answer = await this.#ask(
        target,
        presentQuestions(questions).body,
        'question',
        (reply) => parseQuestionReply(questions, reply),
        record.signal,
      )
      return answer ?? (await next())
    }
  }

  // ───────────────────────────── tools ─────────────────────────────

  registerTools(): Disposer {
    const tools = this.#ctx.tools
    if (tools === undefined) {
      this.#recordError('此组合没有工具服务，agent 无法主动发送到飞书')
      return () => {}
    }

    const send = tools.register({
      name: 'send_to_lark',
      description:
        'Send a file from this machine to the Feishu chat this session is talking to. Images arrive as pictures; everything else as a file attachment. Use this whenever the user asked to see, receive, or be sent a file, image, screenshot, chart, or document. The path must be absolute and may point anywhere on this machine.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to send.' },
          caption: { type: 'string', description: 'Optional short message to send before the file.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { detail: { type: 'string' } }, required: ['detail'] },
        render: (args) => [{ type: 'text', text: `sent ${String(args.path ?? '')} to Feishu` }],
      },
      execute: async (args, exec) => {
        const target = await this.#targetForAgent(exec.agent)
        if (target === undefined) throw new Error('这个会话没有绑定飞书对话，无法发送。请让用户先在飞书里发一条消息。')
        const caption = typeof args.caption === 'string' ? args.caption : undefined
        return { detail: await this.#conveyFile(target, String(args.path ?? ''), caption) }
      },
    })

    this.#sessionToolDisposer = tools.register(this.#sessionToolDefinition())

    const notify = tools.register({
      name: 'notify_lark',
      description:
        'Push a message, and optionally a file, to the user on Feishu. Unlike send_to_lark this works from any session, including one no Feishu chat is bound to, which is what makes "tell me when it is done" possible. It always reaches the chat the user last talked in; there is no way to choose another. Keep text short — it is likely read on a phone. Markdown is rendered.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message to send.' },
          path: { type: 'string', description: 'Optional absolute path of a file to send after the text.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { detail: { type: 'string' } }, required: ['detail'] },
        render: (args) => [{ type: 'text', text: `notify Feishu${args.path === undefined ? '' : ` with ${String(args.path)}`}` }],
      },
      execute: async (args, exec) => ({
        detail: await this.#notify(String(args.text ?? ''), typeof args.path === 'string' ? args.path : undefined, exec.agent),
      }),
    })

    return () => {
      send()
      this.#sessionToolDisposer?.()
      this.#sessionToolDisposer = undefined
      notify()
    }
  }

  async #notify(text: string, path: string | undefined, agent: unknown): Promise<string> {
    if (text.trim() === '' && (path === undefined || path === '')) throw new Error('至少要给 text 或 path 其中一个。')
    let target: Target | undefined
    if (!this.#settingsFromDisk().allowCrossSessionNotify) {
      target = await this.#targetForAgent(agent)
      if (target === undefined) {
        throw new Error('这个会话没有绑定飞书对话，而「允许其他会话推送到飞书」是关闭的。')
      }
    } else {
      // The bound session speaks for its own chat; anyone else reaches the last-used chat.
      target = await this.#targetForAgent(agent)
      if (target === undefined) {
        const last = await this.#lastConversation()
        if (!last.ok) throw new Error(last.reason)
        target = last.target
      }
    }
    const done: string[] = []
    if (text.trim() !== '') {
      await this.#sendText(target, text)
      done.push('消息')
    }
    if (path !== undefined && path !== '') {
      await this.#conveyFile(target, path)
      done.push(`文件 ${basename(path)}`)
    }
    this.#recordBoot(`notify_lark: ${done.join(', ')} -> ${target.chatId}`)
    return `已通过飞书发送：${done.join('、')}`
  }

  refreshSessionTool(): void {
    const tools = this.#ctx.tools
    if (tools === undefined) return
    this.#sessionToolDisposer?.()
    this.#sessionToolDisposer = tools.register(this.#sessionToolDefinition())
  }

  #sessionToolDefinition(): ToolDefinition {
    const requireConfirmation = this.#settingsFromDisk().requireConfirmation
    return {
      name: 'session_control',
      description: sessionToolDescription(requireConfirmation),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'switch', 'new', 'current', 'cancel'],
            description:
              'list: show conversations with their numbers. switch: move this Feishu chat to an existing one. new: start a fresh one. current: report which one is in use. cancel: interrupt the work running in it.',
          },
          target: {
            type: 'string',
            description:
              'For switch, the conversation to move to: its number from list, or its title. For new, an optional title. For list, "all" includes other workspaces.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { detail: { type: 'string' }, ok: { type: 'boolean' }, otherWorkspaces: { type: 'number' } },
          required: ['detail', 'ok'],
        },
        render: (args) => [{ type: 'text', text: `session_control ${String(args.action ?? '')}` }],
      },
      execute: async (args, exec) => {
        const result = await this.controlSession(
          sessionIdOf(exec.agent),
          String(args.action ?? ''),
          args.target === undefined ? undefined : String(args.target),
        )
        this.#recordBoot(`session_control: action=${String(args.action)} target=${String(args.target ?? '')} ok=${String(result.ok)}`)
        const rows = renderTable(result.sessions, result.sessions.find((row) => row.current)?.sessionId)
        return { detail: rows === '' ? result.detail : `${result.detail}\n\n${rows}`, ok: result.ok, otherWorkspaces: result.otherWorkspaces }
      },
    }
  }

  /**
   * Perform a session action on behalf of the agent, through the router's own command path.
   */
  async controlSession(
    callerSessionId: string | undefined,
    action: string,
    target?: string,
  ): Promise<{
    ok: boolean
    detail: string
    sessions: { index: number; sessionId: string; title: string; updatedAt: number; current: boolean }[]
    otherWorkspaces: number
  }> {
    const none = { sessions: [], otherWorkspaces: 0 }
    const conversationId = await this.#conversationForAgentSession(callerSessionId)
    const binding = conversationId === undefined ? undefined : (await this.#store.read()).bindings[conversationId]
    if (conversationId === undefined || binding === undefined) {
      return { ok: false, detail: '这个会话没有绑定任何飞书对话，无法操作。', ...none }
    }
    const text =
      action === 'switch'
        ? `/switch ${target ?? ''}`
        : action === 'new' && target !== undefined && target !== ''
          ? `/new ${target}`
          : `/${action}`
    const result = await this.#router.route({ conversationId, accountId: binding.accountId, peerId: binding.peerId, text })
    if (result.kind !== 'reply') return { ok: false, detail: `不支持的操作：${action}`, ...none }

    const includeAll = target === 'all'
    const { sessions, otherWorkspaces, otherNames } = await this.#sessionTable(conversationId, includeAll)
    const failed = /找不到|未知指令/.test(result.text)
    const announce = async (body: string): Promise<void> => {
      const resolved = await this.#targetForConversation(conversationId)
      if (resolved !== undefined) await this.#reply(resolved, body)
    }

    if (action === 'switch' || action === 'new') {
      if (failed) await announce(switchFailure(action, target, result.text))
      else await announce(switchConfirmation(action, (await this.#store.read()).bindings[conversationId]?.title ?? ''))
    }
    if (failed) {
      return { ok: false, detail: `操作失败，已直接告诉用户。原因：${result.text.split('\n')[0] ?? ''}`, sessions, otherWorkspaces }
    }
    if (action === 'list' || action === 'current') {
      const currentId = sessions.find((row) => row.current)?.sessionId
      const body =
        sessions.length === 0
          ? '还没有其他对话。'
          : [
              `共 ${String(sessions.length + otherWorkspaces)} 个对话${otherNames.length === 0 ? '' : `（这里显示 ${String(sessions.length)} 个）`}：`,
              '',
              renderTable(sessions, currentId),
              otherNames.length === 0
                ? ''
                : `\n另有 ${String(otherWorkspaces)} 个对话在别的工作区（${otherNames.join('、')}）。说「看全部对话」就能一起看。`,
              '',
              '回复数字即可切换，例如「3」。',
            ]
              .filter((part) => part !== '')
              .join('\n')
      await announce(body)
      return { ok: true, detail: `列表已直接发给用户（共 ${String(sessions.length)} 个对话）。不要重复这份列表。`, sessions, otherWorkspaces }
    }
    return { ok: true, detail: result.text, sessions, otherWorkspaces }
  }

  async #sessionTable(
    conversationId: string,
    includeAll: boolean,
  ): Promise<{
    sessions: { index: number; sessionId: string; title: string; updatedAt: number; current: boolean }[]
    otherWorkspaces: number
    otherNames: string[]
  }> {
    const current = (await this.#store.read()).bindings[conversationId]
    const currentId = current?.sessionId ?? ''
    const listed = await this.#gateway().listSessions()
    if (listed.length === 0) {
      return {
        sessions:
          current === undefined
            ? []
            : [{ index: 1, sessionId: current.sessionId, title: current.title.trim() || '(无标题)', updatedAt: current.lastUsedAt, current: true }],
        otherWorkspaces: 0,
        otherNames: [],
      }
    }
    const own: typeof listed = []
    const others: typeof listed = []
    const otherPaths = new Set<string>()
    for (const session of listed) {
      const path = await storedSessionWorkspace(this.#home, session.sessionId)
      if (path === undefined || isSameWorkspace(path, this.#workspace)) own.push(session)
      else {
        others.push(session)
        otherPaths.add(path)
      }
    }
    const ordered = [...(includeAll ? [...own, ...others] : own)].sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      sessions: ordered.map((session, index) => ({
        index: index + 1,
        sessionId: session.sessionId,
        title: session.title.trim() || '(无标题)',
        updatedAt: session.updatedAt,
        current: session.sessionId === currentId,
      })),
      otherWorkspaces: includeAll ? 0 : others.length,
      otherNames: includeAll ? [] : [...otherPaths].map(workspaceLabel).sort(),
    }
  }

  // ───────────────────────────── DSH sessions ─────────────────────────────

  async #workspaceIdFor(path: string, title: string): Promise<string> {
    const registry = this.#ctx.workspaceRegistry
    if (registry === undefined) return ''
    if (isSameWorkspace(path, this.#workspace) && this.#workspaceId !== undefined) return this.#workspaceId
    const workspace = (await registry.resolveByPath(path)) ?? (await registry.create(path))
    if (title !== '' && workspace.title !== title) await workspace.setTitle(title)
    if (isSameWorkspace(path, this.#workspace)) this.#workspaceId = workspace.id
    return workspace.id
  }

  /** Apply the chosen permission preset before a session's first turn. Best effort. */
  #applyPermissionPreset(sessionId: string): void {
    const preset = this.#settingsFromDisk().permissionPreset
    if (preset === 'default') return
    try {
      const sessions = this.#ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
      const presets = this.#ctx.get('permissionPresets') as { set?: (session: unknown, preset: string) => void } | undefined
      const session = sessions?.get?.(sessionId)
      if (session === undefined || presets?.set === undefined) {
        this.#recordBoot(`permission preset '${preset}' not applied to ${sessionId}: service unavailable`)
        return
      }
      presets.set(session, preset)
      this.#recordBoot(`permission preset '${preset}' applied to ${sessionId}`)
    } catch (error) {
      this.#recordBoot(`permission preset failed for ${sessionId}: ${String(error)}`)
    }
  }

  #gateway(): SessionGateway {
    const ctx = this.#ctx
    const cwd = this.#workspace
    return {
      ensureSession: async (sessionId: string, _title: string, requestedCwd?: string): Promise<void> => {
        // Precedence: caller-supplied cwd > stored session workspace > channel default.
        // This ensures a session created with `/new ~/Projects/x` always re-adopts under ~/Projects/x.
        const home =
          requestedCwd ??
          (await storedSessionWorkspace(this.#home, sessionId)) ??
          cwd
        const workspaceId = await this.#workspaceIdFor(home, isSameWorkspace(home, cwd) ? WORKSPACE_TITLE : '')
        if (workspaceId === '') await ctx.sessionController.create({ sessionId, cwd: home })
        else await ctx.sessionController.create({ sessionId, workspaceId })
        this.#applyPermissionPreset(sessionId)
      },
      prompt: async (sessionId: string, text: string): Promise<void> => {
        await ctx.sessionController.prompt(
          { requestId: `lark-${randomUUID()}`, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
          new AbortController().signal,
        )
      },
      // The on-disk store is the source of sessions; see session-index.ts for why.
      listOwnSessions: async () => (await splitStoredSessions(this.#home, cwd)).own,
      listSessions: async () => {
        const { own, others } = await splitStoredSessions(this.#home, cwd)
        return [...own, ...others]
      },
      cancel: async (sessionId: string): Promise<void> => {
        await ctx.sessionController.cancel({ sessionId })
      },
    }
  }

  // ───────────────────────────── logging ─────────────────────────────

  #recordError(message: string): void {
    this.#errors.push(`${new Date().toISOString()} ${message}`)
    if (this.#errors.length > 50) this.#errors.shift()
    bootLog(this.#home, `ERROR ${message}`)
  }

  #recordBoot(message: string): void {
    bootLog(this.#home, message)
  }

  recordClientError(scope: string, message: string, stack: string): void {
    recordClientFailure(this.#home, scope, message, stack)
    this.#recordError(`客户端错误[${scope}]: ${message}`)
  }
}

async function splitStoredSessions(
  home: string,
  cwd: string,
): Promise<{
  own: { sessionId: string; title: string; updatedAt: number }[]
  others: { sessionId: string; title: string; updatedAt: number }[]
}> {
  const grouped = await listAllStoredSessions(home).catch(() => new Map())
  const own: { sessionId: string; title: string; updatedAt: number }[] = []
  const others: { sessionId: string; title: string; updatedAt: number }[] = []
  for (const [path, sessions] of grouped) {
    const bucket = isSameWorkspace(path, cwd) ? own : others
    for (const session of sessions) bucket.push({ sessionId: session.sessionId, title: session.title, updatedAt: session.updatedAt })
  }
  return { own, others }
}

function resolveHome(ctx: LarkContext): string {
  const home = ctx.get('homePaths') as { home?: string } | undefined
  return home?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Plugin configuration from the loader patch. */
export interface LarkConfig {
  /** Connect on boot even if the settings switch is off. */
  autoStart?: boolean
  stateFile?: string
  /** Override the sessions' working directory. Changing it strands existing sessions. */
  workspace?: string
}

/**
 * Mount the Feishu channel.
 *
 * @param ctx - Host context.
 * @param config - Patch configuration.
 * @param internals - Test seams. The loader never sets this.
 */
export function apply(ctx: LarkContext, config: LarkConfig = {}, internals: Internals = {}): void {
  const home = resolveHome(ctx)
  bootLog(home, 'apply: entered')
  try {
    const stateFile = config.stateFile ?? join(home, STATE_DIR_NAME, 'state.json')
    const workspace = config.workspace ?? join(home, WORKSPACE_DIR_NAME)
    // The host realpaths a session's cwd, which fails on a missing directory.
    mkdirSync(workspace, { recursive: true })

    const runtime = new LarkRuntime(ctx, { home, stateFile, workspace, internals })
    ctx.provide('larkChannel', runtime)

    ctx.effect(() => {
      const detachStream = ctx.on('agent/assistant-stream', (payload) => runtime.onAssistantFrame(payload), { global: true })
      const detachRoutes = registerRoutes(ctx, runtime)
      const detachTools = runtime.registerTools()
      // `global` because this plugin owns no agent and would otherwise be filtered out; `prepend`
      // so it claims bound sessions before the desktop answerer blocks on its pane.
      const detachApproval = ctx.on('approval/request', runtime.approvalListener(), { global: true, prepend: true })
      const detachQuestions = ctx.on('user-questions/request', runtime.questionListener(), { global: true, prepend: true })

      void (async () => {
        try {
          if (config.autoStart === true || (await runtime.enabled())) await runtime.start()
          bootLog(home, 'apply: channel ready')
        } catch (error) {
          bootLog(home, `apply: start failed: ${describeError(error)}`)
        }
      })()

      return () => {
        try {
          if (typeof detachStream === 'function') detachStream()
          if (typeof detachApproval === 'function') detachApproval()
          if (typeof detachQuestions === 'function') detachQuestions()
          detachRoutes()
          detachTools()
          void runtime.flushReplies().finally(() => runtime.halt())
        } catch (error) {
          bootLog(home, `apply: teardown failed: ${describeError(error)}`)
        }
      }
    })
    bootLog(home, 'apply: mounted')
  } catch (error) {
    bootLog(home, `apply: FAILED: ${describeError(error)}`)
    if (error instanceof Error && error.stack) bootLog(home, `apply: stack:\n${error.stack}`)
    throw error
  }
}

/** Append a line to the boot log. Best effort: diagnostics never break startup. */
function bootLog(home: string, line: string): void {
  try {
    const dir = join(home, STATE_DIR_NAME)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, BOOT_LOG_NAME), `${new Date().toISOString()} ${line}\n`, 'utf-8')
  } catch {
    // Ignored.
  }
}

/** Record a browser-side failure in the boot log. */
export function recordClientFailure(home: string, scope: string, message: string, stack: string): void {
  bootLog(home, `client[${scope}] FAILED: ${message}`)
  if (stack !== '') bootLog(home, `client[${scope}] stack:\n${stack}`)
}

function registerRoutes(ctx: LarkContext, runtime: LarkRuntime): () => void {
  const webServer = ctx.get('webServer') as
    | {
        register(route: {
          kind: 'prefix'
          path: string
          handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>
        }): () => void
      }
    | undefined
  if (webServer === undefined) return () => {}

  return webServer.register({
    kind: 'prefix',
    path: '/.dsh-lark-plugin',
    handler: async (req, res) => {
      const route = new URL(req.url ?? '/', 'http://localhost').pathname
      try {
        if (route === ROUTE_STATUS && req.method === 'GET') return json(res, 200, await runtime.status())
        if (route === ROUTE_SETTINGS && req.method === 'GET') return json(res, 200, await runtime.settingsForPage())
        if (route === ROUTE_SETTINGS && req.method === 'POST') {
          const settings = await runtime.saveSettings(normalizeSettings(await readJson(req)))
          return json(res, 200, { settings })
        }
        if (route === ROUTE_TOGGLE && req.method === 'POST') {
          await runtime.setEnabled((await readJson(req)).enabled === true)
          return json(res, 200, await runtime.status())
        }
        if (route === ROUTE_CONNECTION && req.method === 'POST') {
          const body = await readJson(req)
          await runtime.saveConnection({
            ...(typeof body.cliPath === 'string' ? { cliPath: body.cliPath } : {}),
            ...(typeof body.profile === 'string' ? { profile: body.profile } : {}),
          })
          return json(res, 200, await runtime.status())
        }
        if (route === ROUTE_CHECK && req.method === 'POST') {
          await runtime.checkConnection()
          return json(res, 200, await runtime.status())
        }
        if (route === ROUTE_CLIENT_ERROR && req.method === 'POST') {
          const body = await readJson(req)
          runtime.recordClientError(
            typeof body.scope === 'string' ? body.scope : 'client',
            typeof body.message === 'string' ? body.message : '(无消息)',
            typeof body.stack === 'string' ? body.stack : '',
          )
          return json(res, 200, { recorded: true })
        }
        return json(res, 404, { error: 'not found' })
      } catch (error) {
        return json(res, 500, { error: describeError(error) })
      }
    },
  })
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export type { ChannelState }
export { LarkRuntime }
