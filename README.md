# 开发小队（Dev Team）模式

一个可直接分享的 DSH **bundle**，把「开发小队」模式编排和角色模型选择器装在一起：

- 预设编排：`dev-team`（显示名「开发小队（Dev Team）」），A/B/C 角色固定子代理团队；
- 角色模型选择：会话输入框旁的「开发小队」chip，可分别选择
  **Planner / Coder / Reviewer** 的模型，未选择的角色跟随当前会话模型；
- Host + 浏览器两半都在本包内，无构建步骤、无第三方运行时依赖。

| 项目 | 值 |
|---|---|
| 预设 id | `dev-team`（`order: 90`） |
| 角色子预设 | `dev-team-role-planner` / `dev-team-role-coder` / `dev-team-role-reviewer` |
| bundle 包名 | `dsh-dev-team-bundle` |
| 目标 DSH | `0.2.1-rc.3` 及以上（已在 0.2.1-rc.3 验证） |
| 当前版本 | `1.4.1` |
| 旧版变体预设 id | `dev-team+coder:<provider>@<model>`（仅兼容历史会话，不再注册） |

> **1.4.1**：修复 persona 模板误用未注册的 `{{cwd}}` 变量，导致会话第一轮
> 组装 system prompt 时报 `unknown prompt variable "{{cwd}}"`。当前工作目录由
> runtime context 提供，不需要模板变量。

## 与 standard 预设的差异

1. **persona** — 监督者（Manager）编排契约内化进预设：目标牵引、结果考核、A/B/C 分工、
   Phase 0 意图与规格锁定、迭代流水线、SPEC GAP 回流。项目测试/验收命令不写死，
   由 Phase 0 确定并记入 `TASK.md`。三个角色的 persona 放在各自的**角色子预设**里
   （DSH 0.2.1 起 `dsh-tool-subagent` 不再接收 `persona` 配置）。
2. **delegation** — 通用 `subagent` / `subagent_fork` 被三个角色固定工具取代：
   - `delegate_planner`（A 类：计划与验收）
   - `delegate_coder`（B 类：编码实现）
   - `delegate_reviewer`（C 类：用户代言）

   每个工具用 `agentPreset` 选定对应的角色子预设；控制类工具保留
   （`send_message` / `list_agents` / `interrupt_agent`），`maxDepth: 2`
   （监督者 = 0，角色子代理可再下钻一层）。
3. **角色模型** — 三个角色都可以按会话单独选模型；默认全部跟随会话模型。
   - 选中的角色使用用户在 chip 里指定的 `provider/model`；
   - 没选的（或选回「跟随会话模型」的）角色继承当前会话模型；
   - 选择对之后发起的委派生效，已在运行的子代理保持启动时的模型。

其余插件行以 stock `standard` 预设为基线（已对 DSH 0.2.1-rc.3 的
`@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 核对；本模式刻意不带
`time-context` / `tool-schedule` / `tool-plugin-market` 这几行新增工具）。

## 每轮对话分别选择三个角色模型

会话使用「开发小队」预设时，输入框左侧工具区、**权限选项旁边**会多出一枚 chip：

```
[＋] [权限] [计划] [开发小队  1/3 已选 ▾]
```

点开后先看到角色总览（向上弹出）：

```
开发小队 · 角色模型
未选择的角色跟随会话模型（当前 kimi / kimi-k3.1-pro）

(A) Planner    计划与验收      跟随会话        ›
(B) Coder      编码实现        deepseek-official / deepseek-chat  ›
(C) Reviewer   用户代言        跟随会话        ›

对之后发起的委派生效；已启动的子代理保持原模型
```

点任意角色进入该角色的模型列表（来自 `remote.session.modelCatalog()`，
即用户当前的模型配置）：

```
‹ 全部角色
Coder · 编码实现
当前：deepseek-official / deepseek-chat

跟随会话模型（默认）
DEEPSEEK-OFFICIAL
  DeepSeek Chat          ← 当前选择
  DeepSeek Reasoner
OPENAI
  GPT-5
对之后发起的委派生效
```

- **未选择** = 跟随会话模型；选择「跟随会话模型（默认）」可清除该角色的覆盖。
- chip 上的 `1/3 已选` 表示三个角色里有几个覆盖了会话模型；`0/3` 显示为「跟随会话」。
- 三个角色互不影响，可以只改 Coder，也可以三个都改。
- 模型目录是 Host 当前可路由的模型；如果某模型后来不可用，委派会在 LLM preflight
  阶段报错，而不是静默降级。

## 命令

chip 最终调用 Host 命令；也可以直接在输入框输入：

```sh
/devteam-model                                  # 查看三个角色当前选择
/devteam-model coder                            # 查看单个角色
/devteam-model planner <provider>/<model>       # 选择 Planner 模型
/devteam-model coder <provider>/<model>         # 选择 Coder 模型
/devteam-model reviewer <provider>/<model>      # 选择 Reviewer 模型
/devteam-model coder default                    # 清除覆盖，跟随会话模型
/devteam-model all default                       # 三个角色全部跟随会话模型
```

`<provider>@<model>` 写法也接受。旧版的 coder 命令保留为兼容别名：

```sh
/devteam-coder                                  # 查看 Coder
/devteam-coder <provider>/<model>               # 等价于 /devteam-model coder ...
/devteam-coder default                          # 等价于 /devteam-model coder default
```

## 实现（为什么这样选）

### 路由注入

三个 delegate 工具都使用 DSH 原生 `spawn` provider，并通过 `agentPreset` 固定角色。
DSH 0.2.1 的委派入口是 `subagents.startActivation(spec)`，`spec.request.agentPreset`
就是工具配置里的角色子预设 id。Host half 在调用原方法前：

1. 按 `spec.request.agentPreset` 识别 `planner` / `coder` / `reviewer`；
2. 从当前会话的 `devTeamModels` 投影读出该角色的选择；
3. 把 `{ provider, model }` 合并进 `spec.request.agentOptions`。

因此：

- 不需要按模型注册「预设变体」——模式选择器里只有一条「开发小队」；
- 子代理工具仍是 DSH 原生的 `@deepseek-ai/dsh-tool-subagent`，工具卡片、角色
  persona（放在子预设里）、`maxDepth`、continuable / `send_message` 语义不变；
- 角色子代理再往下委派 helper 时，会沿 `parentSession` 链向上找到根会话的选择，
  所以 helper 也遵循同一套角色路由；
- 旧预设（1.3.x）的 coder 行使用的 `dev-team-coder` 别名 provider 仍保留注册，
  只为还没重启的旧会话转发到 `spawn`；新预设不再引用它。

### 选择结果的持久化

**没有新增自定义 session 事件类型。** DSH 的持久化读取器只接受内置事件类型
（或带 `ignorable` 标记的插件记录）；第三方事件直接写进 session log 会让会话
在重启/恢复时被拒绝读取。因此选择结果依附在命令自身的生命周期事件上：

1. `/devteam-model ...` 先追加 `command/run`（`args` 里带着角色和路由）；
2. 命令成功后追加 `command/done`；
3. Host 的 `devTeamModels` 投影在 `command/run` 时暂存意图，在成功
   `command/done` 时落地；失败/取消则丢弃；
4. 会话恢复时，投影随日志重放，选择自动回来——不需要 sidecar 文件，
   也不需要额外的存储服务。

这样还有一个好处：会话导出、分叉和搜索天然包含这些选择，不依赖本机状态。

### 旧版本迁移与兼容

更早的实现把选过模型的会话切到 `dev-team+coder:<provider>@<model>` 变体预设上
（模式列表因此变长），并写过 `dev-team/coder-model` 自定义事件。本版：

1. **兼容旧变体 id**：恢复/新建都要经过
   `sessionController.agents.composeAgent(presetId)`，这里把
   `dev-team+coder:*` 折回 `dev-team`。会话仍记着旧 id 时，`routeFor` 也会
   直接从 id 解析 coder 路由，客户端把旧 id 视作开发小队会话。
2. **兼容旧命令事件**：旧版 `/devteam-coder` 的 `command/run` / `command/done`
   仍在日志里，新投影会按同样规则还原 coder 选择。
3. **不再写自定义事件**；`dev-team/coder-model` 只保留只读兼容（HMR 中的旧会话
   仍能显示选择）。

> ⚠️ **1.3.x 写过的旧会话**：如果某个历史会话的日志里已经有
> `dev-team/coder-model` 事件，DSH 0.2.1 的持久化读取器会把它当作未知事件，
> 重启后可能拒绝打开该会话。1.4.0 起不再产生这种事件。遇到这种会话时，需要
> 迁移或删除那条日志（本插件不会在启动时改写 session 文件）。

## 安装（本机 desktop profile）

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add /path/to/dev-team
```

该命令把依赖写成 `link:` 指向本目录，并把 `dsh-dev-team-bundle` 追加到
`~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 末尾。
**本目录被移动或删除，模式即失效**，需要重新 `add`。

改完本目录的文件后要**重启 DSH**：新增/变更的 bundle 层与新增 Loader 行在启动时合成
（浏览器半的改动会被 client-hmr 热发现，但 Host 半和新增行不会）。

卸载：

```sh
dsh plugin --profile desktop remove dsh-dev-team-bundle
```

## 分享与移植

本目录就是完整的可移植插件。`npm pack` 会生成一个不依赖本机路径的 tarball：

```sh
cd /path/to/dev-team
npm pack
# → dsh-dev-team-bundle-1.4.1.tgz
```

构建好的 tarball 见本仓库的 GitHub Releases（`v1.4.1`）；也可以在上面的目录里
直接执行 `npm pack` 生成。

在另一台机器 / 另一个 profile：

```sh
# 1. 确认 DSH 版本 >= 0.2.1-rc.3
# 2. 安装 tarball（也可以传目录路径）
dsh plugin --profile <profile> add /absolute/path/dsh-dev-team-bundle-1.4.1.tgz

# 3. 重启 DSH，在模式选择器里选「开发小队（Dev Team）」
```

移植要点：

- 包内没有绝对路径、没有 `node_modules` 依赖、没有构建步骤；
- 模型列表来自目标机器自己的模型配置，不写死在预设里；
- 预设会把编排契约带过去，目标工作区**不需要** `AGENTS.md` 或任何额外文件；
- 三个 `dev-team-role-*` 内部预设也会出现在模式选择器里，这是 DSH 0.2.1
  子代理组合模型的限制，不影响正常使用（选「开发小队」即可）。

## 测试

```sh
node dev-team/test/host.test.mjs     # Host 半：三角色投影 / 路由注入 / 命令语义 / 旧 id 兼容（假 ctx）
node dev-team/test/client.test.mjs   # 浏览器半：bundle 形状 / slot 注册 / 组件门控 / 三角色菜单
node dev-team/test/preset.test.mjs   # 预设模板：不使用未注册的提示词变量
```

## DSH 0.2.1 兼容说明

本次升级（0.2.0-rc.2 → 0.2.1-rc.3）有三个破坏性变化，bundle 已按新接口改写：

1. `@deepseek-ai/dsh-tool-subagent` 不再接受 `persona` / `toolFilter`
   （`backgroundMode` 也已移除）。角色 persona 现在放在
   `dev-team-role-planner|coder|reviewer` 三个 Agent 预设里，工具通过
   `agentPreset` 选定。因此模式选择器会多出 3 条标着「（内部）」的条目；
   它们只提供角色工作集，正常使用仍然只选「开发小队（Dev Team）」。
2. 委派入口从 `subagents.start` / `subagents.startContinuable` 改为
   `subagents.startActivation(spec)`；角色路由注入已迁到新入口。
3. `sessionController.agents.assertPresetUnchanged` 已删除；旧变体预设 id 只经过
   `composeAgent(presetId)` 折回 `dev-team`。

`dev-team-role-*` 的插件行是角色工作集：文件、shell、后台任务、skills、web、todo、
压缩，以及一层受 `maxDepth: 2` 约束的委派。它们刻意不包含监督者的
goal / plan-mode / ask-user / present 行——与用户的每一次接触都留给监督者。

## 已知限制

- 路由注入依赖 `subagents.startActivation` 与 `spec.request.agentPreset`；旧 id 兼容依赖
  `sessionController.agents.composeAgent`。若未来 DSH 改了这些形状，最坏情况是
  注入失效（角色退回跟随会话模型，启动日志会告警）或旧会话打不开——届时升级插件即可。
- 选择对之后发起的委派生效；已启动的角色子代理保持它启动时的模型。
- chip 只在「开发小队」会话里出现；别的预设看不到它。
- 三个 `dev-team-role-*` 是 DSH 预设注册表里的普通预设，因此也会出现在模式选择器里
  （排在最后）。这是 DSH 0.2.1 子代理组合模型的限制，不是本 bundle 能隐藏的。
- 模型可用性由 Host 的 LLM 适配器决定；选择器只展示 `modelCatalog()` 当前列出的模型。
  如果模型在会话中途被移除，下一次委派会在 preflight 报错，需要重新选择。

## 文件

- `package.json` — bundle 清单（`dsh.bundle.patch` + `dsh.client`）
- `cordis.patch.yml` — 监督者预设、三个角色子预设与 Host 插件行
- `index.js` — Host 半（三角色投影 + `/devteam-model` 命令 + 委派路由注入 + 旧版兼容）
- `client.js` — 浏览器半（输入框左侧的三角色模型选择 chip）
- `test/` — 离线单元/冒烟测试
- `LICENSE` — MIT
