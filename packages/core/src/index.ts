/**
 * `@dsh-lark/core` — the Feishu/Lark side of the channel, with no DSH imports.
 *
 * All network work is delegated to `lark-cli`: an `event consume` subprocess holds the outbound
 * WebSocket long connection that delivers messages, and one-shot `im` commands send replies, files
 * and reactions. So a machine running DSH receives Feishu messages from anywhere without a tunnel,
 * a public address, or any inbound port, and the plugin never handles an app secret.
 *
 * @module @dsh-lark/core
 */

export * from './types.ts'
export * from './cli.ts'
export * from './channel.ts'
export * from './state.ts'
export * from './session-index.ts'
export {
  SessionRouter,
  mintSessionId,
  relativeTime,
  renderSessionList,
  renderSessionRow,
  resolveTarget,
  shortId,
  splitCommand,
  HELP_TEXT,
  type BindingStore,
  type RouteDecision,
  type RouteResult,
  type SessionBinding,
  type SessionGateway,
  type SessionRouterOptions,
} from './router.ts'
