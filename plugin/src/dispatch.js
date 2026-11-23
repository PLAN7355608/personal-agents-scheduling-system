// 派发：建 Worker 会话、投递任务、盯状态。
// 只通过 DSH 公开的 Remote RPC（typertGateway）与会话服务交互，不直接摸内部状态。
import { appendEvent } from './events.js'
import { transition } from './workitems.js'
import { ACTOR, EVENT_TYPE, ITEM_STATUS } from './types.js'
import { normalizeWorkerPermission } from './guard.js'
import { setLaneSession } from './lanes.js'
import { looksLikeFileTask } from './filesniff.js'

function svc(ctx, key) {
  try {
    if (ctx && ctx[key]) return ctx[key]
  } catch {
    /* ignore */
  }
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

function describeError(err) {
  if (!err) return 'unknown'
  const parts = [err.name || 'Error', err.message || String(err)]
  if (err.cause) parts.push('cause=' + (err.cause.code || err.cause.message || String(err.cause)))
  return parts.join(' | ')
}

function makePeer(connection) {
  if (!connection || typeof connection.createPeer !== 'function') {
    throw new Error('connection 服务不可用（需要 Host connection 能力）')
  }
  return connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
}

async function rpc(ctx, namespace, method, payload, peer) {
  const gw = svc(ctx, 'typertGateway')
  if (!gw || typeof gw.invoke !== 'function') throw new Error('typertGateway 服务不可用')
  return gw.invoke({
    namespace,
    method,
    args: { request: payload },
    peer,
    signal: peer && peer.signal,
  })
}

/** 参数不是 {request} 包装的 RPC（例如 modelCatalog 无参）。 */
async function rpcArgs(ctx, namespace, method, args, peer) {
  const gw = svc(ctx, 'typertGateway')
  if (!gw || typeof gw.invoke !== 'function') throw new Error('typertGateway 服务不可用')
  return gw.invoke({
    namespace,
    method,
    args: args || {},
    peer,
    signal: peer && peer.signal,
  })
}

// Worker 提示词 v3：只给干活需要的。任务原文与完成要求**永不截断**；
// 预算只裁可选段（本线上下文/相关背景/输入文件/合并成员）；超硬上限直接报错，绝不静默截任务。
export function buildWorkerPrompt(item, cfg, facts = [], memberTexts = [], personaBlock = '', inputFiles = [], laneContext = [], fileCandidates = []) {
  void personaBlock
  const maxFacts = Math.max(0, Number(cfg.workerPromptMaxFacts ?? 2))
  const budget = Math.max(400, Number(cfg.workerPromptMaxChars) || 4000)
  const HARD_MAX = 30000
  const taskText = String(item.intent || '(未写)')
  const fullText = [taskText, ...memberTexts].join('\n')
  const needsFiles = looksLikeFileTask(fullText)
  const isWriting = /提交|报告|总结|简报|汇报|起草|撰写|文档|稿|材料|方案|说明/i.test(fullText) || item.topic === 'doc'
  const dirs = (cfg.searchDirs && cfg.searchDirs.length) ? cfg.searchDirs.join('、') : (item.workspace || cfg.workspaceRoot)

  const mandatory = []
  mandatory.push('【任务】' + taskText) // 原文完整，不截
  mandatory.push('', '【工作区】' + (item.workspace || cfg.workspaceRoot))
  if (item.projectRoot) mandatory.push('【项目】' + item.projectRoot + (item.scope ? ' / ' + item.scope : ''))
  if (needsFiles) {
    mandatory.push('', '【本地文件】主人说文件在机器里。先找本地文件（find/grep/rg），优先级：当前工作区；可读目录：' + dirs + '。找到就基于本地文件干活；实在找不到再上网，并在 result 里写「本地未找到」。')
    if (fileCandidates && fileCandidates.length) {
      mandatory.push('', '【候选文件】（内核按文件名嗅探，可能相关，自己判断）')
      for (const f of fileCandidates.slice(0, 6)) {
        mandatory.push('- ' + f.path + (f.mtime ? '（' + new Date(f.mtime).toISOString().slice(0, 10) + '）' : ''))
      }
    }
  }
  if (isWriting) {
    mandatory.push('', '【事实纪律】数字/事实要能追溯来源（本地文件或网页）；无法核实的写「正在/持续」或标「待核」；不得编造，不得把旧报道时点改成新月份。')
  }
  const completion = [
    '',
    '【完成要求】',
    '1. 做完调 secretary_work_finish(workitem_id="' + item.id + '", result="结论 + 产物绝对路径")。',
    '2. 做不了调 secretary_work_fail(workitem_id="' + item.id + '", reason="原因")。',
    '3. result 只写结论和路径：不寒暄、不加称呼、不解释过程。',
    '4. 不要反问、不要等确认。',
    ...(isWriting || /docx?|xlsx?|pdf|渲染|预览/.test(fullText)
      ? ['5. 文档/图片类产物可渲染自检，最多 ' + (Number(cfg.workerRenderMax) || 3) + ' 次；纯文本不用渲染；渲染失败可以修一次再渲，超预算就 work_fail 说明。']
      : []),
    ...(needsFiles ? ['6. 要删文件先列出待删清单再删；result 写清删了哪些。'] : []),
  ]

  const optional = []
  if (memberTexts.length) {
    optional.push('', '合并前的原始要求（逐条都要做到）：')
    memberTexts.forEach((t, i) => optional.push((i + 1) + '. ' + String(t)))
  }
  if (inputFiles.length) {
    optional.push('', '【输入文件】')
    for (const f of inputFiles.slice(0, 10)) optional.push('- ' + (f.path || f))
  }
  if (laneContext && laneContext.length) {
    const block = ['', '【本线上下文】']
    for (const c of laneContext.slice(0, 2)) {
      block.push('- 需求：' + String(c.intent || '').slice(0, 80) +
        ' → 结果：' + String(c.result || '（未完成）').slice(0, 120) +
        (c.artifacts && c.artifacts.length ? '（产物：' + c.artifacts.join('、') + '）' : ''))
    }
    optional.push(...block)
  }
  if (facts.length && maxFacts > 0) {
    optional.push('', '【相关背景】')
    for (const f of facts.slice(0, maxFacts)) optional.push('- ' + String(f).slice(0, 140))
  }

  const head = mandatory.join('\n')
  const tail = completion.join('\n')
  const room = Math.max(0, budget - head.length - tail.length - 2)
  let mid = ''
  for (const line of optional) {
    if (mid.length + line.length + 1 > room) break
    mid += (mid ? '\n' : '') + line
  }
  const text = (mid ? head + '\n' + mid : head) + '\n' + tail
  if (text.length > HARD_MAX) {
    throw new Error('任务文本过长（' + text.length + ' 字），超过派单硬上限 ' + HARD_MAX + '；请拆分任务')
  }
  return text
}
function recordSession(db, { sessionId, threadId = null, workitemId = null, role, preset }) {
  db.prepare(
    `INSERT OR REPLACE INTO sessions (id, thread_id, workitem_id, role, preset, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'live', ?)`,
  ).run(sessionId, threadId, workitemId, role, preset, Date.now())
}

/**
 * 派一个任务给 Worker。成功返回 sessionId；失败抛错（调用方负责把任务标记为 failed/blocked）。
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 解析「provider/model」写法；格式不对返回 null。 */
export function parseModelRef(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const i = s.indexOf('/')
  if (i <= 0 || i === s.length - 1) return null
  const provider = s.slice(0, i).trim()
  const model = s.slice(i + 1).trim()
  if (!provider || !model) return null
  return { provider, model }
}

/** 任务 → 工人模型：任务显式指定 > topic 覆盖 > 全局 workerModel > 空（DSH 默认）。 */
export function resolveWorkerModel(cfg, item) {
  const pick = (x) => {
    if (!x || !x.provider || !x.model) return null
    const out = { provider: String(x.provider), model: String(x.model) }
    if (x.reasoningEffort) out.reasoningEffort = String(x.reasoningEffort)
    if (Number.isFinite(Number(x.maxTokens)) && Number(x.maxTokens) > 0) out.maxTokens = Number(x.maxTokens)
    return out
  }
  const explicit = parseModelRef(item && item.model)
  if (explicit) return explicit
  const topic = item && item.topic ? String(item.topic) : ''
  const byTopic = (cfg && cfg.workerModelByTopic) || {}
  if (topic && byTopic[topic]) {
    const picked = pick(byTopic[topic])
    if (picked) return picked
  }
  return pick(cfg && cfg.workerModel)
}

/** 列出 DSH 当前可路由的模型（provider 分组），给配置/面板用。 */
export async function listModelCatalog(ctx) {
  const connection = svc(ctx, 'connection')
  const peer = makePeer(connection)
  return await rpcArgs(ctx, 'session', 'modelCatalog', {}, peer)
}

export async function dispatchWorker({ ctx, cfg, db, item, facts = [], memberTexts = [], personaBlock = '', inputFiles = [], lane = null, laneSessionId = null, laneContext = [], fileCandidates = [], cwd = null, log = () => {} }) {
  const connection = svc(ctx, 'connection')
  const agents = svc(ctx, 'agents')
  const approval = svc(ctx, 'approval')

  const peer = makePeer(connection)

  async function createSession() {
    const created = await rpc(ctx, 'session', 'create', {
      cwd: cwd || item.workspace || cfg.workspaceRoot,
      agentPreset: cfg.workerPreset,
    }, peer)
    const sid = created && (created.sessionId || created.id)
    if (!sid) {
      throw new Error('session.create 未返回 sessionId：' + JSON.stringify(created).slice(0, 300))
    }
    return sid
  }

  // 线内复用：优先用这条线绑定的会话；会话没了就 resume（必须重新挂 preset，否则工具面丢失）
  let sessionId = null
  let reused = false
  if (laneSessionId) {
    try {
      const agent = agents && typeof agents.get === 'function' ? agents.get(laneSessionId) : null
      if (agent) {
        sessionId = laneSessionId
        reused = true
      } else if (agents && typeof agents.resume === 'function') {
        // 空闲被卸载的工人：resume 原会话，保持同一工人（身份不随空闲丢）。
        // 关键：resume 必须带 setup 重新 mount worker preset，否则恢复出来的 agent 没有工具/人设。
        const presetSvc = svc(ctx, 'agentPresets')
        let setup
        if (presetSvc && typeof presetSvc.resolve === 'function' && typeof presetSvc.mount === 'function') {
          const preset = await presetSvc.resolve(cfg.workerPreset)
          if (preset && preset.id) {
            setup = async (agentCtx) => {
              await presetSvc.mount(agentCtx, preset.id)
            }
          }
        }
        if (!setup) throw new Error('agentPresets 服务不可用，无法安全 resume（会丢工具）')
        const handle = await agents.resume({ resumeSessionId: laneSessionId, setup })
        const resumedId = handle && handle.agent && (handle.agent.id || laneSessionId)
        if (resumedId) {
          sessionId = resumedId
          reused = true
          log('已 resume 原工人会话（已重挂 preset）' + sessionId)
        }
      }
    } catch (err) {
      log('resume 原工人会话失败（将新建）：' + describeError(err))
    }
  }
  if (!sessionId) sessionId = await createSession()

  // 工人模型：配置/任务指定了就改，但**只改这个工人会话**（agent.model.select 只往会话事件里写
  // model/selection，不碰 DSH 全局默认；旧做法 session.selectModel 会把选择存成全局默认，已废弃）。
  const desiredModel = resolveWorkerModel(cfg, item)
  if (!desiredModel && item && item.model) {
    log('任务指定的模型格式不对（应为 provider/model）：' + String(item.model))
  }
  let appliedModel = null
  if (desiredModel) {
    try {
      const currentAgent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null
      if (currentAgent && currentAgent.model && typeof currentAgent.model.select === 'function') {
        const llm = svc(ctx, 'llm')
        if (llm && typeof llm.resolveCallConfig === 'function') {
          await llm.resolveCallConfig({
            provider: desiredModel.provider,
            model: desiredModel.model,
            ...(desiredModel.reasoningEffort ? { reasoningEffort: desiredModel.reasoningEffort } : {}),
          })
        }
        currentAgent.model.select({
          provider: desiredModel.provider,
          model: desiredModel.model,
          ...(desiredModel.reasoningEffort ? { reasoningEffort: desiredModel.reasoningEffort } : {}),
        })
        appliedModel = desiredModel
        log('工人模型（仅本会话）：' + desiredModel.provider + '/' + desiredModel.model)
      } else {
        throw new Error('agent.model.select 不可用（DSH 运行时形态变化）')
      }
    } catch (err) {
      log('设置工人模型失败（用默认）：' + describeError(err))
    }
  }

  // 工人审批策略：默认 ask（越权操作上报主人等审批，失败也是 fail-closed）；
  // 以前的 'never' 语义是"需要审批的操作自动拒绝"，注释写成"一律放行"是错的。
  try {
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null
    if (agent && approval && typeof approval.setPolicy === 'function') {
      const policy = String(cfg.workerApprovalPolicy || 'ask') === 'never' ? 'never' : 'ask'
      approval.setPolicy(agent, policy)
      log('worker 审批策略=' + policy + '：' + sessionId)
    }
  } catch (err) {
    log('worker 审批策略设置失败（继续）：' + describeError(err))
  }

  // Worker 权限档：任务可显式请求（Elevated），否则用配置默认
  try {
    const sessions = svc(ctx, 'sessions')
    const presets = svc(ctx, 'permissionPresets')
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
    const target = normalizeWorkerPermission(item.permission, cfg.workerPermissionPreset)
    if (session && presets && typeof presets.set === 'function') {
      presets.set(session, target)
      log('worker 权限档=' + target + '（session ' + sessionId + '）')
    }
  } catch (err) {
    log('worker 权限档设置失败（沿用默认）：' + describeError(err))
  }

  recordSession(db, {
    sessionId,
    workitemId: item.id,
    role: 'worker',
    preset: cfg.workerPreset,
  })
  if (lane && lane.id) {
    try { setLaneSession(db, lane.id, sessionId, normalizeWorkerPermission(item.permission, cfg.workerPermissionPreset)) } catch { /* ignore */ }
  }
  transition(db, item.id, ITEM_STATUS.RUNNING, {
    reason: 'dispatch worker',
    payload: { sessionId, workerType: cfg.workerPreset, model: appliedModel || undefined },
  })
  appendEvent(db, {
    type: EVENT_TYPE.SESSION_BOUND,
    ownerId: item.ownerId,
    workitemId: item.id,
    sessionId,
    channel: item.sourceChannel,
    actor: ACTOR.KERNEL,
    payload: { role: 'worker', preset: cfg.workerPreset },
  })

  const promptText = buildWorkerPrompt(item, cfg, facts, memberTexts, personaBlock, inputFiles, laneContext, fileCandidates)
  const promptOnce = async (sid) => rpc(ctx, 'session', 'prompt', {
    requestId: 'sec-' + item.id + '-' + Date.now().toString(36),
    sessionId: sid,
    mode: 'queue',
    content: [{ type: 'text', text: promptText }],
  }, peer)
  try {
    await promptOnce(sessionId)
  } catch (err) {
    if (!reused) throw err
    log('复用会话失败，重建 worker：' + describeError(err))
    sessionId = await createSession()
    reused = false
    if (lane && lane.id) { try { setLaneSession(db, lane.id, sessionId) } catch { /* ignore */ } }
    await promptOnce(sessionId)
  }

  log('已派单 ' + item.id + ' → worker ' + sessionId)
  return sessionId
}

/** 往任意会话里塞一条消息（回灌用）。 */
export async function promptSession(ctx, sessionId, text, { log = () => {} } = {}) {
  const connection = svc(ctx, 'connection')
  const peer = makePeer(connection)
  await rpc(ctx, 'session', 'prompt', {
    requestId: 'sec-note-' + Date.now().toString(36),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: String(text || '') }],
  }, peer)
  log('已回灌到会话 ' + sessionId)
}

export function cancelWorkerSession(ctx, sessionId) {
  try {
    const gw = svc(ctx, 'typertGateway')
    if (!gw || !sessionId) return
    const agents = svc(ctx, 'agents')
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null
    if (agent && typeof agent.interrupt === 'function') agent.interrupt('owner cancel')
  } catch {
    /* ignore */
  }
}

export function servicesReady(ctx) {
  return {
    typertGateway: !!svc(ctx, 'typertGateway'),
    connection: !!svc(ctx, 'connection'),
    agents: !!svc(ctx, 'agents'),
  }
}

export { describeError, svc }
