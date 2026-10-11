/**
 * Browser half of the settings page (Settings → 飞书).
 *
 * A client plugin bundle: the shell registers it through `window.__ModuleLoader__.load({ id,
 * factory })`, and the factory receives a `require` that resolves the platform baseline (React among
 * it). The page talks to the host half over the `/.dsh-lark-plugin` routes.
 *
 * The registration call runs bare at module scope on purpose: a guard would swallow the one failure
 * nothing else can report.
 */

const PREFIX = '/.dsh-lark-plugin'

/** Report a client-side failure to the host, which writes it to the boot log. */
function reportFailure(scope, error) {
  try {
    const payload = JSON.stringify({
      scope,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error && typeof error.stack === 'string' ? error.stack : '',
    })
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(`${PREFIX}/client-error`, new Blob([payload], { type: 'application/json' }))
      return
    }
    void fetch(`${PREFIX}/client-error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Reporting must never be the reason the page fails.
  }
}

window.__ModuleLoader__.load({
  id: 'dsh-lark-plugin',
  factory: (require) => {
    let mountedOnce = false
    try {
      setTimeout(() => {
        if (!mountedOnce) reportFailure('mount', new Error('插件已加载，但设置页在 20 秒内没有渲染（看门狗触发）'))
      }, 20_000)
    } catch {
      // A missing timer must not prevent loading.
    }

    const React = require('react')
    const h = React.createElement

    const copy = {
      zh: {
        nav: '飞书',
        title: '飞书遥控',
        intro: '用飞书遥控这台电脑。消息经 lark-cli 的长连接收发，不需要公网 IP。',
        groupConnection: '连接',
        groupConnectionHint: 'lark-cli 与事件流。',
        statusTitle: '启用通道',
        enabledHint: '打开后启动 lark-cli 事件流接收飞书消息；关掉即停止，配置保留。',
        cliPath: 'lark-cli 路径',
        cliPathHint: '留空则从 PATH 查找 lark-cli。DSH 桌面端的 PATH 可能不含 nvm 目录，找不到时填完整路径（终端里 `which lark-cli`）。',
        profile: 'lark-cli profile',
        profileHint: '留空用 lark-cli 当前 profile。对应 `lark-cli --profile <name>`。',
        saveConnection: '保存并检查',
        check: '重新检查',
        appId: '应用',
        botReady: 'bot 身份可用',
        botMissing: 'bot 身份不可用',
        notChecked: '尚未检查',
        streamReady: '接收中',
        streamStarting: '连接中',
        streamStopped: '已停止',
        streamLastError: '事件流最近错误',
        groupAccess: '访问控制',
        groupAccessHint: '谁可以通过飞书操作这台电脑。',
        allowedUsers: '允许的用户（open_id，每行一个）',
        allowedUsersHint:
          '必填。为空时任何人都不能用。agent 以你的身份运行，飞书应用可用范围内的同事都能私聊机器人，所以必须限定。不知道自己的 open_id：先给机器人发一条消息，它会回复你的 open_id，也会出现在下面。',
        rejected: '最近被拒绝的发送者',
        addRejected: '加入',
        allowGroups: '处理群聊消息',
        allowGroupsHint: '默认只处理私聊。打开后，白名单内的用户在群里 @机器人 也会被处理，回复发到群里。',
        groupBehaviour: '行为',
        groupBehaviourHint: '收到消息后怎么处理，改完生效，不用重启。',
        permissionPreset: '飞书对话的权限',
        permissionPresetHint: '默认「完全访问」，DSH 执行命令时不再问你。改这里只影响之后新建的对话。',
        permissionFull: '完全访问：不询问，直接执行',
        permissionAuto: '自动审核：电脑上判断',
        permissionProfile: '跟随 DSH 设置：和桌面端一样',
        allowCrossSessionNotify: '允许其他会话推送到飞书',
        allowCrossSessionNotifyHint: '开启后，任何会话都能用 notify_lark 发到你最近使用的飞书对话。',
        requireConfirmation: '指令操作前需要确认',
        requireConfirmationHint: '你说「换个对话」这类要求时，DSH 先说它要做什么，等你同意再执行。',
        workingEmoji: '处理中表情',
        workingEmojiHint: 'agent 处理时给你的消息加这个表情回复，回复后撤掉。飞书 emoji_type，如 Typing、OnIt、OneSecond；留空关闭。',
        mergeWindow: '非文字消息等待时间（秒）',
        mergeWindowHint: '等待期间你发文字，就和附件一起处理；超时则只处理附件。',
        autoReplyAttachments: '等不到文字就自动处理附件',
        autoReplyAttachmentsHint: '关闭后，附件一直等你发文字。',
        maxReplyChars: '回复长度上限（字）',
        maxReplyCharsHint: '超长回复改发 .md 文件，不截断。',
        settleMs: '回复合并窗口（毫秒）',
        settleMsHint: '流式输出间隔小于这个值就合并成一条。',
        presenceNote: '渠道身份提示',
        presenceNoteHint: '附在消息后，告诉 agent 你在飞书上。不建议清空。',
        settingsSave: '保存设置',
        settingsSaved: '已保存',
        settingsReset: '恢复默认',
        groupCommands: '指令',
        commandsHint: '在飞书里直接发送，不经过 agent。群聊里可以先 @机器人。也可以说大白话，例如「换个对话」。',
        groupDiagnostics: '诊断',
        logPath: '日志文件',
        statePath: '状态文件',
        workspacePath: '会话工作目录',
        logTail: '日志末尾',
        noLog: '（暂无日志）',
        errorsTitle: '最近错误',
        loading: '读取中…',
        loadFailed: '读取设置失败',
        retry: '重试',
        actionFailed: '操作失败',
      },
    }
    copy.en = copy.zh

    function text() {
      return copy.zh
    }

    async function request(path, options) {
      const response = await fetch(path, {
        cache: 'no-store',
        ...options,
        headers: {
          accept: 'application/json',
          ...(options?.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      })
      const raw = await response.text()
      let body
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        body = { error: raw.slice(0, 200) }
      }
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`)
      return body
    }

    const styles = `
.dsh-lark { display: flex; flex-direction: column; gap: 26px; max-width: 680px; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsh-lark h2 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.4; }
.dsh-lark h3 { margin: 0; font-size: 13px; font-weight: 500; line-height: 1.5; }
.dsh-lark p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }

/* Header: title above a single line of context, the way a settings page opens. */
.dsh-lark-header { display: flex; flex-direction: column; gap: 4px; }
.dsh-lark-lead { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }

/* Groups are plain bands with a small heading. The app has no boxed sections, so neither does
   this page: separation comes from spacing and a heading, not from a container. */
.dsh-lark-group { display: flex; flex-direction: column; gap: 4px; }
.dsh-lark-group-head { display: flex; align-items: baseline; gap: 8px; }
.dsh-lark-group-title { font-size: 12px; font-weight: 600; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dsh-lark-group-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsh-lark-group-body { display: flex; flex-direction: column; gap: 16px; }

/* A card is a subtle surface, not a bordered panel: 0.5px is the app's hairline everywhere. */
.dsh-lark-card { display: flex; flex-direction: column; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); padding: 4px 14px; background: var(--dsw-alias-bg-layer-2); }
.dsh-lark-card > h3 { padding: 12px 0 2px; font-size: 13px; font-weight: 600; }
/* A second heading inside one card separates two sub-sections, so it needs the room a first
   heading gets from the card's own edge. */
.dsh-lark-card > h3 ~ h3 { padding-top: 20px; }
.dsh-lark-card > p { padding-bottom: 6px; }

/* Rows and fields are the settings-form pattern: padded, with a hairline between them. */
.dsh-lark-row { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 12px 0; }
.dsh-lark-row-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-lark-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.dsh-lark-field > label { font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsh-lark-row + .dsh-lark-row,
.dsh-lark-field + .dsh-lark-field,
.dsh-lark-field + .dsh-lark-row,
.dsh-lark-row + .dsh-lark-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-lark-card > :first-child { padding-top: 12px; }
.dsh-lark-card > :last-child { padding-bottom: 12px; }

/* Switch: the shipped geometry, keyed off aria-checked so it cannot disagree with the state. */
.dsh-lark-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3); cursor: pointer; transition: background 120ms ease; }
.dsh-lark-switch::after { content: ''; display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-switch-thumb); transition: transform 120ms ease; }
.dsh-lark-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dsh-lark-switch[aria-checked='true']::after { background: var(--dsw-alias-label-primary-foreground); transform: translateX(16px); }
.dsh-lark-switch:disabled { cursor: default; opacity: .5; }
.dsh-lark-switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }

.dsh-lark-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 10px; border: 0; border-radius: var(--dsw-radius-sm); font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); background: transparent; cursor: pointer; }
.dsh-lark-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-lark-button:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.dsh-lark-button:disabled { cursor: not-allowed; opacity: .4; }
.dsh-lark-button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.dsh-lark-outline { border: 0.5px solid var(--dsw-alias-border-l3); }
/* The same button, rendered as an anchor so the shell's link handler picks it up. */
a.dsh-lark-button { text-decoration: none; }
.dsh-lark-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsh-lark-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsh-lark-danger { color: var(--dsw-alias-state-error-primary); border: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-lark-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }

.dsh-lark-input { box-sizing: border-box; height: 34px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsh-lark-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh-lark-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.dsh-lark-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dsh-lark-field input[type='number'], .dsh-lark-field input[type='text'] { max-width: 240px; }
.dsh-lark-field input[type='number'] { max-width: 104px; }
.dsh-lark-field textarea { box-sizing: border-box; padding: 8px 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-primary); min-height: 84px; resize: vertical; }
.dsh-lark-field textarea:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }

.dsh-lark-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 12px 0; }
.dsh-lark-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsh-lark-ok { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-success-primary); }
.dsh-lark-error { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.dsh-lark-errors { margin: 0; padding: 0 0 0 18px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }

/* Pills and badges follow Tag/Pill: capsule, token background, one size everywhere. */
.dsh-lark-pill { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border-radius: 999px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.dsh-lark-pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.dsh-lark-pill.is-warn::before { background: var(--dsw-alias-state-warn-primary); }
.dsh-lark-pill.is-ok::before { background: var(--dsw-alias-state-success-primary); }
.dsh-lark-badge { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; color: var(--dsw-alias-label-tertiary); border: 0.5px solid var(--dsw-alias-border-l4); }
.dsh-lark-badge.is-on { color: var(--dsw-alias-state-success-primary); border-color: transparent; background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }

.dsh-lark-qr { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px 0; }
.dsh-lark-qr img { width: 200px; height: 200px; image-rendering: pixelated; background: #fff; border-radius: var(--dsw-radius-lg); padding: 8px; }
.dsh-lark-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dsh-lark-list li { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 10px 0; font-size: 13px; }
.dsh-lark-list li + li { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-lark-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

.dsh-lark-log { max-height: 240px; overflow: auto; margin: 0; padding: 10px 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-all; }
/* Facts: a fixed label column so values line up instead of ragging right. */
.dsh-lark-facts { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; }
.dsh-lark-fact { display: grid; grid-template-columns: 92px 1fr; gap: 12px; align-items: baseline; font-size: 12px; }
.dsh-lark-fact > dt { color: var(--dsw-alias-label-tertiary); }
.dsh-lark-fact > dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.dsh-lark-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; text-align: right; }

/* The command reference: a definition list so a command and its meaning line up. */
.dsh-lark-commands { display: flex; flex-direction: column; margin: 0; padding: 0; }
.dsh-lark-command { display: grid; grid-template-columns: 132px 1fr; gap: 12px; align-items: baseline; padding: 8px 0; font-size: 12px; line-height: 1.6; }
.dsh-lark-command + .dsh-lark-command { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-lark-command > dt { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsh-lark-command > dd { margin: 0; color: var(--dsw-alias-label-secondary); }

.dsh-lark-link { border: 0; background: none; padding: 0; font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.dsh-lark-link:hover { color: var(--dsw-alias-label-primary); }
`

    function installStyles() {
      if (document.getElementById('dsh-lark-style') !== null) return () => {}
      const style = document.createElement('style')
      style.id = 'dsh-lark-style'
      style.textContent = styles
      document.head.append(style)
      return () => style.remove?.()
    }

    function Toggle(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled,
        className: 'dsh-lark-switch',
        onClick: () => {
          if (props.disabled !== true) props.onChange(!props.checked)
        },
      })
    }

    function Card(props) {
      return h('section', { className: 'dsh-lark-card' }, props.children)
    }

    function Group(props) {
      return h(
        'section',
        { className: 'dsh-lark-group' },
        h(
          'header',
          { className: 'dsh-lark-group-head' },
          h('h3', { className: 'dsh-lark-group-title' }, props.title),
          props.hint ? h('p', { className: 'dsh-lark-group-hint' }, props.hint) : null,
        ),
        h('div', { className: 'dsh-lark-group-body' }, props.children),
      )
    }

    function field(label, hint, control) {
      return h(
        'div',
        { className: 'dsh-lark-field' },
        h('label', null, label),
        control,
        hint ? h('span', { className: 'dsh-lark-hint' }, hint) : null,
      )
    }

    function row(label, hint, control) {
      return h(
        'div',
        { className: 'dsh-lark-row' },
        h('div', { className: 'dsh-lark-row-text' }, h('label', null, label), hint ? h('span', { className: 'dsh-lark-hint' }, hint) : null),
        control,
      )
    }

    function LarkSettings() {
      const [state, setState] = React.useState({
        phase: 'loading',
        error: '',
        status: undefined,
        settings: undefined,
        defaults: undefined,
        draft: undefined,
        connection: { cliPath: '', profile: '' },
        usersText: '',
        saved: false,
        busy: false,
      })
      mountedOnce = true
      const t = text()

      const load = React.useCallback(async () => {
        try {
          const [status, settings] = await Promise.allSettled([request(`${PREFIX}/status`), request(`${PREFIX}/settings`)]).then(
            (results) => results.map((result) => (result.status === 'fulfilled' ? result.value : undefined)),
          )
          if (status === undefined) throw new Error('status unavailable')
          setState((prev) => ({
            ...prev,
            phase: 'ready',
            error: '',
            status,
            settings: settings?.settings,
            defaults: settings?.defaults,
            draft: settings?.settings ?? prev.draft,
            usersText: (settings?.settings?.allowedUsers ?? []).join('\n'),
            connection: { cliPath: status.connection?.cliPath ?? '', profile: status.connection?.profile ?? '' },
          }))
        } catch (error) {
          reportFailure('load', error)
          setState((prev) => ({ ...prev, phase: 'error', error: error instanceof Error ? error.message : String(error) }))
        }
      }, [])

      const refreshStatus = React.useCallback(async () => {
        try {
          const status = await request(`${PREFIX}/status`)
          setState((prev) => ({ ...prev, status }))
        } catch {
          // Polling noise.
        }
      }, [])

      React.useEffect(() => {
        void load()
        // Status changes on its own (stream connects, a stranger messages the bot), so poll gently.
        const timer = setInterval(() => void refreshStatus(), 4000)
        const onFocus = () => void load()
        window.addEventListener?.('focus', onFocus)
        return () => {
          clearInterval(timer)
          window.removeEventListener?.('focus', onFocus)
        }
      }, [load, refreshStatus])

      async function post(path, body) {
        setState((prev) => ({ ...prev, busy: true, error: '' }))
        try {
          const result = await request(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
          setState((prev) => ({ ...prev, busy: false }))
          return result
        } catch (error) {
          setState((prev) => ({ ...prev, busy: false, error: error instanceof Error ? error.message : String(error) }))
          return undefined
        }
      }

      async function toggle(enabled) {
        const status = await post(`${PREFIX}/toggle`, { enabled })
        if (status !== undefined) setState((prev) => ({ ...prev, status }))
      }

      async function saveConnection() {
        const status = await post(`${PREFIX}/connection`, state.connection)
        if (status !== undefined) setState((prev) => ({ ...prev, status }))
      }

      async function check() {
        const status = await post(`${PREFIX}/check`, {})
        if (status !== undefined) setState((prev) => ({ ...prev, status }))
      }

      function parseUsers(textValue) {
        return textValue
          .split(/[\s,，]+/)
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '')
      }

      async function saveSettings(extra) {
        if (state.draft === undefined) return
        const body = { ...state.draft, allowedUsers: parseUsers(state.usersText), ...(extra ?? {}) }
        const result = await post(`${PREFIX}/settings`, body)
        if (result?.settings === undefined) return
        setState((prev) => ({
          ...prev,
          saved: true,
          settings: result.settings,
          draft: result.settings,
          usersText: result.settings.allowedUsers.join('\n'),
        }))
        setTimeout(() => setState((prev) => ({ ...prev, saved: false })), 2500)
      }

      function addRejected(openId) {
        const users = [...new Set([...parseUsers(state.usersText), openId])]
        setState((prev) => ({ ...prev, usersText: users.join('\n') }))
        void saveSettings({ allowedUsers: users })
      }

      function edit(key, value) {
        setState((prev) => ({ ...prev, draft: { ...(prev.draft ?? {}), [key]: value } }))
      }

      if (state.phase === 'loading') return h('div', { className: 'dsh-lark' }, h('p', null, t.loading))
      if (state.phase === 'error') {
        return h(
          'div',
          { className: 'dsh-lark' },
          h('p', { className: 'dsh-lark-error', role: 'alert' }, `${t.loadFailed}: ${state.error}`),
          h('button', { type: 'button', className: 'dsh-lark-button dsh-lark-outline', onClick: () => void load() }, t.retry),
        )
      }

      const status = state.status
      const conn = status.connection ?? {}
      const stream = status.stream ?? {}
      const streamLabel = stream.ready ? t.streamReady : stream.running ? t.streamStarting : t.streamStopped
      const streamClass = stream.ready ? 'is-ok' : stream.running ? 'is-warn' : ''
      const authLabel = conn.botReady === undefined ? t.notChecked : conn.botReady ? t.botReady : t.botMissing
      const draft = state.draft
      const allowedCount = parseUsers(state.usersText).length

      return h(
        'div',
        { className: 'dsh-lark' },
        h('div', { className: 'dsh-lark-header' }, h('h2', null, t.title), h('p', { className: 'dsh-lark-lead' }, t.intro)),
        state.error ? h('p', { className: 'dsh-lark-error', role: 'alert' }, `${t.actionFailed}: ${state.error}`) : null,

        h(
          Group,
          { title: t.groupConnection, hint: t.groupConnectionHint },
          h(
            Card,
            null,
            row(
              t.statusTitle,
              t.enabledHint,
              h(Toggle, { checked: status.enabled === true, label: t.statusTitle, disabled: state.busy, onChange: (next) => void toggle(next) }),
            ),
            h(
              'div',
              { className: 'dsh-lark-actions' },
              h('span', { className: `dsh-lark-pill ${streamClass}` }, streamLabel),
              h('span', { className: `dsh-lark-pill ${conn.botReady ? 'is-ok' : conn.botReady === false ? 'is-warn' : ''}` }, authLabel),
              conn.appId ? h('span', { className: 'dsh-lark-mono' }, `${t.appId} ${conn.appId}${conn.brand ? ` (${conn.brand})` : ''}`) : null,
            ),
            conn.checkMessage && conn.botReady !== true ? h('p', { className: 'dsh-lark-error' }, conn.checkMessage) : null,
            stream.lastError ? h('p', { className: 'dsh-lark-error' }, `${t.streamLastError}: ${stream.lastError}`) : null,
            field(
              t.cliPath,
              t.cliPathHint,
              h('input', {
                type: 'text',
                className: 'dsh-lark-input',
                placeholder: 'lark-cli',
                value: state.connection.cliPath,
                onChange: (event) => setState((prev) => ({ ...prev, connection: { ...prev.connection, cliPath: event.target.value } })),
              }),
            ),
            field(
              t.profile,
              t.profileHint,
              h('input', {
                type: 'text',
                className: 'dsh-lark-input',
                value: state.connection.profile,
                onChange: (event) => setState((prev) => ({ ...prev, connection: { ...prev.connection, profile: event.target.value } })),
              }),
            ),
            h(
              'div',
              { className: 'dsh-lark-actions' },
              h('button', { type: 'button', className: 'dsh-lark-button dsh-lark-primary', disabled: state.busy, onClick: () => void saveConnection() }, t.saveConnection),
              h('button', { type: 'button', className: 'dsh-lark-button dsh-lark-outline', disabled: state.busy, onClick: () => void check() }, t.check),
            ),
          ),
        ),

        draft !== undefined
          ? h(
              Group,
              { title: t.groupAccess, hint: t.groupAccessHint },
              h(
                Card,
                null,
                field(
                  t.allowedUsers,
                  t.allowedUsersHint,
                  h('textarea', {
                    rows: 3,
                    placeholder: 'ou_xxxxxxxx',
                    value: state.usersText,
                    onChange: (event) => setState((prev) => ({ ...prev, usersText: event.target.value })),
                  }),
                ),
                allowedCount === 0 ? h('p', { className: 'dsh-lark-error' }, '当前白名单为空：所有人的消息都会被拒绝。') : null,
                (status.rejectedSenders ?? []).length > 0
                  ? h(
                      'div',
                      null,
                      h('h3', null, t.rejected),
                      h(
                        'ul',
                        { className: 'dsh-lark-list' },
                        ...status.rejectedSenders.map((openId) =>
                          h(
                            'li',
                            { key: openId },
                            h('span', { className: 'dsh-lark-mono' }, openId),
                            h(
                              'button',
                              { type: 'button', className: 'dsh-lark-button dsh-lark-outline', disabled: state.busy, onClick: () => addRejected(openId) },
                              t.addRejected,
                            ),
                          ),
                        ),
                      ),
                    )
                  : null,
                row(t.allowGroups, t.allowGroupsHint, h(Toggle, { checked: draft.allowGroups === true, label: t.allowGroups, disabled: state.busy, onChange: (next) => edit('allowGroups', next) })),
                h(
                  'div',
                  { className: 'dsh-lark-actions' },
                  h('button', { type: 'button', className: 'dsh-lark-button dsh-lark-primary', disabled: state.busy, onClick: () => void saveSettings() }, t.settingsSave),
                  state.saved ? h('span', { className: 'dsh-lark-ok' }, t.settingsSaved) : null,
                ),
              ),
            )
          : null,

        draft !== undefined
          ? h(
              Group,
              { title: t.groupBehaviour, hint: t.groupBehaviourHint },
              h(
                Card,
                null,
                field(
                  t.permissionPreset,
                  t.permissionPresetHint,
                  h(
                    'select',
                    { className: 'dsh-lark-input', value: draft.permissionPreset ?? 'danger-full-access', onChange: (event) => edit('permissionPreset', event.target.value) },
                    h('option', { value: 'danger-full-access' }, t.permissionFull),
                    h('option', { value: 'auto' }, t.permissionAuto),
                    h('option', { value: 'default' }, t.permissionProfile),
                  ),
                ),
                row(t.allowCrossSessionNotify, t.allowCrossSessionNotifyHint, h(Toggle, { checked: draft.allowCrossSessionNotify === true, label: t.allowCrossSessionNotify, disabled: state.busy, onChange: (next) => edit('allowCrossSessionNotify', next) })),
                row(t.requireConfirmation, t.requireConfirmationHint, h(Toggle, { checked: draft.requireConfirmation === true, label: t.requireConfirmation, disabled: state.busy, onChange: (next) => edit('requireConfirmation', next) })),
                field(t.workingEmoji, t.workingEmojiHint, h('input', { type: 'text', className: 'dsh-lark-input', value: draft.workingEmoji ?? '', onChange: (event) => edit('workingEmoji', event.target.value) })),
                field(
                  t.mergeWindow,
                  t.mergeWindowHint,
                  h('input', { type: 'number', min: 0, max: 600, className: 'dsh-lark-input', value: Math.round((draft.mergeWindowMs ?? 0) / 1000), onChange: (event) => edit('mergeWindowMs', Number(event.target.value) * 1000) }),
                ),
                row(t.autoReplyAttachments, t.autoReplyAttachmentsHint, h(Toggle, { checked: draft.autoReplyAttachments === true, label: t.autoReplyAttachments, disabled: state.busy, onChange: (next) => edit('autoReplyAttachments', next) })),
                field(t.maxReplyChars, t.maxReplyCharsHint, h('input', { type: 'number', min: 0, className: 'dsh-lark-input', value: draft.maxReplyChars ?? 0, onChange: (event) => edit('maxReplyChars', Number(event.target.value)) })),
                field(t.settleMs, t.settleMsHint, h('input', { type: 'number', min: 0, className: 'dsh-lark-input', value: draft.settleMs ?? 0, onChange: (event) => edit('settleMs', Number(event.target.value)) })),
                field(t.presenceNote, t.presenceNoteHint, h('textarea', { rows: 4, value: draft.presenceNote ?? '', onChange: (event) => edit('presenceNote', event.target.value) })),
                h(
                  'div',
                  { className: 'dsh-lark-actions' },
                  h('button', { type: 'button', className: 'dsh-lark-button dsh-lark-primary', disabled: state.busy, onClick: () => void saveSettings() }, t.settingsSave),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-lark-button dsh-lark-outline',
                      disabled: state.busy || state.defaults === undefined,
                      // Reset behaviour only; the allowlist is not a "default" to fall back to.
                      onClick: () => setState((prev) => ({ ...prev, draft: { ...prev.defaults, allowedUsers: prev.draft?.allowedUsers ?? [] } })),
                    },
                    t.settingsReset,
                  ),
                  state.saved ? h('span', { className: 'dsh-lark-ok' }, t.settingsSaved) : null,
                ),
              ),
            )
          : null,

        h(
          Group,
          { title: t.groupCommands },
          h(
            Card,
            null,
            h('span', { className: 'dsh-lark-hint' }, t.commandsHint),
            h(
              'dl',
              { className: 'dsh-lark-commands' },
              ...[
                ['/help', '显示指令列表'],
                ['/new [标题]', '新建对话，可带标题'],
                ['/list', '列出对话（/list all 含其它工作区）'],
                ['/switch <编号>', '切换到第 N 个对话'],
                ['/current', '显示当前对话'],
                ['/cancel', '中断当前任务'],
              ].map(([cmd, desc]) => h('div', { key: cmd, className: 'dsh-lark-command' }, h('dt', null, cmd), h('dd', null, desc))),
            ),
          ),
        ),

        h(
          Group,
          { title: t.groupDiagnostics },
          h(
            Card,
            null,
            h(
              'dl',
              { className: 'dsh-lark-facts' },
              h('div', { className: 'dsh-lark-fact' }, h('dt', null, t.logPath), h('dd', null, status.diagnostics.logPath)),
              h('div', { className: 'dsh-lark-fact' }, h('dt', null, t.statePath), h('dd', null, status.diagnostics.statePath)),
              h('div', { className: 'dsh-lark-fact' }, h('dt', null, t.workspacePath), h('dd', null, status.diagnostics.workspace)),
            ),
            h('h3', null, t.logTail),
            h('pre', { className: 'dsh-lark-log' }, (status.diagnostics.logTail ?? []).length === 0 ? t.noLog : status.diagnostics.logTail.slice(-60).join('\n')),
          ),
          status.errors.length > 0
            ? h(
                Card,
                null,
                h('h3', null, t.errorsTitle),
                h('ul', { className: 'dsh-lark-errors' }, ...status.errors.slice(-6).map((line, index) => h('li', { key: index }, line))),
              )
            : null,
        ),
      )
    }

    /** Cordis plugin name. Matches the package name and the Host patch row id. */
    const name = 'dsh-lark-plugin'

    /** `slots` must be injected, or the plugin activates before the slot registry exists. */
    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(() => {
        const removeStyles = installStyles()
        const disposeSection = ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'lark',
              order: 41,
              label: () => text().nav,
              inject: () => ({}),
            },
            LarkSettings,
          ),
        )
        return () => {
          if (typeof disposeSection === 'function') disposeSection()
          removeStyles()
        }
      })
    }

    return { name, inject, apply }
  },
})
