/**
 * Wire shapes for the Feishu/Lark channel, as `lark-cli` emits them.
 *
 * The event shape is the *flattened* form `lark-cli event consume im.message.receive_v1` prints, not
 * the raw OpenAPI V2 envelope: lark-cli lifts the fields to the top level and pre-renders `content`
 * to readable text for every message type except interactive cards. Field list taken from
 * `lark-cli event schema im.message.receive_v1` (lark-cli 1.0.69).
 *
 * @module @dsh-lark/core/types
 */

/** One `im.message.receive_v1` event as printed on stdout, one JSON object per line. */
export interface LarkMessageEvent {
  /** Always `im.message.receive_v1`. */
  type?: string
  /** Delivery id. Not a dedup key; `message_id` is. */
  event_id?: string
  /** `om_…`. The idempotency key for this event. */
  message_id?: string
  /** `oc_…`. For a direct message this is the p2p chat with the bot. */
  chat_id?: string
  chat_type?: 'p2p' | 'group' | string
  /** `text`, `post`, `image`, `file`, `audio`, `media`, `sticker`, `interactive`, … */
  message_type?: string
  /**
   * Pre-rendered content. Plain text for text/post; resource placeholders such as
   * `![Image](img_xxx)` or `<file key="file_xxx" name="a.pdf"/>` for media; raw card JSON for
   * `interactive`.
   */
  content?: string
  /** `ou_…` open_id of the sender. No display name is included. */
  sender_id?: string
  sender_type?: 'user' | 'bot' | string
  /** Parent message of a reply, when the user quoted something. */
  reply_to?: string
  root_id?: string
  thread_id?: string
  create_time?: string
  mentions?: { id?: string; key?: string; name?: string }[]
}

/** One downloadable resource referenced by a message. */
export interface ResourceRef {
  /** `img_…` or `file_…`. */
  key: string
  /** What `+messages-resources-download --type` expects. Audio and video are `file`. */
  type: 'image' | 'file'
  /** What the user sent, for the agent's description. */
  kind: 'image' | 'file' | 'audio' | 'video'
  /** Original file name, when the placeholder carried one. */
  name?: string
  /** Audio duration as rendered (`3s`), when present. */
  duration?: string
}

/** The JSON envelope every lark-cli command prints. */
export interface CliEnvelope<T = unknown> {
  ok: boolean
  identity?: string
  data?: T
  error?: {
    type?: string
    subtype?: string
    message?: string
    hint?: string
    param?: string
    missing_scopes?: string[]
  }
}

/** Connection settings: which lark-cli to run, and as which profile. */
export interface LarkConnection {
  /** Executable to spawn. `lark-cli` resolved from PATH when absent. */
  cliPath?: string
  /** `--profile` for every call. lark-cli's current profile when absent. */
  profile?: string
}
