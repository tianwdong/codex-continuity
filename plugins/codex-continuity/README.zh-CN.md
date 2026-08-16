<p align="center">
  <img src="./assets/logo.png" alt="Codex Continuity" width="112" />
</p>

<h1 align="center">Codex Continuity</h1>

<p align="center"><strong>继续正确的任务，保留已经建立的上下文。</strong></p>

<p align="center">
  一个轻量、本地优先的 Codex 插件。<br />
  它帮你回到那个已经懂上下文的任务，看清工作进展，并在需要拆分时选择合适的 Codex 原生方式。
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./LICENSE">MIT License</a> ·
  <a href="./PRIVACY.md">隐私边界</a> ·
  <a href="https://github.com/tianwdong/codex-continuity/issues">问题反馈</a>
</p>

<p align="center">
  <img alt="平台：macOS 与 Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-111111" />
  <img alt="Codex 插件" src="https://img.shields.io/badge/Codex-plugin-0A7AFF" />
  <img alt="本地优先" src="https://img.shields.io/badge/data-local--first-2E8B57" />
  <img alt="许可证：MIT" src="https://img.shields.io/badge/license-MIT-EA7A16" />
</p>

> [!IMPORTANT]
> Codex Continuity 不是另一套任务管理器，也不要求你再维护一份清单。任务仍在 Codex，文件仍在原项目里；它只帮你找到上下文在哪里，以及工作后来推进到了哪里。

## 让 Codex 帮你安装

把下面这段话直接发给 Codex：

```text
请从下面的仓库安装 Codex Continuity 插件：
https://github.com/tianwdong/codex-continuity

请使用仓库里的 Codex Marketplace 完成安装。安装完成后，告诉我什么时候重启 Desktop，并引导我审核插件的 Hook。
```

安装后，按 Codex 的提示重启 Desktop，并审核、信任 **Codex Continuity**。第一次使用不需要记任何安装命令。

<details>
<summary>想自己用命令安装？</summary>

```bash
codex plugin marketplace add tianwdong/codex-continuity
codex plugin add codex-continuity@codex-continuity
```

重启 Desktop，然后在 Hook 管理页审核并信任 **Codex Continuity**。仓库 Marketplace 只会安装白名单内的 `plugins/codex-continuity/` 插件包。

</details>

## Continuity 会在四件事上帮你

前两项会自然融入日常使用；后两项只在你主动询问「该怎么继续」时出现。

### 1．继续那个已经懂这件事的任务 · 核心

当你在一个项目里新建任务时，Continuity 会先看看是否已经有一个任务掌握了你需要的上下文。如果只有一个明确候选，它会建议你「继续旧任务」或「留在这里」；如果判断不清，它就不打扰。

### 2．一眼看出每个任务后来做成了什么 · 核心

Codex 会根据第一句话生成标题，但后面的工作可能已经换了方向。Continuity 会在本地保留一条简短进展，并且只在工作章节明显变化时维护原生标题。你随时可以查看、撤销、锁定或恢复自动标题维护。

### 3．判断该留在这里、开分支还是新建任务 · 按需

当你主动询问是否应该拆分工作时，Continuity 只推荐一种 Codex 原生方式：留在当前任务、使用子智能体、创建聊天分支，或新建任务。它会说明理由，并等你确认。

### 4．选择合适的子智能体 · 按需

当你决定委派后，Continuity 可以同时给出主代理和子代理的档位建议。主代理是否切换仍由你决定；只有你批准委派时，子代理配置才会生效。建议可以参考 [ModelDial Radar](https://modeldial.com/radar) 的最新公开快照，但不会把你的请求、代码、任务标题、项目目录、当前配置、凭据或遥测发送给 ModelDial。

## 推荐的工作方式

**一个稳定的项目文件夹 → 几条按结果划分的任务 → 回到那个已经懂上下文的任务。**

- 共享文件和背景的工作，放在同一个稳定项目文件夹里。一个产品的 App、网页端和后端可以共用同一个项目根目录。
- 按「想得到的结果」拆任务，不要因为换了文件、技术层或做了一个小修复就新建任务。
- 新请求依赖已有上下文时，继续原任务；目标能够独立说明、独立完成时，再新建任务。
- 查天气、改一句话这类一次性请求仍然可以不选项目。没有可靠的项目边界时，Continuity 会主动放弃自动匹配，避免乱推荐。
- 不要求维护 `ROADMAP.md`、标签、手工状态或第二套任务系统。

<details>
<summary>为什么项目根目录最好保持一致？</summary>

自动匹配会把「完全相同且非空的工作目录」当作项目边界。如果今天从仓库根目录打开，明天从里面的 `app/` 子目录打开，系统会把它们视为两个不同边界，匹配效果就会下降。这条严格规则可以避免把语言相似、实际无关的项目混在一起。

这也符合 [Codex 原生项目](https://learn.chatgpt.com/docs/projects)的使用方式：长期工作和共享文件放在同一个项目里，再为每个独立结果建立一条任务。

</details>

## 一个具体例子

Codex 会根据第一轮请求生成标题，但真实工作会继续变化。一个最初名为**「接入 Google Analytics」**的任务，后来可能已经变成 Cloudflare 费用排查。一周之后，旧标题已经无法告诉你：真正需要的上下文到底在哪个任务里。

```text
原生初始标题    接入 Google Analytics
后来真实进展    Cloudflare 费用止损已验证
Continuity 标题 Cloudflare 费用｜止损验证
```

Continuity 用这层语义连续性解决问题，不增加看板、收件箱、标签、优先级或另一套项目数据库。

## 两个自动发生的时刻

### 发出第一句话前：看看已有任务是否能接着做

你照常用自然语言描述目标。只有在真正的新任务首次输入时，Continuity 才复核同一项目边界里的旧任务。

- 没有可靠候选：原请求正常继续。
- 候选不唯一：原请求正常继续。
- 只有一个高置信候选：建议你选择「继续旧任务」或「留在这里」。

未经用户选择，它不会另发消息、跳转、归档、创建分支或合并任务。

### 一轮工作结束后：让进展重新可辨认

首次标题仍由 Codex 原生生成。后续每轮结束时，异步 `Stop` Hook 只读取最终回复的有限内容，提取当前工作章节、一条有证据的短进展，以及任务是否真的已经变化到值得更新标题。

只有章节明确变化时才可能改名。小修复、重复结论、未完成工作、证据不足或模型失败都不会触碰标题。自动标题可以撤销，也可以按任务锁定。

## 只在两个时刻帮你一下

<p align="center">
  <img src="./assets/continuity-flow-zh-CN.svg" alt="说出想做什么，看看是否已经做过，在 Codex 继续工作，再让结果下次一眼就能找到。" width="1200" />
</p>

没有需要清空的收件箱，没有需要维护的看板，也没有需要学习的状态分类。

## 使用

日常使用不需要记命令。

1. 新建任务，照常用自然语言描述目标。
2. 如果 Continuity 找到一个可靠的已有上下文，选择继续它或留在新任务。
3. 等 Codex 完成一轮工作。Continuity 会在本地记录一条短进展，并且只在章节明确变化时维护标题。

你也可以直接用自然语言说：

```text
查看当前任务最近完成了什么。
撤销上次自动改名。
保留这个标题，不要再自动更新。
恢复自动更新标题。
```

## 按需选择工作方式的细节

Continuity 不会为普通请求弹出工作流菜单。只有你明确询问是否应该拆分、并行或换一个任务时，按需 Skill 才会推荐一种 Codex 原生承载方式：

| 场景 | 推荐的原生承载方式 |
| --- | --- |
| 有界、独立，结果应立即回到当前任务 | 子智能体 |
| 继承当前上下文，但以后需要单独回来继续 | 聊天分支 |
| 不需要当前上下文 | 新任务 |
| 其他情况 | 留在当前任务 |

建议可以拒绝。在你授权原生动作之前，Continuity 不会创建子智能体、分支或新任务。

当子智能体适合当前任务时，可选的委派 Skill 会先用 Codex 模型角色缩小候选家族，再按需读取 [ModelDial Radar](https://modeldial.com/radar) 的最新公开快照，在对应家族中选择档位。它会同时说明主代理和子代理建议，但不会自动切换主代理，也不会向 ModelDial 发送请求内容、代码、任务标题、工作目录、当前配置、凭据或遥测。

## 兼容性

- macOS 或 Windows 11
- 较新的 Codex 或 ChatGPT Desktop
- 已在 Codex 中配置可用的模型与登录状态

标题和进展维护依赖异步 `Stop` Hook。macOS 路径已在 Desktop 内置 `codex 0.148.0-alpha.9` 验证。Windows 使用官方 `commandWindows` Hook 覆盖、原生 PowerShell，并优先复用 Desktop 内置的 Node／Codex runtime。独立 `codex 0.146.1` 会加载首轮匹配，但会跳过异步 `Stop` Hook。如果首轮匹配生效而标题始终不更新，请先升级 Desktop。

## 隐私与控制

- **没有 Continuity 后端：**不需要 Continuity 账号，也不上报任务内容遥测。
- **不复制凭据：**语义判断复用用户已经在 Codex 配置的 provider 和登录状态；插件不读取 API key、Token 或 Codex 登录数据库。
- **上下文有界：**标题维护只使用当前标题、上一条短进展和本轮最终回复的有限内容。
- **只匹配同目录：**自动匹配最多复核 3 个完全相同且非空工作目录的候选，并且最多读取它们最近 2 轮的用户输入与最终回复。
- **本地小账本：**只保存 ID、短章节、短进展、置信度和控制状态，不保存完整请求或对话。
- **行为可逆：**建议不强迫跳转，自动改名可以撤销、锁定和恢复。

本地状态位于当前用户的平台数据目录：

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/Codex Continuity Plugin/` |
| Windows | `%LOCALAPPDATA%\Codex Continuity Plugin\` |
| WSL／Linux | `${XDG_STATE_HOME:-~/.local/state}/codex-continuity-plugin/` |

macOS 与 Linux 使用目录权限 `0700`、文件权限 `0600`；Windows 使用当前用户 `LOCALAPPDATA` 的访问控制。完整边界见 [PRIVACY.md](./PRIVACY.md)。

## 原生优先的技术路线

Continuity 复用 Codex 已有能力，而不是重新实现一套会话系统。

| 时机 | 原生事实源 | Continuity 补充什么 | 失败时 |
| --- | --- | --- | --- |
| 新任务首次输入 | `UserPromptSubmit`、原生任务列表和任务读取 | 复核最多 3 个同目录候选 | 静默执行原请求 |
| 用户明确询问工作拆分 | 插件 Skill、原生任务与子智能体工具 | 只推荐一种承载方式 | 留在当前任务 |
| 一轮工作完成 | 异步 `Stop` Hook、`turn_id`、最终回复 | 提取章节与进展，必要时请求改名 | 保留现有标题和进展 |
| 用户主动控制 | 插件 Skill | 查看、撤销、锁定或恢复标题维护 | 不改变任务 |

语义模型只做有界判断，不拥有任务状态。Codex App Server 仍是任务、血缘、读取和标题操作的权威来源。所有不确定路径都失败关闭。

## 刻意不做什么

Continuity 有意不提供：

- 看板、收件箱、优先级、截止日期或第二套项目数据库；
- 手工标签和维护任务状态的仪式；
- 自动跳转、归档、创建分支、合并或创建子智能体；
- 未经用户明确要求的跨目录匹配；
- 对官方 App 或 `app.asar` 的修改；
- 一套取代 Codex 原生任务列表的自定义界面。

当前技术限制：

- macOS 已在真实 Desktop 验证；Windows 原生路径已有自动化契约覆盖，但在取消 beta 标记前仍需一次真实 Windows Desktop 验收；
- `thread/name/set` 的跨连接变化不一定立即广播，原生侧边栏标题可能延迟刷新；
- Codex 关闭任务时，尚未结束的后台 Hook 可能被取消；
- 官方 Plugin UI 还没有稳定的侧边栏自定义任务行或动作插槽；
- 聊天分支的「回流」是把结果报告给父任务，不是物理合并聊天历史。

## 开发

```bash
git clone https://github.com/tianwdong/codex-continuity.git
cd codex-continuity
npm start
```

`npm start` 会校验全部 Skill，并把同一份白名单插件构建到：

```text
dist/plugin/codex-continuity
plugins/codex-continuity
```

运行发布检查：

```bash
npm run validate:skills
npm test
npm run build:plugin
```

在 macOS 本地开发安装：

```bash
npm run install:plugin:dev -- --wait
```

随后退出 Codex／ChatGPT。安装器会等待主 App 退出、重新构建和安装插件，并核对 manifest、文件清单和每个文件的 SHA-256。不要直接写入 `~/.codex/plugins/cache/`。

## 仓库结构

- `.codex-plugin/plugin.json`：插件清单。
- `hooks/hooks.json`：`UserPromptSubmit` 与 `Stop` 生命周期入口。
- `skills/`：上下文匹配、工作路由、子智能体委派和标题控制。
- `src/plugin-*.mjs`：首轮 marker、语义判断、进展账本与标题运行时。
- `scripts/build-plugin.sh`：基于白名单生成插件产物。
- `scripts/run-plugin-node.ps1`：Windows 原生 Hook 与标题控制启动器。
- `plugins/codex-continuity/`：仓库 Marketplace 实际安装的白名单插件包。

## 公开文档

- [隐私说明](./PRIVACY.md)
- [安全政策](./SECURITY.md)
- [贡献指南](./CONTRIBUTING.md)
- [MIT License](./LICENSE)

## 许可证

Codex Continuity 使用 [MIT License](./LICENSE) 开源。
