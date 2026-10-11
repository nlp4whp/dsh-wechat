/**
 * Route contract between the host half and the settings page.
 *
 * @module dsh-lark/routes
 */

/** Route prefix registered on the DSH web server. */
export const ROUTE_PREFIX = '/.dsh-lark-plugin'

/** `GET` — current channel status. */
export const ROUTE_STATUS = `${ROUTE_PREFIX}/status`

/** `POST { enabled }` — turn the channel on or off. */
export const ROUTE_TOGGLE = `${ROUTE_PREFIX}/toggle`

/** `POST { cliPath?, profile? }` — save the lark-cli connection and re-check it. */
export const ROUTE_CONNECTION = `${ROUTE_PREFIX}/connection`

/** `POST` — run `lark-cli auth status` again. */
export const ROUTE_CHECK = `${ROUTE_PREFIX}/check`

/** `GET` — tuned settings and their defaults; `POST` a patch to change them. */
export const ROUTE_SETTINGS = `${ROUTE_PREFIX}/settings`

/** `POST { scope, message, stack }` — record a client-side failure in the boot log. */
export const ROUTE_CLIENT_ERROR = `${ROUTE_PREFIX}/client-error`

/** Wire shape of the channel status. */
export interface ChannelStatus {
  /** Whether the channel is configured to run. */
  enabled: boolean
  connection: {
    cliPath: string
    profile: string
    appId?: string
    brand?: string
    /** Result of the last `auth status`: undefined before the first check. */
    botReady?: boolean
    checkMessage?: string
  }
  stream: {
    /** Between start and stop. */
    running: boolean
    /** Subscription live: lark-cli printed its ready marker. */
    ready: boolean
    lastError?: string
  }
  /** open_ids that messaged the bot but are not allowed, newest last, so they can be added. */
  rejectedSenders: string[]
  errors: string[]
  diagnostics: {
    logPath: string
    statePath: string
    workspace: string
    logTail: string[]
  }
}
