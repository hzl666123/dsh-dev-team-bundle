/**
 * 开发小队（Dev Team）· 角色模型选择 —— Host half.
 *
 * 每个会话可以在对话框里（权限选项旁边）为 planner / coder / reviewer
 * 分别挑一个模型；没挑的角色跟随当前会话模型。
 *
 * 持久化方式：不新增自定义 session 事件类型。DSH 0.2.1 的持久化读取器
 * 只接受内置事件（或带 `ignorable` 的插件记录），第三方事件类型写进
 * session log 后会让会话重启时打不开。因此选择结果直接依附在命令自身的
 * `command/run` / `command/done` 生命周期事件上：
 *   - `/devteam-model coder <provider>/<model>` 会先记 `command/run`
 *     （args 里带着角色和路由），成功后记 `command/done`；
 *   - 本插件的投影 `devTeamModels` 从这对事件推导完整状态，会话恢复时
 *     随日志重放，无需额外文件，也不影响导出/分叉；
 *   - 命令失败（`command/done.kind === 'error'`）时丢弃这次变更。
 *
 * 委派路由：预设里三个角色工具都走 DSH 原生 `spawn` provider，并通过
 * `agentPreset` 固定角色子预设。DSH 0.2.1 的委派入口是
 * `subagents.startActivation(spec)`；插件在调用原方法前，按
 * `spec.request.agentPreset` 找到角色，再把该会话选定的路由补进
 * `spec.request.agentOptions`。子代理再往下委派时，沿 `parentSession`
 * 链向上找根会话的选择，因此角色手里的 helper 也遵循同一套路由。
 *
 * 旧版（1.3.x）的 `dev-team-coder` 别名 provider 仍保留注册，只为还没
 * 重启的旧预设/旧会话转发到 `spawn`；新预设不再引用它。
 *
 * 本文件刻意不 import 任何 DSH 包（profile 里 link 安装的包不保证 bare import
 * 解析路径），只用 ctx 服务。
 */

/** Cordis 插件名。 */
export const name = 'dev-team-models'

/** 需要的 Host 服务。 */
export const inject = ['commands', 'sessionController', 'sessionProjections', 'sessions', 'subagents']

/** 可独立选模型的角色。 */
const ROLES = ['planner', 'coder', 'reviewer']
/** 角色子预设 id → 角色名。 */
const ROLE_BY_PRESET = {
  'dev-team-role-planner': 'planner',
  'dev-team-role-coder': 'coder',
  'dev-team-role-reviewer': 'reviewer',
}
/** 1.3.x 预设里 coder 行使用的别名 provider（仅为兼容旧预设/旧会话保留）。 */
const LEGACY_CODER_PROVIDER = 'dev-team-coder'
/** 别名转发的目标 provider。 */
const BASE_PROVIDER = 'spawn'
/** 会话投影键与状态版本（2：从单 coder 扩展为三角色）。 */
const PROJECTION_KEY = 'devTeamModels'
const STATE_VERSION = 2
/** 面向用户的命令名。 */
const COMMAND_NAME = 'devteam-model'
/** 旧版 coder 命令名（等价于 `/devteam-model coder ...`）。 */
const LEGACY_COMMAND_NAME = 'devteam-coder'
/** 旧版预设变体 id 前缀；新方案不再注册变体。 */
const LEGACY_PREFIX = 'dev-team+coder:'
/** 旧版插件事件类型；只读兼容，不再写入。 */
const LEGACY_EVENT_TYPE = 'dev-team/coder-model'
/** 预设身份。 */
const PRESET_ID = 'dev-team'

/** @param {unknown} value - 任意值。 @returns {{provider: string, model: string} | null} 规范化后的路由。 */
function normalizeRoute(value) {
  if (value === null || typeof value !== 'object') return null
  const provider = value.provider
  const model = value.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return null
  return { provider, model }
}

/** @param {string} text - `<provider>/<model>` 或 `<provider>@<model>`。 @returns {{provider: string, model: string} | null} 解析结果。 */
function parseRoute(text) {
  for (const separator of ['@', '/']) {
    const at = text.lastIndexOf(separator)
    if (at > 0 && at < text.length - 1) {
      const provider = text.slice(0, at).trim()
      const model = text.slice(at + 1).trim()
      if (provider !== '' && model !== '') return { provider, model }
    }
  }
  return null
}

/** @param {unknown} error - 任意抛出值。 @returns {string} 可读信息。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {unknown} id - 预设 id。 @returns {{provider: string, model: string} | null} 旧版变体 id 里带的 coder 路由。 */
function legacyRouteOf(id) {
  if (typeof id !== 'string' || !id.startsWith(LEGACY_PREFIX)) return null
  const rest = id.slice(LEGACY_PREFIX.length)
  const at = rest.lastIndexOf('@')
  if (at <= 0 || at === rest.length - 1) return null
  return { provider: rest.slice(0, at), model: rest.slice(at + 1) }
}

/** @returns {{planner: null, coder: null, reviewer: null, pending: {}}} 空状态。 */
function emptyState() {
  return { planner: null, coder: null, reviewer: null, pending: {} }
}

/** @param {unknown} role - 角色输入。 @returns {'planner'|'coder'|'reviewer'|undefined} 规范角色名。 */
function parseRole(role) {
  return ROLES.includes(role) ? role : undefined
}

/**
 * 解析命令输入。命令处理器和投影共用同一份语法，保证两边推导出的状态一致。
 * @param {unknown} rawInput - `/devteam-model` 之后的原始输入。
 * @param {'planner'|'coder'|'reviewer'|undefined} forcedRole - 旧命令强制 coder 时传入。
 * @returns {{kind: 'status', role: 'planner'|'coder'|'reviewer'|'all'} | {kind: 'set', role: 'planner'|'coder'|'reviewer', route: {provider: string, model: string}} | {kind: 'default', role: 'planner'|'coder'|'reviewer'|'all'} | {kind: 'error', message: string}} 解析结果。
 */
function parseInput(rawInput, forcedRole) {
  const text = String(rawInput ?? '').trim()
  if (text === '' || text === 'status') return { kind: 'status', role: forcedRole ?? 'all' }

  let role = forcedRole
  let rest = text
  if (role === undefined) {
    const tokens = text.split(/\s+/u)
    if (tokens[0] === 'all') {
      role = 'all'
      rest = tokens.slice(1).join(' ')
    } else {
      const named = parseRole(tokens[0])
      if (named !== undefined) {
        role = named
        rest = tokens.slice(1).join(' ')
      } else if (tokens.length === 1) {
        // 兼容旧写法：省略角色名时按 coder 处理（只接受单个 `<route>` 或 `default`）。
        role = 'coder'
      } else {
        return {
          kind: 'error',
          message: `无法识别角色 "${tokens[0]}"；用法：/${COMMAND_NAME} <planner|coder|reviewer> <provider>/<model>`,
        }
      }
    }
  }

  if (rest === '' || rest === 'status') return { kind: 'status', role }
  if (rest === 'default' || rest === 'session' || rest === 'reset') return { kind: 'default', role }
  if (role === 'all') {
    return { kind: 'error', message: `all 只能单独使用，或写成 all default；例如 /${COMMAND_NAME} all default` }
  }
  const route = parseRoute(rest)
  if (route === null) {
    return {
      kind: 'error',
      message: `用法：/${COMMAND_NAME} <planner|coder|reviewer> <provider>/<model>；或 /${COMMAND_NAME} <role> default；或 /${COMMAND_NAME} all default`,
    }
  }
  return { kind: 'set', role, route }
}

/** @param {unknown} value - 待规范化的动作。 @returns {{kind: string, role: string, route?: object} | null} 可持久化的动作。 */
function normalizeAction(value) {
  if (value === null || typeof value !== 'object') return null
  if (value.kind === 'set') {
    const role = parseRole(value.role)
    const route = normalizeRoute(value.route)
    if (role === undefined || route === null) return null
    return { kind: 'set', role, route }
  }
  if (value.kind === 'default') {
    if (value.role === 'all') return { kind: 'default', role: 'all' }
    const role = parseRole(value.role)
    if (role !== undefined) return { kind: 'default', role }
  }
  return null
}

/** @param {unknown} value - 投影里缓存的 pending 表。 @returns {Record<string, object>} 规范化后的 pending。 */
function normalizePending(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const pending = {}
  for (const [commandId, action] of Object.entries(value)) {
    if (typeof commandId !== 'string' || commandId === '') continue
    const normalized = normalizeAction(action)
    if (normalized !== null) pending[commandId] = normalized
  }
  return pending
}

/** @param {{planner: object|null, coder: object|null, reviewer: object|null, pending: object}} state - 状态。 @param {object} action - set/default 动作。 @returns {object} 新状态。 */
function applyAction(state, action) {
  if (action.kind === 'set') return { ...state, [action.role]: action.route }
  if (action.role === 'all') return { ...state, planner: null, coder: null, reviewer: null }
  return { ...state, [action.role]: null }
}

/** @param {{provider: string, model: string} | null} route - 路由。 @returns {string} 展示文本。 */
function routeLabel(route) {
  return route === null ? '跟随会话' : `${route.provider}/${route.model}`
}

/** @param {object} state - 状态。 @param {'planner'|'coder'|'reviewer'|'all'} role - 展示范围。 @returns {string} 展示文本。 */
function formatState(state, role) {
  const render = name => `${name} ${routeLabel(normalizeRoute(state[name]))}`
  if (role === 'all') return ROLES.map(render).join(' · ')
  return render(role)
}

/** @param {unknown} name - 事件里的命令名。 @returns {boolean} 是否本插件的命令。 */
function isOurCommand(name) {
  return name === COMMAND_NAME || name === LEGACY_COMMAND_NAME
}

/** 手写 schema：投影只用到 `parse`，无需引入 schemastery。 */
const stateSchema = {
  parse(value) {
    const state = emptyState()
    for (const role of ROLES) state[role] = normalizeRoute(value?.[role])
    state.pending = normalizePending(value?.pending)
    return state
  },
}
const viewSchema = { parse: value => value }

/**
 * 安装角色模型选择：会话投影 + 委派时注入路由 + 命令。
 * @param {object} ctx - Host 插件上下文。
 */
export function apply(ctx) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) throw new Error('开发小队：缺少 subagents 服务，无法注入角色路由')

  // ── 会话投影：状态完全由命令生命周期事件推导 ──────────────────────────────
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema,
    init: () => emptyState(),
    apply: (state, event) => {
      // 命令开始：把这次意图暂存起来，等 command/done 确认成功后再落地。
      if (event?.type === 'command/run' && isOurCommand(event.data?.name)) {
        const parsed = parseInput(event.data?.args ?? '', event.data?.name === LEGACY_COMMAND_NAME ? 'coder' : undefined)
        if (parsed.kind !== 'set' && parsed.kind !== 'default') return state
        const commandId = event.data?.commandId
        if (typeof commandId !== 'string' || commandId === '') return state
        return { ...state, pending: { ...state.pending, [commandId]: parsed } }
      }
      // 命令结束：成功才应用；失败/取消只清掉暂存。
      if (event?.type === 'command/done') {
        const commandId = event.data?.commandId
        if (typeof commandId !== 'string' || !Object.hasOwn(state.pending, commandId)) return state
        const action = state.pending[commandId]
        const pending = { ...state.pending }
        delete pending[commandId]
        const next = event.data?.kind === 'success' ? applyAction(state, action) : state
        return { ...next, pending }
      }
      // 1.3.x 写入的旧事件：只读兼容，保证 HMR 中的旧会话仍能显示选择。
      if (event?.type === LEGACY_EVENT_TYPE) {
        return { ...state, coder: normalizeRoute(event.data?.coder) }
      }
      return state
    },
    wire: {
      viewSchema,
      view: state => ({ planner: state.planner, coder: state.coder, reviewer: state.reviewer }),
    },
  })

  /** @param {object} session - 会话。 @returns {object} 投影状态或空状态。 */
  const stateOf = session => ctx.sessionProjections.stateOf(session, PROJECTION_KEY) ?? emptyState()

  /**
   * 沿 parentSession 链向上找该角色的选择：角色子代理自己再委派 helper 时，
   * 根会话（监督者）的选择才是权威。
   * @param {object} agent - 发起委派的 Agent。
   * @param {'planner'|'coder'|'reviewer'} role - 角色。
   * @returns {{provider: string, model: string} | null} 该会话选定的路由。
   */
  const routeFor = (agent, role) => {
    let session = agent?.session
    const seen = new Set()
    while (session !== undefined && session !== null && !seen.has(session)) {
      seen.add(session)
      const picked = normalizeRoute(stateOf(session)[role])
      if (picked !== null) return picked
      // 兼容：会话还记着旧版变体预设 id 时，路由就在 id 里。
      if (role === 'coder') {
        const legacy = legacyRouteOf(ctx.sessionProjections.stateOf(session, 'agentPreset'))
        if (legacy !== null) return legacy
      }
      const parentId = session.header?.parentSession
      session = typeof parentId === 'string' ? ctx.sessions.get(parentId) : undefined
    }
    return null
  }

  /** @param {object} request - 委派请求。 @param {string} role - 角色。 @returns {object} 补齐 agentOptions 后的请求。 */
  const withRoleRoute = (request, role) => {
    const route = routeFor(request?.parent, role)
    if (route === null) return request
    return {
      ...request,
      agentOptions: { ...(request.agentOptions ?? {}), provider: route.provider, model: route.model },
    }
  }

  /**
   * 从委派 spec 识别角色：新预设靠 `request.agentPreset`，旧预设的 coder
   * 行靠别名 provider。两者都不匹配时原样透传。
   * @param {object} spec - `startActivation` 参数。
   * @returns {'planner'|'coder'|'reviewer'|undefined} 角色。
   */
  const roleOfSpec = (spec) => {
    const preset = spec?.request?.agentPreset
    if (typeof preset === 'string' && Object.hasOwn(ROLE_BY_PRESET, preset)) return ROLE_BY_PRESET[preset]
    if (spec?.provider === LEGACY_CODER_PROVIDER) return 'coder'
    return undefined
  }

  // ── 旧版别名 provider：只为旧预设/旧会话转发到 spawn ──────────────────────
  const targetProvider = () => {
    const target = subagents.getProvider(BASE_PROVIDER)
    if (target === undefined) throw new Error(`开发小队：找不到 subagent provider "${BASE_PROVIDER}"`)
    return target
  }
  ctx.subagents.registerProvider({
    name: LEGACY_CODER_PROVIDER,
    capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
    inheritsParentContext: false,
    prepareContinuable: request => targetProvider().prepareContinuable(request),
  })

  // ── 委派入口注入路由 ─────────────────────────────────────────────────────
  const originalStartActivation = subagents.startActivation
  if (typeof originalStartActivation === 'function') {
    subagents.startActivation = function devTeamStartActivation(spec) {
      const role = roleOfSpec(spec)
      if (role === undefined || spec?.request === undefined) return originalStartActivation.call(this, spec)
      return originalStartActivation.call(this, { ...spec, request: withRoleRoute(spec.request, role) })
    }
    ctx.effect(() => () => {
      subagents.startActivation = originalStartActivation
    }, 'dev-team-models: delegation route injection')
  } else {
    // 未来 DSH 再改委派入口时，保持模式可用，只牺牲角色模型选择并留下日志。
    ctx.logger?.warn?.('开发小队：subagents.startActivation 不存在，角色模型选择不会生效')
  }

  // ── 用户入口 ────────────────────────────────────────────────────────────
  /**
   * 执行一次模型选择/查询。真正写状态的是命令服务随后追加的 command/done；
   * 这里返回的文本只是给用户看的确认。
   * @param {object} agent - 当前 Agent。
   * @param {unknown} rawInput - 命令输入。
   * @param {'planner'|'coder'|'reviewer'|undefined} forcedRole - 旧命令强制角色。
   * @returns {{kind: 'success'|'error', text: string}} 命令结果。
   */
  const runCommand = (agent, rawInput, forcedRole) => {
    try {
      const parsed = parseInput(rawInput, forcedRole)
      if (parsed.kind === 'error') return { kind: 'error', text: parsed.message }
      const state = stateOf(agent.session)
      if (parsed.kind === 'status') return { kind: 'success', text: formatState(state, parsed.role) }
      const next = applyAction(state, parsed)
      return { kind: 'success', text: formatState(next, parsed.role) }
    } catch (error) {
      return { kind: 'error', text: `切换角色模型失败：${messageOf(error)}` }
    }
  }

  ctx.commands.register({
    name: COMMAND_NAME,
    description: '分别选择开发小队 planner / coder / reviewer 使用的模型；未选择的角色跟随会话模型',
    input: { hint: '[planner|coder|reviewer|all] [<provider>/<model>|default]' },
    handler: ({ agent, rawInput }) => runCommand(agent, rawInput),
  })

  ctx.commands.register({
    name: LEGACY_COMMAND_NAME,
    description: '选择开发小队 coder 角色使用的模型（兼容命令；等价于 /devteam-model coder）',
    input: { hint: '<provider>/<model> | default' },
    handler: ({ agent, rawInput }) => runCommand(agent, rawInput, 'coder'),
  })

  // ── 旧版变体预设 id 的兼容 ───────────────────────────────────────────────
  // 会话里记着 `dev-team+coder:<provider>@<model>` 这种 id 时，预设注册表已经
  // 解析不到它（`agent-preset/not-found`，会话直接打不开）。恢复/新建都要经过
  // `sessionController.agents.composeAgent(presetId)`，在这里把旧 id 折回
  // `dev-team` 即可——不再生成按模型区分的变体预设。
  const controller = ctx.get('sessionController')
  const agentFactory = controller?.agents
  if (agentFactory === undefined || typeof agentFactory.composeAgent !== 'function') {
    throw new Error('开发小队：找不到 sessionController.agents.composeAgent，无法兼容旧会话')
  }
  const originalComposeAgent = agentFactory.composeAgent
  agentFactory.composeAgent = function devTeamComposeAgent(presetId) {
    const mapped = legacyRouteOf(presetId) === null ? presetId : PRESET_ID
    return originalComposeAgent.call(this, mapped)
  }
  ctx.effect(() => () => {
    agentFactory.composeAgent = originalComposeAgent
  }, 'dev-team-models: legacy preset compatibility')
}
