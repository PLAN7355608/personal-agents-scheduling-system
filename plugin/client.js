/**
 * 个人 Agent 秘书 · Client 半边（只读）
 *
 * 右下角一枚小药丸：显示「在办 N / 需要人 M」；点开是只读清单。
 * 数据源：Host 的 GET /secretary/v1/panel（同源，5 秒轮询）。
 * 规矩：面板可「批准/拒绝工具申请」（同源 POST），其它仍是只读；重活永远走对话。
 */
window.__ModuleLoader__.load({
  id: 'dsh-secretary-core',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PATH = '/secretary/v1/panel'
    const POLL_MS = 5000

    const C = {
      bg: 'rgba(18,20,26,0.94)',
      card: 'rgba(26,29,37,0.97)',
      border: 'rgba(255,255,255,0.14)',
      fg: '#eef1f7',
      dim: 'rgba(235,238,245,0.60)',
      ok: '#5ad18a',
      warn: '#ffb84d',
      bad: '#ff7a7a',
      accent: '#8ea8ff',
    }

    // 状态、来源的中文名（界面只给人看，接口字段仍是英文）
    const STATUS_TEXT = {
      intake: '刚收到', triaged: '已分类', queued: '排队中', running: '在办',
      blocked: '卡住了', waiting_human: '等人拍板', done: '完成', failed: '失败',
      cancelled: '已取消', merged: '已合并',
    }
    const SOURCE_TEXT = { auto: '自动', suggest: '建议', manual: '手填' }
    function statusText(s) { return STATUS_TEXT[s] || String(s || '') }
    function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '' }
    function scopeChip(w, laneById) {
      const project = baseName(w.projectRoot)
      const parts = []
      if (project) parts.push(project)
      if (w.scope) parts.push(w.scope)
      if (!parts.length) return null
      const lane = w.laneId ? laneById[w.laneId] : null
      return h('div', { style: { fontSize: 10.5, color: C.accent, marginTop: 1 } },
        (lane && lane.label ? lane.label + ' · ' : '') + parts.join(' / '))
    }

    function usePanel() {
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        const tickFn = async () => {
          try {
            const res = await fetch(PATH, { headers: { accept: 'application/json' } })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const json = await res.json()
            if (!alive) return
            setData(json)
            setErr('')
          } catch (e) {
            if (alive) setErr(String((e && e.message) || e))
          }
        }
        tickFn()
        const timer = setInterval(tickFn, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [tick])
      return { data, err, refresh: () => setTick((t) => t + 1) }
    }

    function tabStyle(active) {
      return {
        fontSize: 10.8, padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
        color: active ? C.fg : C.dim,
        background: active ? 'rgba(255,255,255,0.10)' : 'transparent',
        border: '1px solid ' + (active ? C.border : 'transparent'),
      }
    }

    function dot(color) {
      return h('span', {
        style: {
          display: 'inline-block', width: 7, height: 7, borderRadius: 99,
          background: color, marginRight: 6, verticalAlign: 'middle',
        },
      })
    }

    function copyText(text) {
      try { navigator.clipboard.writeText(String(text)) } catch { /* ignore */ }
    }

    function Pill() {
      const { data, err, refresh } = usePanel()
      const [open, setOpen] = React.useState(false)
      const [showAll, setShowAll] = React.useState(false)
      const [detail, setDetail] = React.useState(null)
      const [busyId, setBusyId] = React.useState('')
      const counts = (data && data.counts) || {}
      const active = (data && data.active) || []
      const lanes = (data && data.lanes) || []
      const laneById = {}
      for (const l of lanes) laneById[l.id] = l
      const activeLanes = lanes.filter((l) => l.status === 'active').length
      const toolReqs = (data && data.toolRequests) || { pending: 0, items: [] }
      const costToday = (data && data.costToday) || { tokens: 0, costCny: 0 }
      const costMonth = (data && data.costMonth) || { tokens: 0, costCny: 0 }
      const httpResults = (data && data.httpResults) || []
      const needs = active.filter((w) => w.needsHuman)
      const nActive = active.length
      const nNeeds = needs.length
      const tone = err ? C.bad : (nNeeds > 0 ? C.warn : C.ok)

      const openDetail = async (id) => {
        if (detail && detail.id === id) { setDetail(null); return }
        setDetail({ id, loading: true })
        try {
          const res = await fetch('/secretary/v1/workitems/' + encodeURIComponent(id) + '/trace', { headers: { accept: 'application/json' } })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          setDetail({ id, data: await res.json() })
        } catch (e) {
          setDetail({ id, error: String((e && e.message) || e) })
        }
      }

      const decideRequest = async (id, approve) => {
        setBusyId(id)
        try {
          const res = await fetch('/secretary/v1/tool-requests/decide', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ id, approve, scope: 'once' }),
          })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          refresh()
        } catch (e) {
          setBusyId('')
          setDetail({ id: 'decide-error', error: String((e && e.message) || e) })
        } finally {
          setBusyId('')
        }
      }

      return h('div', {
        style: {
          position: 'fixed', right: 16, bottom: 16, zIndex: 9000,
          fontFamily: 'system-ui, "Microsoft YaHei UI", sans-serif',
          color: C.fg, userSelect: 'none',
        },
      },
      open
        ? h('div', {
            style: {
              width: 320, maxHeight: '60vh', overflow: 'auto', marginBottom: 8,
              background: C.card, border: '1px solid ' + C.border, borderRadius: 12,
              boxShadow: '0 12px 32px rgba(0,0,0,0.35)', padding: '10px 12px',
            },
          },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '个人 Agent 秘书'),
            h('div', { style: { fontSize: 11, color: C.dim } }, '面板可批'),
          ),
          h('div', { style: { fontSize: 11.5, color: C.dim, marginBottom: 8 } },
            '在办 ' + nActive + ' · 干活线 ' + activeLanes + ' · 需要人 ' + nNeeds + ' · 完成 ' + (counts.done || 0) +
            ' · 失败 ' + (counts.failed || 0) + ' · 卡住 ' + (counts.blocked || 0)),
          h('div', { style: { fontSize: 10.5, color: C.dim, marginBottom: 6 } },
            '今日 tokens ' + costToday.tokens +
            (costToday.costCny > 0 ? ' · ¥' + Number(costToday.costCny).toFixed(2) : '') +
            ' ｜ 本月 ' + costMonth.tokens +
            (costMonth.costCny > 0 ? ' · ¥' + Number(costMonth.costCny).toFixed(2) : '')),
          h('div', { style: { display: 'flex', gap: 6, marginBottom: 6 } },
            h('span', {
              onClick: () => setShowAll(false),
              style: tabStyle(!showAll),
            }, '只看在办'),
            h('span', {
              onClick: () => setShowAll(true),
              style: tabStyle(showAll),
            }, '看全部（含最近结束）')),
          err
            ? h('div', { style: { fontSize: 11.5, color: C.bad, marginBottom: 6 } }, '接口错误：' + err)
            : null,
          httpResults.length
            ? h('div', { style: { marginBottom: 6 } },
                h('div', { style: { fontSize: 11, color: C.ok, marginBottom: 2 } }, '外部入口的结果：'),
                httpResults.map((r) => h('div', {
                  key: r.id,
                  onClick: () => openDetail(r.id),
                  style: { fontSize: 11, color: C.fg, cursor: 'pointer', padding: '3px 6px', borderRadius: 6, background: 'rgba(90,209,138,0.10)', marginBottom: 3 },
                },
                statusText(r.status) + ' · ' + (r.intent || r.id).slice(0, 34) +
                (r.artifacts && r.artifacts.length ? ' · 产物 ' + r.artifacts.length : ''))))
            : null,
          (httpResults.length || (data && (data.briefings || []).length) || (data && data.archive))
            ? null
            : null,
          (data && (data.briefings || []).length)
            ? h('div', { style: { fontSize: 11, color: C.fg, marginBottom: 6, padding: '4px 6px', borderRadius: 6, background: 'rgba(120,160,255,0.10)' } },
                h('div', { style: { color: C.dim, marginBottom: 2 } }, '最新简报：'),
                String(data.briefings[0].text || '').slice(0, 200))
            : null,
          (data && data.archive)
            ? h('div', { style: { fontSize: 11, color: C.ok, marginBottom: 6 } }, '归档候选：' + (data.archive.count || 0) + ' 个（只提议）')
            : null,
          toolReqs.pending > 0
            ? h('div', { style: { marginBottom: 8 } },
                h('div', { style: { fontSize: 11, color: C.warn, marginBottom: 4 } }, '工具申请待批（' + toolReqs.pending + '）：'),
                toolReqs.items.map((r) => h('div', {
                  key: r.id,
                  style: {
                    padding: '5px 7px', marginBottom: 5, borderRadius: 8,
                    background: 'rgba(255,184,77,0.10)', border: '1px solid rgba(255,184,77,0.25)',
                  },
                },
                h('div', { style: { fontSize: 11, color: C.fg, lineHeight: 1.4 } }, r.tool + '：' + String(r.reason || '').slice(0, 60)),
                h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
                  h('span', {
                    onClick: () => busyId !== r.id && decideRequest(r.id, true),
                    style: {
                      fontSize: 11, padding: '2px 10px', borderRadius: 999, cursor: busyId === r.id ? 'default' : 'pointer',
                      background: 'rgba(90,209,138,0.20)', color: C.ok, opacity: busyId === r.id ? 0.6 : 1,
                    },
                  }, '批准'),
                  h('span', {
                    onClick: () => busyId !== r.id && decideRequest(r.id, false),
                    style: {
                      fontSize: 11, padding: '2px 10px', borderRadius: 999, cursor: busyId === r.id ? 'default' : 'pointer',
                      background: 'rgba(255,122,122,0.16)', color: C.bad, opacity: busyId === r.id ? 0.6 : 1,
                    },
                  }, '拒绝')))))
            : null,
          showAll
            ? ((data && data.recent && data.recent.length)
                ? data.recent.map((w) => h('div', {
                    key: w.id,
                    onClick: () => openDetail(w.id),
                    style: {
                      padding: '6px 8px', marginBottom: 6, borderRadius: 8, cursor: 'pointer',
                      background: detail && detail.id === w.id ? 'rgba(142,168,255,0.14)' : 'rgba(255,255,255,0.03)',
                      borderLeft: '3px solid ' + (w.status === 'done' ? C.ok : (w.status === 'failed' ? C.bad : C.dim)),
                    },
                  },
                  h('div', { style: { fontSize: 12, lineHeight: 1.4 } }, dot(w.status === 'done' ? C.ok : (w.status === 'failed' ? C.bad : C.dim)), (w.intent || '(无描述)').slice(0, 80)),
                  scopeChip(w, laneById),
                  h('div', { style: { fontSize: 10.5, color: C.dim, marginTop: 2 } },
                    statusText(w.status) + ' · ' + w.id.slice(0, 14) +
                    (w.guidance ? ' · 人工指导 ' + w.guidance : '') +
                    (w.revisions ? ' · 修订 ' + w.revisions : '') +
                    (w.cost && w.cost.tokens ? ' · ' + w.cost.tokens + ' tok' : '') +
                    (w.sessionId ? ' · 会话 ' + String(w.sessionId).replace(/^session-/, '').slice(0, 8) : '')),
                  w.latestRevision
                    ? h('div', { style: { fontSize: 10, color: C.ok, marginTop: 1 } },
                        '最新：' + baseName(w.latestRevision.path) + '（v' + w.latestRevision.revision + '）')
                    : null,
                  ))
                : h('div', { style: { fontSize: 12, color: C.dim } }, '最近没有结束的任务。'))
            : (nActive === 0
                ? h('div', { style: { fontSize: 12, color: C.dim } }, '现在没有在办的事。')
                : active.slice(0, 8).map((w) => h('div', {
                    key: w.id,
                    onClick: () => openDetail(w.id),
                    style: {
                      padding: '6px 8px', marginBottom: 6, borderRadius: 8, cursor: 'pointer',
                      background: 'rgba(255,255,255,0.04)',
                      borderLeft: '3px solid ' + (w.needsHuman ? C.warn : C.accent),
                    },
                  },
                  h('div', { style: { fontSize: 12, lineHeight: 1.4 } },
                    dot(w.needsHuman ? C.warn : C.accent),
                    (w.intent || '(无描述)').slice(0, 80)),
                  scopeChip(w, laneById),
                  h('div', { style: { fontSize: 10.5, color: C.dim, marginTop: 2 } },
                    statusText(w.status) + ' · ' + w.id.slice(0, 14) +
                    (w.guidance ? ' · 人工指导 ' + w.guidance : '') +
                    (w.revisions ? ' · 修订 ' + w.revisions : '') +
                    (w.cost && w.cost.tokens ? ' · ' + w.cost.tokens + ' tok' : '') +
                    (w.sessionId ? ' · 会话 ' + String(w.sessionId).replace(/^session-/, '').slice(0, 8) : '')),
                  w.latestRevision
                    ? h('div', { style: { fontSize: 10, color: C.ok, marginTop: 1 } },
                        '最新：' + baseName(w.latestRevision.path) + '（v' + w.latestRevision.revision + '）')
                    : null,
                  w.lastStep
                    ? h('div', { style: { fontSize: 10.5, color: w.lastStep.running ? C.accent : (w.lastStep.ok ? C.dim : C.bad), marginTop: 1 } },
                        w.lastStep.running
                          ? '正在执行：' + w.lastStep.tool
                          : '最近一步：' + w.lastStep.tool +
                            (w.lastStep.durationMs !== null ? '（' + w.lastStep.durationMs + 'ms）' : '') +
                            (w.lastStep.ok ? '' : ' 失败'))
                    : null,
                ))),
          detail
            ? h('div', { style: { marginTop: 8, borderTop: '1px solid ' + C.border, paddingTop: 8 } },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 } },
                  h('span', { style: { fontSize: 11.5, fontWeight: 600 } }, '详情 ' + detail.id.slice(0, 14)),
                  h('span', { style: { fontSize: 10.5, color: C.dim, cursor: 'pointer' }, onClick: () => setDetail(null) }, '收起')),
                detail.loading ? h('div', { style: { fontSize: 11, color: C.dim } }, '加载中…') : null,
                detail.error ? h('div', { style: { fontSize: 11, color: C.bad } }, '加载失败：' + detail.error) : null,
                detail.data
                  ? h('div', null,
                      h('div', { style: { fontSize: 10.5, color: C.dim, margin: '4px 0' } },
                        '步骤 ' + (detail.data.summary ? detail.data.summary.steps : 0) +
                        (detail.data.summary && detail.data.summary.toolFail ? '（失败 ' + detail.data.summary.toolFail + '）' : '') +
                        ' · 产物 ' + (detail.data.summary ? detail.data.summary.artifacts : 0) +
                        (detail.data.summary && detail.data.summary.durationMs ? ' · ' + Math.round(detail.data.summary.durationMs / 1000) + 's' : '')),
                      detail.data.workitem && detail.data.workitem.sessionId
                        ? h('div', {
                            style: { fontSize: 10.5, color: C.accent, cursor: 'pointer', marginBottom: 4 },
                            onClick: () => copyText(detail.data.workitem.sessionId),
                          }, '会话 ' + String(detail.data.workitem.sessionId).replace(/^session-/, '').slice(0, 8) + '（点击复制）')
                        : null,
                      detail.data.workitem && detail.data.workitem.laneId
                        ? h('div', { style: { fontSize: 10.5, color: C.dim, marginBottom: 2 } },
                            '线 ' + (() => {
                              const lane = laneById[detail.data.workitem.laneId]
                              return lane ? (lane.label || String(lane.key || '').replace(/^session:/, '会话 ').replace(/^peer:/, '通道 ')) : detail.data.workitem.laneId
                            })())
                        : null,
                      detail.data.workitem && detail.data.workitem.workspace
                        ? h('div', { style: { fontSize: 10.5, color: C.dim, marginBottom: 2 } },
                            '工作区 ' + detail.data.workitem.workspace)
                        : null,
                      detail.data.workitem && (detail.data.workitem.projectRoot || detail.data.workitem.scope)
                        ? h('div', { style: { fontSize: 10.5, color: C.dim, marginBottom: 4 } },
                            '项目 ' + (baseName(detail.data.workitem.projectRoot) || '—') +
                            (detail.data.workitem.scope ? ' / ' + detail.data.workitem.scope : '') +
                            '（' + (SOURCE_TEXT[detail.data.workitem.scopeSource] || detail.data.workitem.scopeSource || '—') +
                            (detail.data.workitem.scopeConfidence ? ' ' + Math.round(detail.data.workitem.scopeConfidence * 100) + '%' : '') + '）')
                        : null,
                      (detail.data.steps || []).slice(-8).map((s, i) => h('div', {
                        key: i,
                        style: { fontSize: 10.5, color: s.ok ? C.dim : C.bad, marginBottom: 2 },
                      }, (s.ok ? '✓ ' : '✗ ') + (s.tool || '?') + (s.durationMs !== null && s.durationMs !== undefined ? ' ' + s.durationMs + 'ms' : ''))),
                      (detail.data.artifacts || []).length
                        ? h('div', { style: { fontSize: 10.5, color: C.dim, marginTop: 4 } },
                            '产物：' + detail.data.artifacts.map((a) => String(a.path).split(/[\\/]/).pop()).join('、'))
                        : null,
                      detail.data.summary && detail.data.summary.failure
                        ? h('div', { style: { fontSize: 10.5, color: C.bad, marginTop: 4 } }, '失败原因：' + String(detail.data.summary.failure).slice(0, 120))
                        : null)
                  : null)
            : null,
          data && data.lastError
            ? h('div', { style: { fontSize: 10.5, color: C.bad, marginTop: 4 } }, '最近错误：' + String(data.lastError).slice(0, 120))
            : null,
        )
        : null,
      h('div', {
        onClick: () => setOpen((v) => !v),
        title: '个人 Agent 秘书（只读）',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
          background: C.bg, border: '1px solid ' + C.border, borderRadius: 999,
          padding: '6px 12px', fontSize: 12, lineHeight: 1,
          boxShadow: '0 6px 20px rgba(0,0,0,0.30)', color: C.fg,
        },
      },
      dot(tone),
      h('span', null, '秘书'),
      h('span', { style: { color: C.dim } }, '在办 ' + nActive),
      nNeeds > 0 ? h('span', { style: { color: C.warn, fontWeight: 600 } }, '需要人 ' + nNeeds) : null))
    }

    function apply(ctx) {
      try {
        const slots = (ctx && ctx.slots) ||
          (ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null)
        if (!slots || typeof slots.inject !== 'function') {
          console.warn('[secretary] 没有 slots 服务，面板跳过')
          return
        }
        const mount = () => slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: 'secretary-status-pill', order: 8100, label: () => '个人 Agent 秘书' },
          Pill,
        ))
        if (typeof ctx.effect === 'function') ctx.effect(mount, 'secretary: 右下角只读药丸')
        else mount()
      } catch (e) {
        console.error('[secretary] 面板挂载失败：', e)
      }
    }

    return { inject: ['slots'], apply }
  },
})
