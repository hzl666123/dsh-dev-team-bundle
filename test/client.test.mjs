/**
 * client.js 的离线冒烟测试：用假的 window.__ModuleLoader__ / react / slots 服务，
 * 校验 bundle 形状、slot 注册位置、组件门控与三角色菜单交互。不连接浏览器。
 *
 * 运行：node dev-team/test/client.test.mjs
 */
import assert from 'node:assert/strict'

let loaded = null
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }

await import('../client.js')

assert.ok(loaded, 'client.js 调用了 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-dev-team-bundle', 'bundle id 必须等于包名')

/** 可指定每次 useState 初值的假 react（按调用序号取）。 */
const makeReact = (states = []) => {
  let call = 0
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => {
      const index = call++
      const value = index < states.length ? states[index] : (typeof initial === 'function' ? initial() : initial)
      return [value, () => {}]
    },
    useEffect: () => {},
  }
}

/** 在渲染树里收集文本。 */
const texts = (node) => {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(texts)
  return texts(node.children ?? [])
}

/** 在渲染树里收集元素。 */
const nodes = (node) => {
  if (node === null || node === undefined || typeof node === 'string') return []
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (typeof node !== 'object') return []
  return [node, ...(node.children ?? []).flatMap(nodes)]
}

const SESSION_ROUTE = { provider: 'kimi', model: 'kimi-k3.1-pro' }
const CODER_ROUTE = { provider: 'deepseek-official', model: 'deepseek-chat' }
const CATALOG = {
  groups: [
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }] },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
  ],
}

function boot({ states = [], choose = async () => true, catalog = CATALOG } = {}) {
  const React = makeReact(states)
  const plugin = loaded.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require("${id}")`)
  })
  assert.deepEqual(plugin.inject, ['slots', 'sessions', 'remote', 'remote.session'])

  let registered = null
  const calls = []
  const commandLines = []
  plugin.apply({
    slots: {
      inject: (target, callback) => { assert.equal(target, 'conversation.input.left'); callback() },
      register: (options, Component) => { registered = { options, Component } },
    },
    sessions: { binding: () => ({ session: { command: async (line) => { commandLines.push(line); return { ok: true, value: { matched: true } } } } }) },
    remote: { session: { modelCatalog: async () => ({ ok: true, value: catalog }) } },
  })
  assert.ok(registered, '注册进了 slot')
  assert.equal(registered.options.name, 'conversation.input.left', '挂在权限 chip 所在的输入框左侧工具区')
  assert.equal(registered.options.id, 'dev-team-models')

  const business = registered.options.inject('session-1')
  const render = ({ preset = 'dev-team', models = null, sessionId = 'session-1' } = {}) => registered.Component({
    sessionId,
    useProjection: (key) => {
      if (key === 'agentPreset') return preset
      if (key === 'devTeamModels') return models
      if (key === 'modelSelection') return { lastUsed: SESSION_ROUTE, next: null }
      return undefined
    },
    loadCatalog: async () => catalog,
    choose: (...args) => { calls.push(args); return choose(...args) },
  })
  return { render, calls, business, registered, commandLines }
}

// --- 门控 -------------------------------------------------------------------
{
  const { render } = boot()
  assert.equal(render({ preset: 'standard' }), null, '非开发小队会话不渲染')
  assert.equal(render({ preset: null }), null)
  assert.equal(render({ preset: 'dev-team', sessionId: null }), null, '没有会话 id 不渲染')
  assert.ok(render({ preset: 'dev-team+coder:openai@gpt-5' }), '旧变体预设仍显示 chip（兼容窗口）')
}

// --- 关闭态 chip ------------------------------------------------------------
{
  const { render } = boot()
  const tree = render({ models: null })
  const copy = texts(tree).join(' | ')
  assert.match(copy, /开发小队/)
  assert.match(copy, /跟随会话/)
  const buttons = nodes(tree).filter(node => node.type === 'button')
  assert.equal(buttons.length, 1, '未展开时只有一个按钮')

  const selected = render({ models: { planner: null, coder: CODER_ROUTE, reviewer: null } })
  assert.match(texts(selected).join(' | '), /1\/3 已选/)
  const chip = nodes(selected).find(node => node.type === 'button')
  assert.match(chip.props.title, /Coder deepseek-official \/ deepseek-chat/)

  // 菜单关闭时不渲染角色行
  assert.doesNotMatch(texts(tree).join(' | '), /Planner/)
}

// --- 角色总览（菜单第一层） -------------------------------------------------
{
  // useState 顺序：catalog, open, view, activeRole, busy, failure
  const { render } = boot({ states: [CATALOG, true, 'roles', null, false, null] })
  const tree = render({ models: { planner: null, coder: CODER_ROUTE, reviewer: null } })
  const copy = texts(tree).join(' | ')
  assert.match(copy, /开发小队 · 角色模型/)
  assert.match(copy, /Planner/)
  assert.match(copy, /计划与验收/)
  assert.match(copy, /Coder/)
  assert.match(copy, /编码实现/)
  assert.match(copy, /Reviewer/)
  assert.match(copy, /用户代言/)
  assert.match(copy, /跟随会话/)
  assert.match(copy, /对之后发起的委派生效/)
  assert.match(copy, /当前 kimi \/ kimi-k3.1-pro/)
  const buttons = nodes(tree).filter(node => node.type === 'button')
  assert.equal(buttons.length, 4, 'chip + 三个角色按钮')
}

// --- 某角色的模型列表（菜单第二层） ----------------------------------------
{
  const { render, calls } = boot({ states: [CATALOG, true, 'models', 'coder', false, null] })
  const tree = render({ models: { planner: null, coder: null, reviewer: null } })
  const copy = texts(tree).join(' | ')
  assert.match(copy, /Coder · 编码实现/)
  assert.match(copy, /‹ 全部角色/)
  assert.match(copy, /跟随会话模型（默认）/)
  assert.match(copy, /DeepSeek Chat/)
  assert.match(copy, /GPT-5/)

  const byText = (needle) => nodes(tree).find(node => node.type === 'button' && texts(node).join('') === needle)
  assert.ok(byText('跟随会话模型（默认）'), '有跟随会话选项')
  byText('跟随会话模型（默认）').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [['/devteam-model coder default']], '默认项下发 coder default')

  byText('GPT-5').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.at(-1), ['/devteam-model coder openai/gpt-5'], '具体模型下发 provider/model')
}

// --- 目录加载失败：不抛异常，给出提示 --------------------------------------
{
  const React = makeReact([null, true, 'models', 'planner', false, null])
  const plugin = loaded.factory(id => (id === 'react' ? React : undefined))
  let registered = null
  plugin.apply({
    slots: {
      inject: (_target, callback) => callback(),
      register: (options, Component) => { registered = { options, Component } },
    },
    sessions: { binding: () => ({ session: { command: async () => ({ ok: true, value: { matched: true } }) } }) },
    remote: { session: { modelCatalog: async () => ({ ok: false, error: { message: 'no llm' } }) } },
  })
  const tree = registered.Component({
    sessionId: 's',
    useProjection: key => (key === 'agentPreset' ? 'dev-team' : key === 'devTeamModels' ? null : { lastUsed: SESSION_ROUTE }),
    loadCatalog: async () => { throw new Error('模型目录不可用') },
    choose: async () => true,
  })
  assert.ok(tree, '加载失败也要渲染 chip')
  assert.match(texts(tree).join(' | '), /加载模型目录/)
}

// --- 注入面：choose 只接受一整条命令 ---------------------------------------
{
  const { business, commandLines } = boot()
  assert.equal(await business.choose('/devteam-model reviewer openai/gpt-5'), true)
  assert.deepEqual(commandLines, ['/devteam-model reviewer openai/gpt-5'])
}

console.log('client smoke tests: OK')
