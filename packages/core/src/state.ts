/**
 * Durable state for the channel: which lark-cli to run, who may talk to the bot, and which Feishu
 * chat is bound to which DSH session.
 *
 * Far smaller than the WeChat version, because Feishu needs none of its workarounds: no login token
 * (lark-cli holds the app credentials), no poll cursor (the long connection pushes), no per-message
 * reply token and no closed reply window (a bot may message a user in its availability scope at any
 * time).
 *
 * Writes are atomic (temp file plus rename).
 *
 * @module @dsh-lark/core/state
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { SessionBinding } from './router.ts'

/** Everything persisted for one channel deployment. */
export interface ChannelState {
  version: 1
  /** lark-cli executable and profile. */
  connection: {
    cliPath?: string
    profile?: string
    /** App id last reported by `auth status`; also the account key in bindings. */
    appId?: string
  }
  /** Conversation-to-session mapping, so a chat keeps its session across restarts. */
  bindings: Record<string, SessionBinding>
  /** Whether the channel should connect on boot. */
  autoStart?: boolean
  settings?: ChannelSettings
}

/** Tuned behaviour, every field optional so a stored file stays readable across versions. */
export interface ChannelSettings {
  /**
   * open_ids (`ou_…`) allowed to drive this machine.
   *
   * Required, and empty means *nobody*. This is the one safety property the WeChat build got from
   * the protocol and Feishu does not give: anyone in the app's availability scope can message the
   * bot, and the agent runs with this user's permissions. Messages from anyone else are answered
   * with their own open_id, so the owner can copy it into this list.
   */
  allowedUsers?: string[]
  /** Whether messages in group chats are handled at all (still subject to `allowedUsers`). */
  allowGroups?: boolean
  /** Quiet time after a non-text message before it is answered on its own, in milliseconds. */
  mergeWindowMs?: number
  /** Reply text longer than this is sent as a file instead of a message. */
  maxReplyChars?: number
  /** Quiet time that ends a burst of assistant output into one message, in milliseconds. */
  settleMs?: number
  /** Whether a non-text message is answered on its own once the window elapses. */
  autoReplyAttachments?: boolean
  /** Whether the agent must confirm a session action with the user before taking it. */
  requireConfirmation?: boolean
  /** Standing note appended to prompts, telling the agent it is on Feishu. */
  presenceNote?: string
  /** Permission preset applied to every session this channel creates. */
  permissionPreset?: PermissionPreset
  /** Whether a session that is not the bound one may push to the Feishu chat. */
  allowCrossSessionNotify?: boolean
  /** Emoji added to the user's message while the agent works. Empty disables it. */
  workingEmoji?: string
}

/** Permission presets this channel will apply to its own sessions. */
export type PermissionPreset = 'danger-full-access' | 'auto' | 'default'

/** Values applied when a setting has never been stored. */
export const DEFAULT_SETTINGS = {
  allowedUsers: [] as string[],
  allowGroups: false,
  mergeWindowMs: 10_000,
  maxReplyChars: 8_000,
  settleMs: 1_200,
  autoReplyAttachments: true,
  requireConfirmation: true,
  permissionPreset: 'danger-full-access' as PermissionPreset,
  allowCrossSessionNotify: true,
  workingEmoji: 'Typing',
  presenceNote:
    '[渠道：飞书] 你在和飞书上的用户对话，对方多半在手机上，看不到这台电脑的屏幕和文件系统。' +
    '不要让他去"打开某个路径"或"看某个文件"。需要给他看东西时，用 send_to_lark 直接发送：' +
    '图片会显示成图片，其他文件会作为附件发过去。回复支持 Markdown，尽量简短，适合手机阅读。',
}

/**
 * Resolve the stored settings against the defaults.
 *
 * @param state - State to read from.
 * @returns Every setting, with defaults filled in.
 */
export function resolveSettings(state: Pick<ChannelState, 'settings'>): Required<ChannelSettings> {
  const stored = state.settings ?? {}
  return {
    allowedUsers: stored.allowedUsers ?? [...DEFAULT_SETTINGS.allowedUsers],
    allowGroups: stored.allowGroups ?? DEFAULT_SETTINGS.allowGroups,
    mergeWindowMs: stored.mergeWindowMs ?? DEFAULT_SETTINGS.mergeWindowMs,
    maxReplyChars: stored.maxReplyChars ?? DEFAULT_SETTINGS.maxReplyChars,
    settleMs: stored.settleMs ?? DEFAULT_SETTINGS.settleMs,
    autoReplyAttachments: stored.autoReplyAttachments ?? DEFAULT_SETTINGS.autoReplyAttachments,
    requireConfirmation: stored.requireConfirmation ?? DEFAULT_SETTINGS.requireConfirmation,
    permissionPreset: stored.permissionPreset ?? DEFAULT_SETTINGS.permissionPreset,
    allowCrossSessionNotify: stored.allowCrossSessionNotify ?? DEFAULT_SETTINGS.allowCrossSessionNotify,
    workingEmoji: stored.workingEmoji ?? DEFAULT_SETTINGS.workingEmoji,
    presenceNote: stored.presenceNote ?? DEFAULT_SETTINGS.presenceNote,
  }
}

/** Whether an open_id may use the channel. */
export function isAllowed(settings: Required<ChannelSettings>, openId: string): boolean {
  return settings.allowedUsers.some((entry) => entry.trim() === openId)
}

const EMPTY_STATE: ChannelState = {
  version: 1,
  connection: {},
  bindings: {},
}

/** Composed storage for one state file. */
export class StateStore {
  readonly file: string
  #cache: ChannelState | undefined
  #loading: Promise<ChannelState> | undefined
  /** Serialises concurrent writes; the channel is event-driven and re-entrant. */
  #writeChain: Promise<void> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  /** Default state path under a DSH home directory. */
  static under(dshHome: string): StateStore {
    return new StateStore(join(dshHome, 'lark', 'state.json'))
  }

  /** Read the current state, tolerating a missing or corrupt file. */
  async read(): Promise<ChannelState> {
    // One shared load: a second read that started before the first finished would otherwise cache
    // an empty state and a later update would wipe the file.
    this.#loading ??= this.#load()
    return await this.#loading
  }

  async #load(): Promise<ChannelState> {
    if (this.#cache !== undefined) return this.#cache
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf-8')) as Partial<ChannelState>
      this.#cache = normalize(parsed)
    } catch {
      this.#cache = structuredClone(EMPTY_STATE)
    }
    return this.#cache
  }

  /** Apply a mutation and persist the result. */
  async update(mutate: (state: ChannelState) => void): Promise<void> {
    const state = await this.read()
    mutate(state)
    this.#writeChain = this.#writeChain.then(() => this.#persist(state))
    await this.#writeChain
  }

  async #persist(state: ChannelState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
    try {
      await rename(temp, this.file)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
}

/** Coerce a possibly-foreign object into a well-formed state. */
function normalize(parsed: Partial<ChannelState>): ChannelState {
  const connection = isRecord(parsed.connection) ? parsed.connection : {}
  return {
    version: 1,
    connection: {
      ...(typeof connection.cliPath === 'string' ? { cliPath: connection.cliPath } : {}),
      ...(typeof connection.profile === 'string' ? { profile: connection.profile } : {}),
      ...(typeof connection.appId === 'string' ? { appId: connection.appId } : {}),
    },
    bindings: isRecord(parsed.bindings) ? (parsed.bindings as Record<string, SessionBinding>) : {},
    ...(isRecord(parsed.settings) ? { settings: normalizeSettings(parsed.settings) } : {}),
    ...(typeof parsed.autoStart === 'boolean' ? { autoStart: parsed.autoStart } : {}),
  }
}

/**
 * Keep only settings of the expected type. Also used to sanitise a patch from the settings page.
 *
 * @param raw - Stored settings or a request body.
 * @returns The usable subset.
 */
export function normalizeSettings(raw: Record<string, unknown>): ChannelSettings {
  const settings: ChannelSettings = {}
  for (const key of ['mergeWindowMs', 'maxReplyChars', 'settleMs'] as const) {
    const value = raw[key]
    const ceiling = key === 'maxReplyChars' ? 200_000 : 3_600_000
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= ceiling) {
      settings[key] = Math.round(value)
    }
  }
  for (const key of ['autoReplyAttachments', 'requireConfirmation', 'allowCrossSessionNotify', 'allowGroups'] as const) {
    if (typeof raw[key] === 'boolean') settings[key] = raw[key] as boolean
  }
  if (typeof raw.presenceNote === 'string') settings.presenceNote = raw.presenceNote
  if (typeof raw.workingEmoji === 'string' && /^[A-Za-z0-9_]{0,40}$/.test(raw.workingEmoji)) {
    settings.workingEmoji = raw.workingEmoji
  }
  if (raw.permissionPreset === 'danger-full-access' || raw.permissionPreset === 'auto' || raw.permissionPreset === 'default') {
    settings.permissionPreset = raw.permissionPreset
  }
  if (Array.isArray(raw.allowedUsers)) {
    settings.allowedUsers = [
      ...new Set(
        raw.allowedUsers
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => /^ou_[A-Za-z0-9]+$/.test(entry)),
      ),
    ]
  }
  return settings
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
