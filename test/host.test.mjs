/**
 * index.js 的离线单元测试：用假的 ctx / subagents / projections / commands 驱动 apply()，
 * 校验三角色投影、委派入口的路由注入、命令语义与旧版兼容。不连接真实 DSH。
 *
 * 运行：node dev-team/test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { apply, inject, name } from '../index.js'

const PLANNER = { provider: 'deepseek-official', model: 'deepseek-planner' }
const CODER = { provider: 'openai', model: 'gpt-5' }
const REVIEWER = { provider: 'deepseek-official', model: 'deepseek-reviewer' }

function makeCtx() {
  const state = {
    providers: new Map(),
    commands: new Map(),
    projections: new Map(),
    effects: [],
    activationCalls: [],
    sessions: new Map(),
    composed: [],
    counter: 0,
  }

  const subagents = {
    registerProvider: (provider) => { state.providers.set(provider.name, provider) },
    getProvider: providerName => state.providers.get(providerName),
    startActivation(spec) {
      state.activationCalls.push(spec)
      return Promise.resolve({ childId: 'child' })
    },
  }

  const agentFactory = {
    composeAgent(presetId) {
      state.composed.push(presetId)
      if (presetId !== 'standard' && presetId !== 'dev-team') throw new Error(`Unknown agent preset: ${presetId}`)
      return Promise.resolve({ agentPreset: presetId })
    },
  }
  const sessionController = { agents: agentFactory }
  const services = { subagents, sessionController }

  const ctx = {
    get: serviceName => services[serviceName],
    subagents,
    sessionProjections: {
      register: (definition) => { state.projections.set(definition.key, definition) },
      stateOf: (session, key) => {
        if (key === 'agentPreset') {
          // 预设注册表拥有该投影：header 初始化 + agent-preset/selected 事件推进。
          let current = session.header?.agentPreset ?? null
          for (const event of state.sessions.get(session) ?? []) {
            if (event.type === 'agent-preset/selected') current = event.data.agentPreset
          }
          return current
        }
        const definition = state.projections.get(key)
        if (definition === undefined) return undefined
        let current = definition.init()
        for (const event of state.sessions.get(session) ?? []) current = definition.apply(current, event)
        return current
      },
    },
    commands: { register: (definition) => { state.commands.set(definition.name, definition) } },
    sessions: {
      get: id => [...state.sessions.keys()].find(session => session.id === id),
      list: () => [...state.sessions.keys()],
    },
    on: () => {},
    effect: (factory) => { state.effects.push(factory) },
  }

  const makeAgent = (events = [], header = {}) => {
    const id = header.id ?? `session-${++state.counter}`
    const session = {
      id,
      header: { id, ...header },
      command: async () => ({ ok: true, value: { matched: true } }),
    }
    state.sessions.set(session, [...events])
    session.append = (type, data) => {
      state.sessions.get(session).push({ type, data })
    }
    return { session }
  }

  return { ctx, state, subagents, sessionController, makeAgent }
}

/** 模拟命令服务：先记 command/run，执行 handler，再按结果记 command/done。 */
function runCommand(state, agent, commandName, rawInput) {
  const command = state.commands.get(commandName)
  assert.ok(command, `注册了 /${commandName}`)
  const commandId = `cmd-${++state.counter}`
  agent.session.append('command/run', { commandId, name: commandName, args: rawInput, source: { kind: 'user' } })
  const result = command.handler({ agent, rawInput })
  agent.session.append('command/done', { commandId, kind: result.kind, text: result.text })
  return result
}

// --- 插件形状 ---------------------------------------------------------------
assert.equal(name, 'dev-team-models')
assert.deepEqual(inject, ['commands', 'sessionController', 'sessionProjections', 'sessions', 'subagents'])

// --- 旧版别名 provider（只为旧预设保留） -----------------------------------
{
  const { ctx, state } = makeCtx()
  apply(ctx)
  const alias = state.providers.get('dev-team-coder')
  assert.ok(alias, '注册了 dev-team-coder 兼容别名 provider')
  assert.equal(alias.inheritsParentContext, false)
  assert.deepEqual(alias.capabilities, { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true })
  assert.equal(alias.start, undefined, '0.2.1 的本地 provider 只用 prepareContinuable')

  const spawn = { prepareContinuable: request => Promise.resolve({ prepared: request }) }
  state.providers.set('spawn', spawn)
  assert.deepEqual(await alias.prepareContinuable({ prompt: 'y' }), { prepared: { prompt: 'y' } })
  state.providers.delete('spawn')
  await assert.rejects(async () => alias.prepareContinuable({}), /找不到 subagent provider "spawn"/)
}

// --- 三角色投影 -------------------------------------------------------------
{
  const { ctx, state } = makeCtx()
  apply(ctx)
  const projection = state.projections.get('devTeamModels')
  assert.ok(projection, '注册了 devTeamModels 投影')
  assert.equal(projection.stateVersion, 2)
  assert.deepEqual(projection.init(), { planner: null, coder: null, reviewer: null, pending: {} })
  assert.deepEqual(projection.wire.view({ planner: PLANNER, coder: null, reviewer: REVIEWER, pending: {} }), {
    planner: PLANNER,
    coder: null,
    reviewer: REVIEWER,
  })
  assert.deepEqual(projection.stateSchema.parse({ coder: { provider: 'a', model: 'b', extra: 1 } }), {
    planner: null,
    coder: { provider: 'a', model: 'b' },
    reviewer: null,
    pending: {},
  })

  // command/run 只暂存；成功 done 才落地
  let current = projection.apply(projection.init(), {
    type: 'command/run',
    data: { commandId: 'c1', name: 'devteam-model', args: 'coder openai/gpt-5' },
  })
  assert.deepEqual(current.pending.c1, { kind: 'set', role: 'coder', route: CODER })
  assert.equal(current.coder, null)
  current = projection.apply(current, { type: 'command/done', data: { commandId: 'c1', kind: 'success' } })
  assert.deepEqual(current, { planner: null, coder: CODER, reviewer: null, pending: {} })

  // 失败/取消只清暂存，不改状态
  current = projection.apply(current, {
    type: 'command/run',
    data: { commandId: 'c2', name: 'devteam-model', args: 'reviewer deepseek-official/deepseek-reviewer' },
  })
  current = projection.apply(current, { type: 'command/done', data: { commandId: 'c2', kind: 'error' } })
  assert.deepEqual(current, { planner: null, coder: CODER, reviewer: null, pending: {} })

  // all default
  current = projection.apply(current, {
    type: 'command/run',
    data: { commandId: 'c3', name: 'devteam-model', args: 'all default' },
  })
  current = projection.apply(current, { type: 'command/done', data: { commandId: 'c3', kind: 'success' } })
  assert.deepEqual(current, { planner: null, coder: null, reviewer: null, pending: {} })

  // 旧命令名按 coder 解析；旧事件只读兼容
  current = projection.apply(current, {
    type: 'command/run',
    data: { commandId: 'c4', name: 'devteam-coder', args: ' deepseek-official/deepseek-chat' },
  })
  assert.deepEqual(current.pending.c4, { kind: 'set', role: 'coder', route: { provider: 'deepseek-official', model: 'deepseek-chat' } })
  current = projection.apply(current, { type: 'command/done', data: { commandId: 'c4', kind: 'success' } })
  assert.deepEqual(current.coder, { provider: 'deepseek-official', model: 'deepseek-chat' })
  assert.deepEqual(
    projection.apply(current, { type: 'dev-team/coder-model', data: { coder: PLANNER } }).coder,
    PLANNER,
  )

  // 无关事件保持引用不变
  assert.equal(projection.apply(current, { type: 'other/event', data: {} }), current)
}

// --- 委派入口按 agentPreset 注入三角色路由 ---------------------------------
{
  const { ctx, state, subagents, makeAgent } = makeCtx()
  const originalStartActivation = subagents.startActivation
  apply(ctx)
  assert.notEqual(subagents.startActivation, originalStartActivation, 'startActivation 已被接管')

  const manager = makeAgent([], { id: 'manager', agentPreset: 'dev-team' })
  runCommand(state, manager, 'devteam-model', 'planner deepseek-official/deepseek-planner')
  runCommand(state, manager, 'devteam-model', 'coder openai/gpt-5')
  runCommand(state, manager, 'devteam-model', 'reviewer deepseek-official/deepseek-reviewer')

  const specFor = (role, parent, extra = {}) => ({
    provider: 'spawn',
    request: { parent, prompt: [{ type: 'text', text: 'p' }], agentPreset: `dev-team-role-${role}`, ...extra },
    signal: {},
  })

  await subagents.startActivation(specFor('planner', manager))
  assert.deepEqual(state.activationCalls.at(-1).request.agentOptions, PLANNER)
  await subagents.startActivation(specFor('coder', manager))
  assert.deepEqual(state.activationCalls.at(-1).request.agentOptions, CODER)
  await subagents.startActivation(specFor('reviewer', manager))
  assert.deepEqual(state.activationCalls.at(-1).request.agentOptions, REVIEWER)

  // 保留 request 里的其它字段，且不改调用方对象
  const originalRequest = { parent: manager, prompt: 'p', agentOptions: { maxTokens: 100 } }
  const spec = { provider: 'spawn', request: { ...originalRequest, agentPreset: 'dev-team-role-coder' }, signal: {} }
  await subagents.startActivation(spec)
  assert.deepEqual(state.activationCalls.at(-1).request.agentOptions, { maxTokens: 100, ...CODER })
  assert.deepEqual(spec.request.agentOptions, { maxTokens: 100 }, '不改动调用方传入的 spec')
  assert.equal(state.activationCalls.at(-1).request.prompt, 'p')

  // 子会话没有自己的选择时，沿 parentSession 链使用根会话的选择
  const child = makeAgent([], { id: 'child', parentSession: 'manager', agentPreset: 'dev-team-role-planner' })
  await subagents.startActivation(specFor('coder', child))
  assert.deepEqual(state.activationCalls.at(-1).request.agentOptions, CODER, 'helper 也继承根会话的 coder 路由')

  // 旧预设的 coder 行仍通过别名 provider 识别
  await subagents.startActivation({ provider: 'dev-team-coder', request: { parent: manager, prompt: 'p' }, signal: {} })
  assert.deepEqual(state.activationCalls.at(-1).request.agentOptions, CODER)

  // 没有选择时原样透传
  const plain = makeAgent([], { id: 'plain', agentPreset: 'dev-team' })
  const noRoute = specFor('planner', plain)
  await subagents.startActivation(noRoute)
  assert.equal(state.activationCalls.at(-1).request, noRoute.request, '没选模型时 request 按引用透传')

  // 其它预设/无关 provider 不受影响
  const foreign = {
    provider: 'spawn',
    request: { parent: manager, prompt: 'p', agentPreset: 'standard' },
    signal: {},
  }
  await subagents.startActivation(foreign)
  assert.equal(state.activationCalls.at(-1), foreign, '非角色 spec 按引用透传')

  // 卸载时恢复原方法（ctx.effect 的工厂返回 disposer）
  assert.equal(state.effects.length, 2, '分别是 composeAgent 兼容与委派注入的清理')
  for (const factory of state.effects) await factory()()
  assert.equal(subagents.startActivation, originalStartActivation)
}

// --- 命令语义 ---------------------------------------------------------------
{
  const { ctx, state, makeAgent } = makeCtx()
  apply(ctx)
  const command = state.commands.get('devteam-model')
  assert.ok(command, '注册了 /devteam-model')
  assert.equal(command.input.hint, '[planner|coder|reviewer|all] [<provider>/<model>|default]')
  const legacy = state.commands.get('devteam-coder')
  assert.ok(legacy, '保留 /devteam-coder 兼容命令')

  const agent = makeAgent([], { id: 'commands', agentPreset: 'dev-team' })
  assert.deepEqual(runCommand(state, agent, 'devteam-model', ''), {
    kind: 'success',
    text: 'planner 跟随会话 · coder 跟随会话 · reviewer 跟随会话',
  })

  assert.equal(
    runCommand(state, agent, 'devteam-model', 'planner deepseek-official/deepseek-planner').text,
    'planner deepseek-official/deepseek-planner',
  )
  assert.equal(runCommand(state, agent, 'devteam-model', 'coder openai@gpt-5').text, 'coder openai/gpt-5')
  assert.equal(
    runCommand(state, agent, 'devteam-model', 'reviewer deepseek-official/deepseek-reviewer').text,
    'reviewer deepseek-official/deepseek-reviewer',
  )
  assert.equal(
    runCommand(state, agent, 'devteam-model', 'status').text,
    'planner deepseek-official/deepseek-planner · coder openai/gpt-5 · reviewer deepseek-official/deepseek-reviewer',
  )
  assert.equal(
    runCommand(state, agent, 'devteam-model', 'planner status').text,
    'planner deepseek-official/deepseek-planner',
  )

  // 旧命令只改 coder
  assert.equal(
    runCommand(state, agent, 'devteam-coder', 'deepseek-official/deepseek-chat').text,
    'coder deepseek-official/deepseek-chat',
  )
  assert.equal(runCommand(state, agent, 'devteam-coder', 'default').text, 'coder 跟随会话')

  // all default
  assert.equal(
    runCommand(state, agent, 'devteam-model', 'all default').text,
    'planner 跟随会话 · coder 跟随会话 · reviewer 跟随会话',
  )

  const invalid = runCommand(state, agent, 'devteam-model', 'nonsense')
  assert.equal(invalid.kind, 'error')
  assert.match(invalid.text, /用法/)

  const allSet = runCommand(state, agent, 'devteam-model', 'all openai/gpt-5')
  assert.equal(allSet.kind, 'error')
  assert.match(allSet.text, /all 只能/)

  // stateOf 失败 → 命令返回 error 而不是抛异常
  const broken = makeAgent([], { id: 'broken', agentPreset: 'dev-team' })
  ctx.sessionProjections.stateOf = () => { throw new Error('projection unavailable') }
  const failed = runCommand(state, broken, 'devteam-model', 'status')
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /projection unavailable/)
}

// --- 缺少 subagents 服务时明确报错 ------------------------------------------
{
  const { ctx } = makeCtx()
  ctx.get = () => undefined
  assert.throws(() => apply(ctx), /缺少 subagents 服务/)
}

// --- 旧版变体预设 id 兼容 ---------------------------------------------------
{
  const { ctx, state, subagents, sessionController, makeAgent } = makeCtx()
  const factory = sessionController.agents
  const originalCompose = factory.composeAgent
  apply(ctx)
  assert.notEqual(factory.composeAgent, originalCompose, 'composeAgent 已被接管')

  // 新 id 原样透传
  assert.equal((await factory.composeAgent('standard')).agentPreset, 'standard')
  assert.deepEqual(state.composed, ['standard'])

  // 旧变体 id 折回 dev-team（否则会 agent-preset/not-found，会话打不开）
  const composed = await factory.composeAgent('dev-team+coder:openai@gpt-5')
  assert.equal(composed.agentPreset, 'dev-team')
  assert.deepEqual(state.composed, ['standard', 'dev-team'])

  // 未迁移完成时，coder 路由从旧 id 里解析出来，委派照旧注入
  const legacyAgent = makeAgent([], {
    id: 'legacy',
    agentPreset: 'dev-team+coder:openai@gpt-5',
  })
  await subagents.startActivation({
    provider: 'dev-team-coder',
    request: { parent: legacyAgent, prompt: 'p' },
    signal: {},
  })
  assert.deepEqual(state.activationCalls.at(-1).request.agentOptions, { provider: 'openai', model: 'gpt-5' })

  // 卸载恢复
  for (const effect of state.effects) await effect()()
  assert.equal(factory.composeAgent, originalCompose)
}

// --- 命令解析的边界 ---------------------------------------------------------
{
  const { ctx, state, makeAgent } = makeCtx()
  apply(ctx)
  const agent = makeAgent([], { id: 'edges', agentPreset: 'dev-team' })
  assert.equal(runCommand(state, agent, 'devteam-model', 'default').text, 'coder 跟随会话')
  assert.equal(runCommand(state, agent, 'devteam-model', 'coder').text, 'coder 跟随会话')
  assert.equal(runCommand(state, agent, 'devteam-model', 'all').text, 'planner 跟随会话 · coder 跟随会话 · reviewer 跟随会话')
  const badRoute = runCommand(state, agent, 'devteam-model', 'coder nope')
  assert.equal(badRoute.kind, 'error')
  assert.match(badRoute.text, /用法/)
  const badRole = runCommand(state, agent, 'devteam-model', 'nope openai/gpt-5')
  assert.equal(badRole.kind, 'error')
}

console.log('host unit tests: OK')
