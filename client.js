/**
 * 开发小队（Dev Team）· 角色模型选择 —— Browser half.
 *
 * 只在当前会话使用「开发小队」预设时，在输入框的权限选项旁边显示一枚
 * 「开发小队」chip：
 *   - 点开后分别给 Planner / Coder / Reviewer 选模型；
 *   - 每行未选择时显示「跟随会话」，选择后显示具体 provider/model；
 *   - 选择结果通过 `/devteam-model <role> <provider>/<model>` 写回 Host，
 *     由 Host 的 `devTeamModels` 投影驱动界面，会话恢复后仍然有效。
 *
 * 手写 bundle（DSH 自带模板同款）：只 require 冻结模块表里的 react，
 * 其余通过 ctx 服务拿；样式内联 + --dsw-alias-* 变量（带兜底值）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dev-team-bundle',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PRESET = 'dev-team'
    const LEGACY_PRESET_PREFIX = 'dev-team+coder:'
    const SESSION_OPTION = '__session__'
    const ROLES = [
      { id: 'planner', badge: 'A', name: 'Planner', subtitle: '计划与验收' },
      { id: 'coder', badge: 'B', name: 'Coder', subtitle: '编码实现' },
      { id: 'reviewer', badge: 'C', name: 'Reviewer', subtitle: '用户代言' },
    ]

    /** @param {{provider?: string, model?: string} | null | undefined} route - 路由。 @returns {string} 展示文本。 */
    const labelOf = route => (route && route.provider && route.model ? `${route.provider} / ${route.model}` : '跟随会话')

    /** @param {string | null | undefined} preset - 当前预设 id。 @returns {boolean} 是否开发小队会话。 */
    const isDevTeam = preset => preset === PRESET
      || (typeof preset === 'string' && preset.startsWith(LEGACY_PRESET_PREFIX))

    const styles = {
      wrap: { position: 'relative', display: 'inline-flex' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '24px',
        padding: '0 8px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, 0.28))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '22px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      chipOpen: { background: 'var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.14))' },
      dim: { opacity: 0.62 },
      menu: {
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: 0,
        zIndex: 40,
        width: '326px',
        maxHeight: '390px',
        overflowY: 'auto',
        padding: '6px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, 0.28))',
        background: 'var(--dsw-alias-bg-elevated, Canvas)',
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.26)',
        color: 'var(--dsw-alias-text-primary, inherit)',
      },
      head: { padding: '6px 8px 4px', fontSize: '11px', opacity: 0.66 },
      headValue: { display: 'block', marginTop: '2px', fontSize: '12px', opacity: 0.92 },
      role: {
        display: 'flex',
        alignItems: 'center',
        gap: '9px',
        width: '100%',
        padding: '7px 8px',
        borderRadius: '8px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      roleActive: { background: 'var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.14))' },
      badge: {
        display: 'grid',
        placeItems: 'center',
        flex: '0 0 auto',
        width: '22px',
        height: '22px',
        borderRadius: '50%',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, 0.32))',
        fontSize: '11px',
        opacity: 0.9,
      },
      roleText: { flex: '1 1 auto', minWidth: 0 },
      roleName: { display: 'block', fontSize: '12px', lineHeight: '16px' },
      roleSub: { display: 'block', fontSize: '10.5px', lineHeight: '14px', opacity: 0.55 },
      roleValue: {
        flex: '0 0 auto',
        maxWidth: '132px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '11px',
        opacity: 0.78,
      },
      chevron: { flex: '0 0 auto', fontSize: '10px', opacity: 0.5 },
      back: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        margin: '2px 8px 4px',
        padding: '2px 4px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '11px',
        opacity: 0.68,
        cursor: 'pointer',
      },
      group: { margin: '8px 8px 2px', fontSize: '11px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.04em' },
      item: {
        display: 'block',
        width: '100%',
        padding: '5px 8px',
        borderRadius: '7px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        textAlign: 'left',
        cursor: 'pointer',
      },
      itemActive: { background: 'var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.16))' },
      hint: { padding: '4px 8px 2px', fontSize: '11px', opacity: 0.55 },
      error: { padding: '4px 8px 2px', fontSize: '11px', color: 'var(--dsw-alias-text-danger, #d9534f)' },
    }

    /**
     * 权限选项旁边的「开发小队」chip。
     * @param {object} props - 框架 props + inject 提供的业务 props。
     * @returns {object | null} React 节点。
     */
    function DevTeamModels(props) {
      const { sessionId, useProjection, loadCatalog, choose } = props
      const preset = useProjection('agentPreset')
      const models = useProjection('devTeamModels')
      const modelSelection = useProjection('modelSelection')
      const [catalog, setCatalog] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [view, setView] = React.useState('roles')
      const [activeRole, setActiveRole] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(null)

      const ensureCatalog = () => {
        if (catalog !== null) return
        Promise.resolve()
          .then(() => loadCatalog())
          .then(value => setCatalog(value ?? null))
          .catch(error => setFailure(error instanceof Error ? error.message : String(error)))
      }

      const openMenu = () => {
        setFailure(null)
        const next = !open
        setOpen(next)
        if (!next) return
        setView('roles')
        setActiveRole(null)
        ensureCatalog()
      }

      const selectRole = (role) => {
        if (busy) return
        setFailure(null)
        setActiveRole(role)
        setView('models')
        ensureCatalog()
      }

      const back = () => {
        if (busy) return
        setActiveRole(null)
        setView('roles')
      }

      const pick = (role, provider, model) => {
        if (busy || role === null) return
        setBusy(true)
        setFailure(null)
        const line = provider === SESSION_OPTION
          ? `/devteam-model ${role} default`
          : `/devteam-model ${role} ${provider}/${model}`
        Promise.resolve()
          .then(() => choose(line))
          .then(() => setOpen(false))
          .catch(error => setFailure(error instanceof Error ? error.message : String(error)))
          .then(() => setBusy(false))
      }

      if (!isDevTeam(preset) || sessionId === undefined || sessionId === null) return null

      const routeOf = role => models?.[role] ?? null
      const overrides = ROLES.filter(role => routeOf(role.id) !== null).length
      const sessionRoute = (modelSelection && (modelSelection.next ?? modelSelection.lastUsed)) ?? null
      const groups = catalog !== null && Array.isArray(catalog.groups) ? catalog.groups : []
      const role = ROLES.find(candidate => candidate.id === activeRole) ?? null

      const roleButton = item => h('button', {
        key: `role:${item.id}`,
        type: 'button',
        style: { ...styles.role, ...(activeRole === item.id && view === 'models' ? styles.roleActive : {}) },
        title: `${item.name}：${labelOf(routeOf(item.id))}`,
        'aria-haspopup': 'menu',
        onClick: () => selectRole(item.id),
      }, [
        h('span', { key: 'badge', style: styles.badge }, item.badge),
        h('span', { key: 'text', style: styles.roleText }, [
          h('span', { key: 'name', style: styles.roleName }, item.name),
          h('span', { key: 'sub', style: styles.roleSub }, item.subtitle),
        ]),
        h('span', { key: 'value', style: styles.roleValue }, busy ? '切换中…' : labelOf(routeOf(item.id))),
        h('span', { key: 'chevron', style: styles.chevron }, '›'),
      ])

      const rolesView = [
        h('div', { key: 'head', style: styles.head }, [
          '开发小队 · 角色模型',
          h('span', { key: 'value', style: styles.headValue }, `未选择的角色跟随会话模型（当前 ${labelOf(sessionRoute)}）`),
        ]),
        ...ROLES.map(roleButton),
        h('div', { key: 'hint', style: styles.hint }, '对之后发起的委派生效；已启动的子代理保持原模型'),
      ]

      const modelButton = (key, active, onClick, text, title) => h('button', {
        key,
        type: 'button',
        style: { ...styles.item, ...(active ? styles.itemActive : {}) },
        title,
        onClick,
      }, text)

      const modelsView = role === null ? [] : [
        h('button', { key: 'back', type: 'button', style: styles.back, onClick: back }, `‹ 全部角色`),
        h('div', { key: 'head', style: styles.head }, [
          `${role.name} · ${role.subtitle}`,
          h('span', { key: 'value', style: styles.headValue }, `当前：${labelOf(routeOf(role.id))}`),
        ]),
        modelButton(
          'session',
          routeOf(role.id) === null,
          () => pick(role.id, SESSION_OPTION, SESSION_OPTION),
          '跟随会话模型（默认）',
          `跟随会话模型 ${labelOf(sessionRoute)}`,
        ),
        ...groups.map(group => h('div', { key: `group:${group.id}` }, [
          h('div', { key: 'name', style: styles.group }, group.name ?? group.id),
          ...(Array.isArray(group.models) ? group.models : []).map(model => {
            const route = routeOf(role.id)
            const active = route !== null && route.provider === group.id && route.model === model.id
            return modelButton(
              `model:${group.id}:${model.id}`,
              active,
              () => pick(role.id, group.id, model.id),
              model.name ?? model.id,
              `${group.id}/${model.id}`,
            )
          }),
        ])),
        catalog === null && failure === null
          ? h('div', { key: 'loading', style: styles.hint }, '加载模型目录…')
          : null,
        h('div', { key: 'hint', style: styles.hint }, '对之后发起的委派生效'),
      ]

      return h('span', { style: styles.wrap }, [
        h('button', {
          key: 'chip',
          type: 'button',
          style: { ...styles.chip, ...(open ? styles.chipOpen : {}) },
          title: overrides === 0
            ? '开发小队：三个角色都跟随会话模型；点此分别选择'
            : `开发小队角色模型：${ROLES.map(item => `${item.name} ${labelOf(routeOf(item.id))}`).join('；')}`,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: () => { if (!busy) openMenu() },
        }, [
          h('span', { key: 'label', style: styles.dim }, '开发小队'),
          h('span', { key: 'value' }, overrides === 0 ? '跟随会话' : `${overrides}/3 已选`),
          h('span', { key: 'chevron', style: styles.dim }, open ? '▴' : '▾'),
        ]),
        open
          ? h('div', { key: 'menu', style: styles.menu, role: 'menu' }, view === 'models' ? modelsView : rolesView)
          : null,
        failure !== null ? h('span', { key: 'error', style: styles.error, title: failure }, '模型目录不可用') : null,
      ])
    }

    /** 需要的客户端服务。 */
    const inject = ['slots', 'sessions', 'remote', 'remote.session']

    /**
     * 客户端插件主体：把「开发小队」chip 挂到权限选项旁边（输入框左侧工具区）。
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      const loadCatalog = async () => {
        const result = await ctx.remote.session.modelCatalog()
        if (result === undefined || result.ok !== true) {
          throw new Error(result?.error?.message ?? '模型目录不可用')
        }
        return result.value
      }

      const choose = async (sessionId, line) => {
        const live = ctx.sessions?.binding?.(sessionId)?.session
        if (live === undefined || live === null) throw new Error('会话尚未就绪，稍后再试')
        const result = await live.command(line)
        if (result === undefined || result.ok !== true) {
          throw new Error(result?.error?.message ?? '切换角色模型失败')
        }
        if (result.value?.matched !== true) throw new Error('Host 未提供 /devteam-model 命令（插件未安装？）')
        return true
      }

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'dev-team-models',
        order: 20,
        inject: sessionId => ({
          loadCatalog,
          choose: line => choose(sessionId, line),
        }),
      }, DevTeamModels))
    }

    return { inject, apply }
  },
})
