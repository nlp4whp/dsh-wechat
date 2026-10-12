# dsh-lark-plugin

[![CI](https://github.com/xcisxc29/dsh-wechat/actions/workflows/ci.yml/badge.svg?branch=lark)](https://github.com/xcisxc29/dsh-wechat/actions/workflows/ci.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

用飞书遥控 DeepSeek Harness：手机上发消息，电脑上的 DSH 干活。

不需要公网 IP。消息经 [lark-cli](https://github.com/larksuite/cli) 的 WebSocket 长连接收发，本机主动连到飞书服务，外部不需要能访问到这台电脑。

> **本项目从 [dsh-wechat](https://github.com/xcisxc29/dsh-wechat) 迁移而来，在 `lark` orphan 分支单独开发，不含任何微信代码。**

---

## 能做什么

- **文字双向**：飞书消息变成 DSH 提示词，回复发回飞书（Markdown 渲染）
- **图片和文件**：双向。收到的附件落盘到会话工作区并交给 agent；agent 可用 `send_to_lark` 发文件回来
- **语音消息**：作为附件落盘，agent 可以打开
- **会话管理**：`/new` `/list` `/switch` `/current` `/cancel` 指令，或直接说大白话
- **手机回答权限与提问**：权限申请和多选提问发到飞书，回一个数字即可
- **任意会话主动推送**：`notify_lark` 工具，让任何会话都能把结果发到手机
- **设置页**：DSH 的**设置 → 飞书**

## 安装前提

1. 安装并配置好 [lark-cli](https://github.com/larksuite/cli)：
   ```bash
   npm i -g @larksuite/cli
   lark-cli install   # 跟着向导走
   ```

2. 在飞书开放平台建一个**自建应用**，开启**机器人**能力，在「事件订阅」里打开**长连接**并开启 `im.message.receive_v1` 事件，发布应用版本。

3. `lark-cli auth status` 确认 bot 身份是 `ready`。

## 安装插件

DSH 侧栏点**插件 → 添加插件**，填：

```
dsh-lark-plugin
```

点**立即启用**，重启 DSH。

或者从终端：

```bash
dsh plugin --profile desktop add dsh-lark-plugin
```

本地项目打包安装流程:

```bash
pnpm install
pnpm check          # build + typecheck + test
pnpm run pack       # → dsh-lark-plugin-0.1.0.tgz

dsh plugin --profile web add $PWD/dsh-lark-plugin-0.1.0.tgz
```

## 开始用

重启 DSH 后打开**设置 → 飞书**：

1. 如果 `lark-cli` 不在 DSH 的 PATH 里，填完整路径（终端里 `which lark-cli`）。
2. **允许的用户**：填你自己的 open_id（`ou_…`）。不知道？先给机器人发一条消息，它会告诉你。
3. 点**启用通道**，等流状态变成「接收中」。
4. 在飞书里给机器人发 `你好`，收到回复就通了。

## 指令

| 指令 | 作用 |
|---|---|
| `/new [标题]` | 新建对话 |
| `/list` | 列出近期对话（`/list all` 含其它工作区） |
| `/switch <编号>` | 切换对话 |
| `/current` | 显示当前对话 |
| `/cancel` | 中断当前任务 |
| `/help` | 指令列表 |

也可以直接说大白话，例如「换个对话」「停下」。

## 安全性

**白名单是唯一的安全边界。** 飞书应用可用范围内的所有人都可以私聊这个机器人，而 agent 以你的身份运行，所以白名单不能空着。未在白名单内的发送者会收到提示，并把他们的 open_id 告诉你，方便你添加。

**agent 以你的身份运行**，能执行命令、读写文件。交代任务后扫一眼再走，离开时锁屏（锁屏不影响 agent 干活）。

## 文档

| | |
|---|---|
| [docs/INTERNALS.md](docs/INTERNALS.md) | 实现原理、架构、两个包的区别 |

## 开发

```bash
pnpm install
pnpm build           # 编译 TS → JS
pnpm typecheck
pnpm test            # 85 项
pnpm check           # build + typecheck + test
pnpm run pack        # 先 build，再打 tarball
```

## 许可证

MIT — 见 [LICENSE](LICENSE)
