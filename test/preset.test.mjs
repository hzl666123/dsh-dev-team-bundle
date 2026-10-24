/**
 * 预设模板的离线回归测试：persona 只能使用 DSH 当前注册过的提示词变量。
 *
 * DSH 0.2.1 只注册 `provider` / `model` 两个模板变量；当前工作目录由
 * runtime context 提供，不是 `{{cwd}}`。误用未注册变量会让会话在第一轮
 * 组装 system prompt 时直接失败：
 *   unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"
 *
 * 运行：node dev-team/test/preset.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

// 1. 不再出现 DSH 0.2.1 未注册的 cwd 变量。
assert.doesNotMatch(patch, /\{\{cwd\}\}/, 'persona 模板不能使用未注册的 {{cwd}}')

// 2. 所有模板变量都必须是 DSH 当前注册的变量。
const variables = [...patch.matchAll(/\{\{([^{}]+)\}\}/g)].map(match => match[1].trim())
assert.deepEqual([...new Set(variables)].sort(), ['model'], '只使用已注册的 {{model}}')

// 3. 四个预设都还在；三个 role 预设仍被 delegate 工具引用。
const ids = [...patch.matchAll(/^\s{8}id: (dev-team(?:-role-[a-z]+)?)$/gm)].map(match => match[1])
assert.deepEqual(
  ids.sort(),
  ['dev-team', 'dev-team-role-coder', 'dev-team-role-planner', 'dev-team-role-reviewer'],
  '四个预设 id 完整',
)
for (const role of ['planner', 'coder', 'reviewer']) {
  assert.match(patch, new RegExp(`agentPreset: dev-team-role-${role}\\b`), `delegate_${role} 仍指向角色预设`)
}

console.log('preset template tests: OK')
