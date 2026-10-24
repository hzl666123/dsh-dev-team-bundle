# 开发小队（Dev Team）

> 面向编码任务的模型分工：把强模型的注意力集中在计划、验收和用户代言，把实现交给更快、更省成本的模型；每个角色独立选模型，按任务强弱搭配。

[GitHub 仓库](https://github.com/hzl666123/dsh-dev-team-bundle) · 目标 DSH `0.2.1-rc.3+` · 当前版本 `1.4.1`

## 为什么：把强模型放在真正重要的位置

编码任务里，不同阶段的“注意力价值”不同：

- **计划、规格、验收、用户代言**：一步判断错，会放大到整个迭代，值得用强推理模型；
- **编码实现**：迭代次数多，速度和成本更重要，适合快速模型；关键模块也可以随时换强模型；
- **最终审查**：最好由独立的模型和上下文判断，避免和实现者共用同一套盲区。

开发小队把一次任务拆成 **Manager + A/B/C 三个固定角色**：

```text
Manager（会话模型）
├─ Planner A   意图 / 规格 / 计划 / 验收
├─ Coder B     编码实现 / 测试 / 交付
└─ Reviewer C  用户代言 / 最终用户视角判断
```

- Manager 按预设契约只做方向、调度和阶段把关，不写产品代码；
- 每个角色有独立的 persona、工作集和子代理上下文，不用在一个上下文里反复切换身份；
- 三个角色工具固定绑定各自的子预设，模型路由在委派入口注入，不靠模型“自觉扮演”。

这不是提示词层面的角色扮演，而是 DSH 的 **Agent 预设 + 固定角色子代理 + 按角色模型路由**。它更接近真实研发团队的分工：计划、实现、验收和用户代言由不同角色承担，强弱模型各司其职。

## 模型怎么分工

新建「开发小队」会话后，输入框权限选项旁会出现「开发小队」chip：

- 默认三个角色都跟随会话模型；
- 点开后可以分别选择 **Planner / Coder / Reviewer** 的 provider/model；
- 未选择的角色继续跟随会话模型；选择只对之后发起的委派生效，已启动的子代理保持原模型。

常见搭配：

| 场景 | Planner A | Coder B | Reviewer C |
|---|---|---|---|
| 质量优先 | 强推理模型 | 强模型或快速模型 | 强推理模型，最好与 Coder 不同 |
| 成本优先 | 强推理模型 | 快速 / 高性价比模型 | 强推理模型 |
| 单模型 | 会话模型 | 会话模型 | 会话模型 |

要点：**强模型不必全程参与**。把强模型集中在 A/C 的规格、验收和用户判断上，B 用快速模型做高频实现，就是最典型的强弱搭配；关键模块也可以反过来让 B 使用强模型。

也可以用命令直接设置：

```sh
/devteam-model                                  # 查看三个角色当前选择
/devteam-model coder <provider>/<model>         # 设置 Coder 模型
/devteam-model planner <provider>/<model>       # 设置 Planner 模型
/devteam-model reviewer <provider>/<model>      # 设置 Reviewer 模型
/devteam-model coder default                    # 清除覆盖，跟随会话模型
```

## 安装

要求 DSH **0.2.1-rc.3 或更高版本**。安装或更新 bundle 后必须**重启 DSH**，Host 预设才会重新合成。

### 方式一：下载项目，用创造模式安装（便于修改）

1. 下载或克隆本项目到本地：

   ```sh
   git clone https://github.com/hzl666123/dsh-dev-team-bundle.git
   ```

   也可以直接下载 ZIP 解压。确保使用包含 `package.json` 和 `cordis.patch.yml` 的那一层目录。

2. 在 DSH 中新建会话，模式选择 **创造模式**，发送：

   ```text
   请用 plugin_manager 把本地 bundle `/绝对路径/dsh-dev-team-bundle` 安装到当前 profile；
   安装后如果需要重启，直接告诉我。
   ```

3. 按提示授予安装权限，安装完成后重启 DSH。

4. 新建会话，在模式选择器中选择 **开发小队（Dev Team）**。

> 目录安装会以 `link:` 方式依赖本地目录。**不要移动或删除这个目录**，否则模式会失效，需要重新安装。

### 方式二：下载 release tarball，按本地路径安装（便于分享）

1. 下载 [`release/dsh-dev-team-bundle-1.4.1.tgz`](release/dsh-dev-team-bundle-1.4.1.tgz)。

2. 在 DSH 的**创造模式**会话中发送：

   ```text
   请用 plugin_manager 把本地 tarball `/绝对路径/dsh-dev-team-bundle-1.4.1.tgz`
   安装到当前 profile；安装后如果需要重启，直接告诉我。
   ```

   也可以使用命令行：

   ```sh
   dsh plugin --profile <profile> add /绝对路径/dsh-dev-team-bundle-1.4.1.tgz
   ```

3. 重启 DSH，新建会话并选择 **开发小队（Dev Team）**。

tarball 是自包含的，安装后不依赖下载目录，适合分享或稳定使用。

> 模式选择器里还会出现 3 个「开发小队 · A/B/C（内部）」预设。它们是 `delegate_*` 工具自动选用的角色子预设，**不要直接选**；正常使用只需要选「开发小队（Dev Team）」。

## 说明

- 角色模型选择保存在会话自己的命令事件里，会话恢复、导出和分叉都会保留；
- 模型列表来自当前机器的 DSH 模型配置，不写死在预设里；
- `1.4.1` 修复了 persona 模板误用未注册 `{{cwd}}`、导致启动时报 `unknown prompt variable` 的问题。

## 开发

```sh
node test/host.test.mjs     # Host：投影、路由注入、命令语义
node test/client.test.mjs   # 浏览器：chip 与三角色菜单
node test/preset.test.mjs   # 预设模板变量回归
```

MIT License。
