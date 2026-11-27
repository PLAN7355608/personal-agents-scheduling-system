// dsh-secretary-core —— 个人 Agent 秘书的内核（Host 常驻）。
//
// 职责（v0）：
//   1. WorkItem 状态机 + 事件账本（SQLite）
//   2. 工具：secretary_create_task / _status / _wait / _work_finish / _work_fail
//   3. 派单：给任务建 Worker 会话、投递任务、盯超时
//   4. 只读 HTTP：/secretary/v1/{status,workitems,workitems/:id/trace}
//
// 不做什么（按架构约定）：
//   - 不思考：不调模型；判断留给 Relay / Worker / 未来的 judge 服务
//   - 不管渠道：v0 只接 GUI（Relay 会话），外部入口以后加 adapter
//   - 不改别人的会话/插件
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getSchemaVersion, openDb } from './src/db.js'
import { appendEvent, countEvents, readEvents } from './src/events.js'
import {
  acceptWorkItem, cancelWorkItem, createWorkItem, finishWorkItem, failWorkItem, getWorkItem, isTerminal, listMergeMembers, mergeWorkItems,
  normalizeReviewMode, rejectWorkItem, REVIEW_MODES, submitWorkItem, validateSubmission, splitMerged,
  listWorkItems, rebuildProjection, summaryCounts, transition,
} from './src/workitems.js'
import { dispatchWorker, listModelCatalog, parseModelRef, promptSession, svc } from './src/dispatch.js'
import { reviewSubmissionWithModel } from './src/review.js'
import { acquireLease, expireLeases, releaseItemLeases } from './src/leases.js'
import { applyHysteresis, decideAdmission, isOverloaded, planConcurrency, probeHardware, sampleUsage } from './src/resources.js'
import {
  armAfterTask, attachOccurrence, claimOccurrence, createSchedule, dueSchedules, getSchedule, listSchedules,
  removeSchedule, setScheduleStatus,
} from './src/scheduler.js'
import { findSilentDispatches, recoverOnStart } from './src/recovery.js'
import { decideDelivery, deliveryBudget } from './src/reporter.js'
import { classifyTopic } from './src/topic.js'
import { suggestions as divisionSuggestions, summarize as statsSummary } from './src/stats.js'
import { previewPrune, runPrune } from './src/prune.js'
import { getPolicy, inbound as gatewayInbound, listPolicies } from './src/gateway.js'
import { ack as outboxAck, enqueue as outboxEnqueue, listPending as outboxList, stats as outboxStats } from './src/outbox.js'
import { agentSessionId, buildWorkerToolEvent, redactText, toolNameOf } from './src/worker-trace.js'
import { normalizeWorkerPermission, relayDenialMessage, relayToolAllowed, workerDenialMessage, workerToolAllowed } from './src/guard.js'
import { resolveDbPath, resolveWorkspaceRoot } from './src/paths.js'
import {
  adoptSession, claimLane, ensureLane, findLaneRef, focusFromText, getLaneById, laneContext as laneRecentContext, laneKeyFor, listLanes, setLaneMeta,
  nextQueuedOnLane, releaseLane, repairStuckLanes, sweepIdleLanes,
} from './src/lanes.js'
import { inferScope } from './src/scope.js'
import { resolveTaskWorkspace } from './src/workspace.js'
import { looksLikeFileTask, sniffFiles } from './src/filesniff.js'
import { analyzeDeletionCommand } from './src/deletion-guard.js'
import { readSessionHeader, readSessionEvents, sessionAgeDays, vetWorkerPreset } from './src/session-store.js'
import { auditWorkerGuidance, sessionHasManualInput } from './src/session-audit.js'
import { addRevision, countRevisions, latestRevision, scanRecentFiles } from './src/revisions.js'
import { costFor, costTotals, estimateCost, extractUsage, recordUsage } from './src/cost.js'
import { countPendingToolRequests, createToolRequest, decideToolRequest, escalateToolRequest, getToolRequest, hasToolGrant, learnedToolGrant, listToolRequests, toolRequestForbidden } from './src/tool-requests.js'
import { protectedBoundaryReason } from './src/protected.js'
import { pickDuplicate } from './src/dedupe.js'
import { JUDGE_KIND, judgeToolDecision } from './src/judge.js'
import { composeReply } from './src/language.js'
import { listBoard, postBoard, removeBoard } from './src/board.js'
import { buildBrief, buildReview, writeReport } from './src/briefing.js'
import { applyArchive, scanArchive } from './src/archive.js'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildWorkitemTrace } from './src/trace.js'
import { buildPersonaBlock, describePersona, setPersona } from './src/persona.js'
import { forget, recall, remember, stats as memoryStats } from './src/memory.js'
import { ACTOR, DELIVERY_LEVEL, EVENT_TYPE, ITEM_STATUS } from './src/types.js'

export const name = 'dsh-secretary-core'
export const inject = ['tools']

const DEFAULTS = {
  dbPath: '',
  workspaceRoot: '',
  relayPreset: 'secretary-relay',
  workerPreset: 'secretary-worker',
  ownerId: 'owner',
  maxWorkers: 2,
  workerTimeoutSec: 900,
  waitDefaultSec: 45,
  waitMaxSec: 120,
  httpToken: '',
  dispatchDelayMs: 4000,
  merge: { enabled: true, minConfidence: 0.7, maxMembers: 5 },
  reporter: { dailyL3Budget: 6, quietHours: [23, 8] },
  traceWorkerTools: true,
  workerPermissionPreset: 'workspace-write',
  workerApprovalPolicy: 'ask',
  guiNotify: { enabled: false },
  laneIdleTtlMs: 30 * 60 * 1000,
  seedMaxEvents: 500,
  judge: { enabled: true, provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 300, timeoutMs: 15000 },
  // 花费账本单价（CNY/百万 token）：{'provider/model': {inputPerM, outputPerM, cacheReadPerM}}
  cost: { rates: {} },
  learnToolPolicies: true,
  allowedWorkspaces: [],
  workerPromptMaxChars: 4000,
  workerPromptMaxFacts: 2,
  language: { enabled: false, provider: '', model: '', maxTokens: 220, timeoutMs: 8000 },
  searchDirs: [],
  deletionGuard: { maxFilesAuto: 50 },
  briefing: { enabled: false, dailyAt: '08:30', weekly: true, weeklyDay: 1, weeklyAt: '09:00' },
  archive: { enabled: false, watchDirs: [], rules: [], minAgeHours: 24, allowApply: false },
  templatesDir: '',
  workerModel: { provider: '', model: '', reasoningEffort: '' },
  workerModelByTopic: {},
  workerModelAuto: { enabled: false },
  workerDefaultSelection: null,
  defaultScopeMode: 'suggest',
  projects: [],
  // 验收：self 提交即完成 | auto/model 只读核对 | owner 等主人点
  review: { mode: 'self', provider: 'deepseek-account', model: 'deepseek-flash', timeoutMs: 20000 },
  // 资源并发：内存硬闸门 + CPU 软上限（详见 13 号设计文档）
  resources: { maxConcurrentWorkers: 4, reserveMB: 512, peakMB: 700, cpuFactor: 0.6, confirmRounds: 3 },
}

const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return [{ type: 'text', text }]
  },
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function describeError(err) {
  if (!err) return 'unknown'
  const parts = [err.name || 'Error', err.message || String(err)]
  if (err.cause) parts.push('cause=' + (err.cause.code || err.cause.message || String(err.cause)))
  return parts.join(' | ')
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  cfg.dbPath = resolveDbPath(cfg.dbPath)
  cfg.workspaceRoot = resolveWorkspaceRoot(cfg.workspaceRoot)

  const log = (...args) => {
    try {
      const line = '[secretary] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
      // eslint-disable-next-line no-console
      console.log(line)
    } catch {
      /* ignore */
    }
  }

  const db = openDb({ path: cfg.dbPath })
  const state = {
    startedAt: Date.now(),
    lastError: null,
    running: new Map(),
    hardware: null,
    sample: null,
    plan: null,
    concurrency: { current: 1, streak: 0 },
    overloaded: false,
  }
  let lastResourceAt = 0

  function runningWorkerCount() {
    try {
      return Number(db.prepare("SELECT COUNT(*) AS c FROM workitems WHERE status = 'running'").get().c || 0)
    } catch {
      return 0
    }
  }

  /** 30s 心跳：采一次资源 → 重算并发（降立即生效、升要连续确认）→ 过载判定。 */
  function refreshResources(now = Date.now()) {
    if (now - lastResourceAt < 30000) return
    lastResourceAt = now
    try {
      state.sample = sampleUsage({})
      const plan = planConcurrency({ hardware: state.hardware, sample: state.sample, running: runningWorkerCount() })
      state.plan = plan
      const h = applyHysteresis({
        current: state.concurrency.current,
        desired: plan.desired,
        streak: state.concurrency.streak,
        confirmRounds: Number(cfg.resources && cfg.resources.confirmRounds) || 3,
      })
      if (h.changed) log('并发调整：' + state.concurrency.current + ' → ' + h.next + '（' + plan.reason + '）')
      state.concurrency = { current: h.next, streak: h.streak }
      state.overloaded = isOverloaded(state.sample, cfg.resources).overloaded
      if (state.overloaded) log('资源过载信号：暂时收紧派单')
    } catch (err) {
      log('资源采样失败：' + describeError(err))
    }
  }

  // 启动时采一次设备情况（异步，不阻塞加载）
  probeHardware({})
    .then((h) => {
      state.hardware = h
      log('硬件：' + h.cores + ' 核 / ' + h.totalMB + 'MB 内存 / ' + (h.gpu ? 'GPU ' + h.gpu.name : 'GPU 未检测'))
      refreshResources(Date.now())
    })
    .catch((err) => log('硬件探测失败：' + describeError(err)))

  /** 到点的计划：认领（幂等）→ 建任务 → 走同一条派单路。 */
  function fireDueSchedules() {
    let due = []
    try {
      due = dueSchedules(db, { now: Date.now(), limit: 5 })
    } catch { return }
    for (const s of due) {
      const now = Date.now()
      if (s.cooldownUntil && now < s.cooldownUntil) continue
      if (s.maxPerDay) {
        try {
          const d = new Date()
          d.setHours(0, 0, 0, 0)
          const n = Number(db.prepare('SELECT COUNT(*) AS c FROM occurrences WHERE schedule_id = ? AND fired_at >= ?').get(s.id, d.getTime()).c || 0)
          if (n >= Number(s.maxPerDay)) {
            appendEvent(db, {
              type: EVENT_TYPE.SCHEDULE_SKIPPED,
              ownerId: cfg.ownerId,
              actor: ACTOR.SYSTEM,
              payload: { scheduleId: s.id, reason: '今日已达上限 ' + s.maxPerDay, firedToday: n },
            })
            // 推到下一次，避免每 30 秒重复判断
            try { claimOccurrence(db, s, { now }) } catch { /* ignore */ }
            continue
          }
        } catch { /* ignore */ }
      }
      let claim = null
      try {
        claim = claimOccurrence(db, s, { now })
      } catch (err) {
        log('计划认领失败：' + describeError(err))
        continue
      }
      if (!claim.claimed) continue
      const tpl = s.template || {}
      try {
        const laneId = tpl.lane ? (findLaneRef(db, tpl.lane) || {}).id || null : null
        const { item } = createWorkItem(db, {
          ownerId: cfg.ownerId,
          channel: 'gui',
          peer: cfg.ownerId,
          kind: 'task',
          intent: String(tpl.text),
          inputs: [],
          permission: normalizeWorkerPermission(tpl.permission, cfg.workerPermissionPreset),
          laneId,
          workspace: tpl.workspace || cfg.workspaceRoot,
          origin: 'schedule',
          topic: tpl.topic || classifyTopic(String(tpl.text)),
          model: tpl.model || null,
          reviewMode: tpl.reviewMode || null,
          acceptance: parseAcceptanceLines(tpl.acceptance),
        })
        transition(db, item.id, ITEM_STATUS.TRIAGED, { reason: 'schedule: ' + s.id })
        transition(db, item.id, ITEM_STATUS.QUEUED, { reason: 'route: schedule' })
        attachOccurrence(db, claim.occurrenceKey, item.id)
        appendEvent(db, {
          type: EVENT_TYPE.SCHEDULE_FIRED,
          ownerId: cfg.ownerId,
          workitemId: item.id,
          actor: ACTOR.SYSTEM,
          payload: {
            scheduleId: s.id,
            title: s.title,
            occurrenceKey: claim.occurrenceKey,
            scheduledFor: claim.scheduledFor,
            latencyMs: Math.max(0, now - claim.scheduledFor),
            nextRunAt: (getSchedule(db, s.id) || {}).nextRunAt || null,
          },
        })
        scheduleDispatch(getWorkItem(db, item.id))
      } catch (err) {
        log('定时触发建任务失败：' + describeError(err))
      }
    }
  }
  const pendingDispatch = new Map()
  const strayTimers = new Set()
  ctx.effect(() => () => {
    for (const t of strayTimers) clearTimeout(t)
    strayTimers.clear()
    for (const t of pendingDispatch.values()) clearTimeout(t)
    pendingDispatch.clear()
  })

  ctx.effect(() => () => {
    try { db.close() } catch { /* ignore */ }
  })

  appendEvent(db, {
    type: EVENT_TYPE.KERNEL_STARTED,
    ownerId: cfg.ownerId,
    actor: ACTOR.KERNEL,
    payload: { workspaceRoot: cfg.workspaceRoot, relayPreset: cfg.relayPreset, workerPreset: cfg.workerPreset },
  })

  // 启动恢复：账本 → 投影；上一次进程留下的半截任务显式标 blocked（不假装成功）。
  try {
    const rec = recoverOnStart(db, { log })
    log('启动恢复完成：重建 ' + rec.rebuilt + ' 条，running→blocked ' + rec.blockedRunning + '，queued→blocked ' + rec.blockedQueued)
  } catch (err) {
    log('启动恢复失败：' + describeError(err))
  }

  /** 打扰决策：只记账（delivery.decided），真正的 L3 推送等入口 adapter 再接通。 */
  /** 工人只带「与任务相关」的少量事实（不含画像/口吻）。 */
  function workerFacts(item) {
    try {
      if (!item || !item.intent) return []
      const rows = recall(db, { ownerId: cfg.ownerId, query: String(item.intent), limit: 8 })
      return rows
        .filter((m) => m.type !== 'profile')
        .slice(0, Number(cfg.workerPromptMaxFacts ?? 2))
        .map((m) => String(m.text).replace(/\s+/g, ' ').slice(0, 140))
    } catch {
      return []
    }
  }

  /** 文件类任务：先按白名单目录嗅探候选文件（只读、限深度）。 */
  function fileCandidatesFor(item) {
    try {
      const dirs = (cfg.searchDirs && cfg.searchDirs.length) ? cfg.searchDirs : [item.workspace || cfg.workspaceRoot].filter(Boolean)
      const intentText = String(item.intent || '')
      if (!looksLikeFileTask(intentText)) return []
      return sniffFiles({ dirs, intent: intentText, limit: 6 })
    } catch (err) {
      log('文件嗅探失败：' + describeError(err))
      return []
    }
  }

  async function notifyDelivery(item, kind, extra = {}) {
    if (!item) return null
    try {
      const budget = deliveryBudget(db, { ownerId: cfg.ownerId, budget: cfg.reporter.dailyL3Budget })
      const decision = decideDelivery({
        kind,
        needsHuman: !!item.needsHuman,
        ownerHour: new Date().getHours(),
        quietHours: cfg.reporter.quietHours,
        l3Used: budget.l3Used,
        l3Budget: budget.l3Budget,
      })
      appendEvent(db, {
        type: EVENT_TYPE.DELIVERY_DECIDED,
        ownerId: cfg.ownerId,
        workitemId: item.id,
        channel: item.sourceChannel,
        actor: ACTOR.KERNEL,
        payload: { kind, level: decision.level, reason: decision.reason },
      })
      // 需要人但被静音/预算降级：记一条 pending，面板与简报能看到「还有事没推」
      if (item.needsHuman && decision.level !== 'L3') {
        appendEvent(db, {
          type: EVENT_TYPE.DELIVERY_PENDING,
          ownerId: cfg.ownerId,
          workitemId: item.id,
          channel: item.sourceChannel,
          actor: ACTOR.KERNEL,
          payload: { kind, wanted: 'L3', got: decision.level, reason: decision.reason },
        })
      }
      // GUI 回灌：全局开关 guiNotify.enabled 或单任务 notify=true 时，把完成结果投回来源 Relay 会话
      const guiNotifyWanted = Number(item.notify ? 1 : 0) === 1 || !!(cfg.guiNotify && cfg.guiNotify.enabled)
      if (item.sourceChannel === 'gui' && item.sourceSessionId && guiNotifyWanted && ['done', 'failed', 'blocked'].includes(kind)) {
        const short = kind === 'done'
          ? ('任务完成：' + String(item.result || '').slice(0, 400))
          : kind === 'failed'
            ? ('任务失败：' + String(item.error || '').slice(0, 400))
            : ('任务卡住需要你处理：' + String(item.error || item.intent || item.id).slice(0, 400))
        const text = '【秘书汇报】' + short + '\n任务：' + String(item.intent || '').slice(0, 80) + '（' + item.id + '）'
        try {
          await promptSession(ctx, item.sourceSessionId, text, { log })
          appendEvent(db, {
            type: EVENT_TYPE.NOTIFY_SENT,
            ownerId: cfg.ownerId,
            workitemId: item.id,
            sessionId: item.sourceSessionId,
            channel: 'gui',
            actor: ACTOR.KERNEL,
            payload: { kind },
          })
        } catch (err) {
          try {
            appendEvent(db, {
              type: EVENT_TYPE.NOTIFY_FAILED,
              ownerId: cfg.ownerId,
              workitemId: item.id,
              sessionId: item.sourceSessionId,
              channel: 'gui',
              actor: ACTOR.KERNEL,
              payload: { kind, error: describeError(err).slice(0, 200) },
            })
          } catch { /* ignore */ }
          log('GUI 回灌失败（可在面板看结果）：' + describeError(err))
        }
      }
      if (item.sourceChannel !== 'gui' && decision.level !== 'L0') {
        let content = kind === 'done'
          ? (item.result || '任务完成')
          : kind === 'failed'
            ? ('任务失败：' + (item.error || '未知原因'))
            : ('任务卡住，需要你处理：' + (item.error || item.intent || item.id))
        if (cfg.language && cfg.language.enabled) {
          try {
            const composed = await composeReply({
              llm: svc(ctx, 'llm'), cfg,
              personaText: buildPersonaBlock(db, { ownerId: cfg.ownerId, forResult: true }),
              item, kind, raw: content,
            })
            if (composed && composed.ok) {
              content = composed.text
              log('语言服务已改写（' + composed.model + '）')
            }
          } catch (err) {
            log('语言服务失败（用原文）：' + describeError(err))
          }
        }
        outboxEnqueue(db, {
          channel: item.sourceChannel,
          peer: item.sourcePeer,
          workitemId: item.id,
          content,
          files: Array.isArray(extra.artifacts) ? extra.artifacts.filter(Boolean) : [],
          level: decision.level,
        })
      }
      return decision
    } catch (err) {
      log('打扰决策失败：' + describeError(err))
      return null
    }
  }

  /** 无线路由（历史任务/异常情况）：直接派单。 */
  function legacyDispatch(fresh) {
    dispatchWorker({
      ctx, cfg, db, item: fresh,
      facts: workerFacts(fresh),
      memberTexts: listMergeMembers(db, fresh.id).map((m) => m.member_text),
      personaBlock: buildPersonaBlock(db, { ownerId: cfg.ownerId, forResult: true }),
      inputFiles: fresh.inputs || [],
      fileCandidates: fileCandidatesFor(fresh),
      log,
    }).catch((err) => failDispatch(fresh, err))
  }

  function failDispatch(fresh, err) {
    state.lastError = describeError(err)
    log('派单失败 ' + fresh.id + '：' + state.lastError)
    try {
      transition(db, fresh.id, ITEM_STATUS.BLOCKED, { reason: '派单失败：' + state.lastError, payload: { needsHuman: true } })
    } catch { /* ignore */ }
  }

  /** 有线走线：线内串行（忙就排队），线间并行。 */
  function dispatchOrQueue(fresh) {
    // 资源准入：并发已满就先排队，等 watchdog 重新拉起（不丢任务、不打死机器）
    try {
      const adm = decideAdmission({ plan: state.plan, running: runningWorkerCount() })
      if (!adm.allow) { log('排队等资源：' + fresh.id + '（' + adm.reason + '）'); return }
    } catch { /* 资源探测失败不拦派单 */ }
    if (!fresh.laneId) { legacyDispatch(fresh); return }
    let lane = null
    try { lane = getLaneById(db, fresh.laneId) } catch { lane = null }
    if (!lane) { legacyDispatch(fresh); return }
    if (lane.currentWorkitemId && lane.currentWorkitemId !== fresh.id) {
      log('排队等线：' + fresh.id + '（线 ' + lane.id + ' 在跑 ' + lane.currentWorkitemId + '）')
      return
    }
    if (!claimLane(db, lane.id, fresh.id)) {
      log('排队等线（占用失败）：' + fresh.id)
      return
    }
    dispatchWorker({
      ctx, cfg, db, item: fresh,
      facts: workerFacts(fresh),
      memberTexts: listMergeMembers(db, fresh.id).map((m) => m.member_text),
      personaBlock: buildPersonaBlock(db, { ownerId: cfg.ownerId, forResult: true }),
      inputFiles: fresh.inputs || [],
      fileCandidates: fileCandidatesFor(fresh),
      lane,
      laneSessionId: lane.sessionId,
      laneContext: laneRecentContext(db, lane.id),
      log,
    }).catch((err) => {
      failDispatch(fresh, err)
      try { releaseLane(db, lane.id) } catch { /* ignore */ }
    })
  }

  /** 任务结束后释放线，并拉起这条线上排队的下一个。 */
  function laneReleaseAndPump(laneId) {
    if (!laneId) return
    try {
      releaseLane(db, laneId)
      const next = nextQueuedOnLane(db, laneId)
      if (!next) return
      const timer = setTimeout(() => {
        strayTimers.delete(timer)
        try {
          const fresh = getWorkItem(db, next.id)
          if (fresh && fresh.status === ITEM_STATUS.QUEUED) dispatchOrQueue(fresh)
        } catch (err) {
          log('拉起排队任务失败：' + describeError(err))
        }
      }, 50)
      strayTimers.add(timer)
    } catch (err) {
      log('释放线失败：' + describeError(err))
    }
  }

  /** 回灌：任务结束后把回执写回发起会话（仅对 adopt 时开了 backfill 的线）。 */
  function backfillLane(item) {
    try {
      if (!item || !item.laneId) return
      const lane = getLaneById(db, item.laneId)
      if (!lane || !lane.meta || lane.meta.backfill !== true) return
      const m = /^session:(.+)$/.exec(String(lane.key || ''))
      if (!m) return
      const sourceSession = m[1]
      if (sourceSession === item.sessionId) return
      const head = item.status === 'done' ? '【秘书回执】任务完成' : '【秘书回执】任务失败'
      const text = head + '：' + item.id + '\n需求：' + String(item.intent || '') + '\n结论：' +
        String(item.result || item.error || '（无）') + '\n（这条是系统回执，不需要回复）'
      promptSession(ctx, sourceSession, text, { log }).catch((err) => log('回灌失败：' + describeError(err)))
    } catch (err) {
      log('回灌异常：' + describeError(err))
    }
  }

  /** 延迟派单：给 Relay 留一个「归并窗口」，窗口内可被 merge 取消。 */
  function scheduleDispatch(item, delayOverride) {
    const id = item.id
    const delay = Math.max(0, Number(delayOverride !== undefined ? delayOverride : cfg.dispatchDelayMs) || 0)
    const timer = setTimeout(() => {
      pendingDispatch.delete(id)
      const fresh = getWorkItem(db, id)
      if (!fresh || fresh.status !== ITEM_STATUS.QUEUED) return
      dispatchOrQueue(fresh)
    }, delay)
    pendingDispatch.set(id, timer)
  }

  function cancelPendingDispatch(id) {
    const timer = pendingDispatch.get(id)
    if (timer) {
      clearTimeout(timer)
      pendingDispatch.delete(id)
    }
  }

  // 旁路审计：读工人会话日志，把主人直接说的/批注的内容记进账本（不改变任务状态）
  let lastGuidanceAuditAt = 0
  function auditWorkerGuidanceLite() {
    const now = Date.now()
    if (now - lastGuidanceAuditAt < 15000) return
    lastGuidanceAuditAt = now
    try {
      const recentTerminalCutoff = now - 2 * 3600 * 1000
      const rows = db.prepare(
        "SELECT id, session_id, source_channel, created_at, updated_at, status, workspace FROM workitems WHERE session_id IS NOT NULL " +
        "AND (status IN ('running','blocked','waiting_human') OR (status IN ('done','failed','cancelled') AND updated_at > ?)) " +
        "ORDER BY updated_at DESC LIMIT 8",
      ).all(recentTerminalCutoff)
      let total = 0
      for (const row of rows) {
        const since = isTerminal(row.status) ? Number(row.updated_at || 0) : Number(row.created_at || 0)
        const n = auditWorkerGuidance(db, {
          sessionId: row.session_id,
          workitemId: row.id,
          ownerId: cfg.ownerId,
          channel: row.source_channel,
          appendEvent,
          since,
          log,
        })
        total += n
        if (n && isTerminal(row.status)) recordContinuation(row, n)
      }
      if (total) log('旁路审计：新增人工指导记录 ' + total + ' 条')
    } catch (err) {
      log('旁路审计失败：' + describeError(err))
    }
  }

  // 续作：任务 done 后主人继续让同一工人改，记一条 continuation + 观察到的产物变更
  function recordContinuation(item, newGuidance) {
    if (!item || !newGuidance) return
    try {
      appendEvent(db, {
        type: EVENT_TYPE.WORKER_CONTINUATION,
        ownerId: cfg.ownerId,
        workitemId: item.id,
        sessionId: item.sessionId,
        channel: item.sourceChannel,
        actor: 'owner',
        payload: { newGuidance, at: Date.now(), note: '主人 continuation（同一工人继续改）' },
      })
    } catch { /* ignore */ }
    // 「重开一轮」：任务已 done/failed 但主人又在会话里接着改，账本上单独记一笔，
    // 不改原结论（done 仍是 done），只让面板/复盘看得出「又改过 N 轮」。
    try {
      const rounds = db.prepare("select count(*) as c from events where type = 'item.reopened' and workitem_id = ?").get(item.id).c + 1
      appendEvent(db, {
        type: EVENT_TYPE.ITEM_REOPENED,
        ownerId: cfg.ownerId,
        workitemId: item.id,
        sessionId: item.sessionId,
        channel: item.sourceChannel,
        actor: 'owner',
        payload: { round: rounds, fromStatus: item.status, at: Date.now(), note: '主人续作，工人接着改（原结论保留）' },
      })
    } catch { /* ignore */ }
    try {
      const since = Number(item.updatedAt || item.createdAt || 0)
      for (const f of scanRecentFiles(item.workspace, since, { limit: 10 })) {
        addRevision(db, {
          workitemId: item.id,
          path: f.path,
          source: 'observed',
          note: '续作后观察到的文件变更',
          mtime: f.mtime,
        })
      }
    } catch (err) {
      log('续作产物扫描失败：' + describeError(err))
    }
  }

  // 证据行：kind|ref|摘要（只给路径也认，kind 默认 file）
  function parseEvidenceLines(raw) {
    return String(raw || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('|').map((x) => x.trim())
        if (parts.length >= 2) return { kind: parts[0] || 'file', ref: parts[1], summary: parts.slice(2).join(' ') || '' }
        return { kind: 'file', ref: line, summary: '' }
      })
  }

  /** 验收清单：每行一条 → [{id,text,done:false}] */
  function parseAcceptanceLines(raw) {
    const lines = String(raw || '')
      .split('\n')
      .map((s) => s.trim().replace(/^[-*\d.、\s]+/, ''))
      .filter(Boolean)
    if (!lines.length) return null
    return lines.map((text, i) => ({ id: 'a' + (i + 1), text, done: false }))
  }

  /** 验收模式：任务显式 > 线的设置 > 全局默认 */
  function effectiveReviewMode(item) {
    const fromItem = item && item.reviewMode ? normalizeReviewMode(item.reviewMode, '') : ''
    if (fromItem) return fromItem
    try {
      const lane = item && item.laneId ? getLaneById(db, item.laneId) : null
      if (lane && lane.reviewMode) return normalizeReviewMode(lane.reviewMode, 'self')
    } catch { /* ignore */ }
    return normalizeReviewMode(cfg.review && cfg.review.mode, 'self')
  }

  /** 线名跟随任务：自动命名的线跟着最近一单更新；手改过名的线（meta.autoLabel=false）不再覆盖。 */
  function syncLaneLabel(laneId, intent) {
    try {
      const lane = laneId ? getLaneById(db, laneId) : null
      if (!lane) return
      const meta = lane.meta || {}
      if (lane.label && meta.autoLabel !== true) return
      const next = String(intent || '').replace(/\s+/g, ' ').trim().slice(0, 20)
      if (!next) return
      db.prepare('UPDATE lanes SET label = ? WHERE id = ?').run(next, laneId)
      setLaneMeta(db, laneId, { autoLabel: true })
    } catch { /* 命名失败不影响派单 */ }
  }

  // 终态任务的工人默认停手；但主人在会话里手动发消息（批注/改稿）后，视为“接手”，放行工具
  const manualTakeoverCache = new Map()
  function manualTakeover(sessionId, item) {
    if (!sessionId || !item) return false
    const now = Date.now()
    const cached = manualTakeoverCache.get(sessionId)
    if (cached && now - cached.at < 30000) return cached.allow
    let allow = false
    try {
      allow = sessionHasManualInput(sessionId, Number(item.updatedAt || item.createdAt || 0))
    } catch { allow = false }
    manualTakeoverCache.set(sessionId, { at: now, allow })
    if (allow) {
      log('任务终态但主人在会话里接管，放行工具：' + sessionId)
      try {
        const n = auditWorkerGuidance(db, {
          sessionId,
          workitemId: item.id,
          ownerId: cfg.ownerId,
          channel: item.sourceChannel,
          appendEvent,
          since: Number(item.updatedAt || item.createdAt || 0),
          log,
        })
        if (n) recordContinuation(item, n)
      } catch { /* 审计失败不影响放行 */ }
    }
    return allow
  }

  // 花费账本：读工人会话日志里的 usage，写 cost_usage（不改变任务）
  let lastUsageScanAt = 0
  function scanUsageLite() {
    const now = Date.now()
    if (now - lastUsageScanAt < 30000) return
    lastUsageScanAt = now
    try {
      const rows = db.prepare(
        "SELECT id, model, session_id FROM workitems WHERE session_id IS NOT NULL AND (status IN ('running','blocked') OR updated_at > ?) ORDER BY updated_at DESC LIMIT 5",
      ).all(now - 3600 * 1000)
      for (const row of rows) {
        let events = []
        try {
          events = (readSessionEvents(row.session_id) || {}).events || []
        } catch { continue }
        const usage = extractUsage(events)
        if (!usage.total) continue
        const rates = (cfg.cost && cfg.cost.rates) || {}
        const rate = rates[row.model] || rates['default'] || null
        recordUsage(db, { workitemId: row.id, sessionId: row.session_id, usage, costCny: estimateCost(usage, rate), now })
      }
    } catch (err) {
      log('花费扫描失败：' + describeError(err))
    }
  }

  // 续作产物巡检：主人在会话里接着说之后产生的文件改动，补登记进 revisions。
  // 为什么需要它：recordContinuation 里的那次扫描发生在「刚收到指导」的瞬间，文件还没改，
  // 结果「指导 → 新版本」的版本链是断的（2026-11-26 办公机名单那次就是 0 条 revision）。
  let lastArtifactScanAt = 0
  function scanContinuationArtifacts() {
    const now = Date.now()
    if (now - lastArtifactScanAt < 60 * 1000) return
    lastArtifactScanAt = now
    try {
      const rows = db.prepare(
        `SELECT w.id, w.workspace, w.updated_at FROM workitems w
         WHERE w.workspace IS NOT NULL AND w.updated_at > ?
           AND EXISTS (SELECT 1 FROM events e WHERE e.workitem_id = w.id AND e.type = ?)
         ORDER BY w.updated_at DESC LIMIT 5`,
      ).all(now - 2 * 3600 * 1000, EVENT_TYPE.WORKER_CONTINUATION)
      for (const row of rows) {
        const lastRev = db.prepare('SELECT MAX(created_at) AS t FROM revisions WHERE workitem_id = ?').get(row.id)
        const since = Math.max(Number(lastRev && lastRev.t ? lastRev.t : 0), Number(row.updated_at || 0))
        for (const f of scanRecentFiles(row.workspace, since, { limit: 10 })) {
          addRevision(db, {
            workitemId: row.id,
            path: f.path,
            source: 'observed',
            note: '续作后补记的产物版本',
            mtime: f.mtime,
          })
        }
      }
    } catch (err) {
      log('续作产物巡检失败：' + describeError(err))
    }
  }

  function closeWorkerSessions(workitemId) {
    try {
      db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE workitem_id = ? AND role = 'worker' AND status = 'live'")
        .run(Date.now(), workitemId)
    } catch (err) {
      log('关闭 worker 会话失败：' + describeError(err))
    }
  }

  // Worker 工具级追踪（骨架）：把 Worker 会话的工具调用写成 worker.tool 事件。
  const toolStartedAt = new WeakMap()
  function recordWorkerTool(exec, result) {
    if (cfg.traceWorkerTools === false) return
    try {
      const evt = buildWorkerToolEvent({ exec, result, startedAt: toolStartedAt.get(exec) })
      if (!evt) return
      const row = db.prepare("SELECT workitem_id FROM sessions WHERE id = ? AND role = 'worker'").get(evt.sessionId)
      if (!row || !row.workitem_id) return
      const item = getWorkItem(db, row.workitem_id)
      appendEvent(db, {
        type: EVENT_TYPE.WORKER_TOOL,
        ownerId: cfg.ownerId,
        workitemId: row.workitem_id,
        sessionId: evt.sessionId,
        channel: item ? item.sourceChannel : null,
        actor: 'worker',
        payload: { tool: evt.tool, ok: evt.ok, durationMs: evt.durationMs, summary: evt.summary },
      })
    } catch (err) {
      log('worker.tool 记录失败：' + describeError(err))
    }
  }
  ctx.on('tools/pre-execute', (exec, next) => {
    try { toolStartedAt.set(exec, Date.now()) } catch { /* ignore */ }
    try {
      const sid = agentSessionId(exec)
      if (sid) {
        const row = db.prepare("SELECT workitem_id FROM sessions WHERE id = ? AND role = 'worker'").get(sid)
        if (row && row.workitem_id) {
          appendEvent(db, {
            type: EVENT_TYPE.WORKER_TOOL_START,
            ownerId: cfg.ownerId,
            workitemId: row.workitem_id,
            sessionId: sid,
            actor: 'worker',
            payload: { tool: toolNameOf(exec) },
          })
        }
      }
    } catch { /* 追踪不许影响主流程 */ }
    return next()
  })
  ctx.on('tools/post-execute', (exec, result, next) => {
    recordWorkerTool(exec, result)
    return next()
  })

  // ---------------- 工具 ----------------
  ctx.tools.register(defineTool({
    name: 'secretary_create_task',
    description:
      '把主人这句话建成一个秘书任务：内核落库、排队、交给工人去干。只传需求原文，不要自己执行。' +
      '建完后**立刻**回主人一句「已派出（任务 id）」，默认不要等待；只有主人明确说「等结果」时才调 secretary_wait。',
    parameters: {
      text: { type: 'string', required: true, description: '主人的需求原文（一句话说清要干什么）' },
      topic: { type: 'string', description: '任务分类：file|research|code|doc|chat|other（用于以后分工统计）' },
      files: { type: 'string', description: '输入文件的绝对路径，多个用换行/逗号分隔（可选；主人发的附件路径也传这里）' },
      permission: { type: 'string', description: '任务需要的工作器权限档：workspace-write（默认）| danger-full-access | read-only | auto-review；只有确实要写工区外时才传 elevated' },
      project: { type: 'string', description: '项目根路径（可选；不填则自动推断）。填了就按人工划分处理' },
      scope: { type: 'string', description: '作用域（scope）：项目内的相对路径前缀（可选，例如 plugin/src）' },
      workspace: { type: 'string', description: '任务工作区（绝对目录；可选，默认内核工作区）。工人会话会在这个目录里开。' },
      worker: { type: 'string', description: '可选：auto（默认，复用本线工人）| new（另起一个新工人，用于和当前线无关的活）' },
      lane: { type: 'string', description: '可选：要接续的线，传 lane_xxx 或上一单的 wi_xxx——新任务会挂到那条线，由同一个工人接着干（涉及「接着上次/同一批活」时必须传）。线 id 可看面板或 GET /secretary/v1/lanes，直接传上一单的 wi_xxx 最省事' },
      model: { type: 'string', description: '可选：指定工人模型，格式 provider/model（如 zai/glm-5.3、moonshotai-cn/kimi-k3）。不填则按 topic/配置/默认走' },
      notify: { type: 'boolean', description: '可选：这一单完成后是否回灌到当前对话（覆盖全局 guiNotify 开关）' },
      force: { type: 'boolean', description: '可选：确实要再派一单同类任务时传 true（绕过去重）' },
      acceptance: { type: 'string', description: '可选：验收清单，每行一条（如「名单里 60 人都有手机号」「格式按文档规范」）。验收模式非 self 时工人必须逐条完成并提交证据' },
      review_mode: { type: 'string', description: '可选：self（提交即完成）| auto（只读模型核对）| owner（等主人点）| model（预留）。不填按线/全局默认' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const text = String(args?.text || '').trim()
      if (!text) return { ok: false, message: 'text 不能为空' }
      if (args?.model && !parseModelRef(args.model)) return { ok: false, message: 'model 格式应为 provider/model（如 zai/glm-5.3），可先调 secretary_models 查可用模型' }

      // 工作区：显式指定优先，否则内核默认；不存在/不允许直接拒绝
      const ws = resolveTaskWorkspace(args?.workspace, cfg)
      if (ws.error) return { ok: false, message: ws.error }
      let cwd = ws.cwd

      // 拆子任务：parent 必须是同一条线上的一级任务（只允许一层，避免任务树失控）
      const laneRefRaw = String(args?.lane || '').trim()
      const parentRef = String(args?.parent || '').trim()
      let parentItem = null
      if (parentRef) {
        parentItem = getWorkItem(db, parentRef)
        if (!parentItem) return { ok: false, message: '父任务不存在：' + parentRef }
        if (parentRef === laneRefRaw) return { ok: false, message: '父任务不能是自己' }
        if (parentItem.parentId) return { ok: false, message: '只支持一层拆分：父任务 ' + parentRef + ' 本身已经是子任务' }
        if (parentItem.status && isTerminal(parentItem.status)) {
          return { ok: false, message: '父任务已终态（' + parentItem.status + '），不能再拆子任务' }
        }
      }

      // 显式接续某条线（lane_xxx 或上一单 wi_xxx）：新任务挂过去，由同一个工人接着干
      let laneExplicit = null
      let laneSource = 'auto'
      if (parentItem && !laneRefRaw && parentItem.laneId) {
        // 子任务默认落在父任务那条线上（同线串行天然保证顺序）
        laneExplicit = getLaneById(db, parentItem.laneId)
        if (laneExplicit) laneSource = 'parent'
      }
      if (laneRefRaw) {
        const found = findLaneRef(db, laneRefRaw)
        if (!found) {
          return { ok: false, message: '找不到这条线：' + laneRefRaw + '。可查面板的线列表（GET /secretary/v1/lanes）或上一单的 wi_xxx' }
        }
        if (!args?.workspace && found.workspace) cwd = found.workspace
        laneExplicit = found
        laneSource = 'explicit'
      }

      // 派单去重：同一工作区已有同类在办任务时复用，避免「一活两单、两个工人并发改同一台机器」
      if (args?.force !== true) {
        try {
          const activeRows = db.prepare(
            "SELECT id, status, intent FROM workitems WHERE workspace = ? AND status IN ('intake','triaged','queued','running','waiting_human','blocked') ORDER BY created_at DESC LIMIT 50",
          ).all(cwd)
          const dup = pickDuplicate(activeRows, text)
          if (dup) {
            return {
              ok: true,
              reused: true,
              workitem_id: dup.id,
              status: dup.status,
              message: '已有同类任务在办（' + dup.id + '，' + dup.status + '），这次没有重复建单。等它跑完即可；确实要另起一单请传 force=true。',
            }
          }
        } catch (err) {
          log('派单去重检查失败（继续建单）：' + describeError(err))
        }
      }

      // 线 = 来源会话（GUI/Relay）；没有会话就用 peer（外部通道）；同会话不同工作区 = 不同线
      let sessionId = ''
      try { sessionId = agentSessionId(exec) || '' } catch { sessionId = '' }
      let lane = laneExplicit
      if (!lane) {
        try {
          const focus = focusFromText(text)
          const unique = String(args?.worker || '').toLowerCase() === 'new' ? Date.now().toString(36) : null
          laneSource = unique ? 'new' : 'auto'
          lane = ensureLane(db, {
            ownerId: cfg.ownerId,
            key: laneKeyFor({ sessionId, channel: 'gui', peer: cfg.ownerId, workspace: cwd, baseWorkspace: cfg.workspaceRoot, focus, unique }),
            workspace: cwd,
          })
        } catch (err) {
          log('建线失败（退回无线模式）：' + describeError(err))
        }
      }

      if (lane) syncLaneLabel(lane.id, text)
      // 路由诊断：记录这次任务为什么落在/该落在哪条线，供以后分析自动分线
      try {
        if (lane) {
          const prev = db.prepare(
            "SELECT topic, intent, workspace, updated_at FROM workitems WHERE lane_id = ? ORDER BY updated_at DESC LIMIT 1",
          ).get(lane.id)
          const cwdKey = laneKeyFor({ sessionId, channel: 'gui', peer: cfg.ownerId, workspace: cwd, baseWorkspace: cfg.workspaceRoot, focus: focusFromText(text) })
          appendEvent(db, {
            type: EVENT_TYPE.LANE_ROUTED,
            ownerId: cfg.ownerId,
            workitemId: null,
            channel: 'gui',
            actor: ACTOR.RELAY,
            payload: {
              laneKey: cwdKey,
              laneId: lane.id,
              laneSource,
              focus: focusFromText(text),
              topic: args?.topic ? String(args.topic) : classifyTopic(text),
              workerParam: args?.worker ? String(args.worker) : 'auto',
              hasSession: !!lane.sessionId,
              idleGapMs: prev ? Date.now() - Number(prev.updated_at) : null,
              prevTopic: prev ? prev.topic : null,
              topicMismatch: !!(prev && prev.topic && (args?.topic ? String(args.topic) : classifyTopic(text)) !== prev.topic),
            },
          })
        }
      } catch { /* 诊断失败不影响建任务 */ }

      // scope：人工指定优先，否则按线档位推断（auto/suggest/manual）
      let scoped
      if (args?.project || args?.scope) {
        scoped = {
          projectRoot: args?.project ? String(args.project) : null,
          scope: args?.scope ? String(args.scope) : null,
          source: 'manual',
          confidence: 1,
        }
      } else {
        scoped = inferScope({ text, cfg, lane })
      }

      let sourceSessionId = null
      try {
        const initiator = svc(ctx, 'agents') && typeof svc(ctx, 'agents').currentInitiator === 'function'
          ? svc(ctx, 'agents').currentInitiator()
          : null
        sourceSessionId = initiator && initiator.id ? String(initiator.id) : null
      } catch { /* ignore */ }
      const { item } = createWorkItem(db, {
        ownerId: cfg.ownerId,
        channel: 'gui',
        peer: cfg.ownerId,
        kind: 'task',
        intent: text,
        inputs: parseFiles(args?.files),
        permission: normalizeWorkerPermission(args?.permission, cfg.workerPermissionPreset),
        laneId: lane ? lane.id : null,
        workspace: cwd,
        origin: 'relay',
        projectRoot: scoped.projectRoot,
        scope: scoped.scope,
        scopeSource: scoped.source,
        scopeConfidence: scoped.confidence,
        topic: args?.topic ? String(args.topic) : classifyTopic(text),
        model: args?.model ? String(args.model) : null,
        parentId: args?.parent ? String(args.parent) : null,
        reviewMode: args?.review_mode ? normalizeReviewMode(args.review_mode, '') || null : null,
        acceptance: parseAcceptanceLines(args?.acceptance),
        sourceSessionId,
        notify: args?.notify === true ? true : false,
      })
      transition(db, item.id, ITEM_STATUS.TRIAGED, { reason: 'rule: intent=task' })
      transition(db, item.id, ITEM_STATUS.QUEUED, { reason: 'route: default' })

      scheduleDispatch(getWorkItem(db, item.id))

      return {
        ok: true,
        workitem_id: item.id,
        status: 'queued',
        message: '已派出：' + item.id + '（queued，工作区 ' + cwd + '）。默认不用等——好了看面板/会汇报；主人明确要等结果时才用 secretary_wait。',
      }
    },
  }))

  // 已登记会话的 resume 句柄（老会话要先 resume 才能当工人）
  const adoptedHandles = new Map() // laneId -> { sessionId, dispose }
  async function disposeAdoptedHandle(laneId) {
    const h = adoptedHandles.get(laneId)
    if (!h) return
    adoptedHandles.delete(laneId)
    try { if (typeof h.dispose === 'function') await h.dispose() } catch { /* ignore */ }
  }

  ctx.tools.register(defineTool({
    name: 'secretary_adopt',
    description:
      '把一个已有会话登记为这条线的工人（任何会话都行，包括老会话）。默认只接受工人预设；' +
      'mode=seed 时把老会话的历史事件复制进一个全新的工人会话（带记忆、工具是工人的）。',
    parameters: {
      session_id: { type: 'string', required: true, description: '要登记的会话 id（DSH session id，可在会话里复制）' },
      lane_key: { type: 'string', description: '可选：登记到哪条线（默认当前会话这条线）' },
      label: { type: 'string', description: '可选：线的名字，例如「项目A-重构」' },
      permission: { type: 'string', description: '可选：这条线的权限档（read-only|workspace-write|danger-full-access|auto-review）' },
      backfill: { type: 'boolean', description: '可选：任务结束后把回执写回这条线对应的来源会话（回填）' },
      mode: { type: 'string', description: '可选：reuse（默认，直接复用会话）| seed（把历史复制进新工人会话，适合老会话）' },
      force: { type: 'boolean', description: '可选：reuse 时允许非工人预设的会话直接当工人（有风险，可能不按工人方式干活）' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const target = String(args?.session_id || '').trim()
      if (!target) return { ok: false, message: 'session_id 不能为空' }
      let caller = ''
      try { caller = agentSessionId(exec) || '' } catch { caller = '' }
      const key = args?.lane_key
        ? String(args.lane_key)
        : laneKeyFor({ sessionId: caller, channel: 'gui', peer: cfg.ownerId })
      const mode = args?.mode === 'seed' ? 'seed' : 'reuse'
      const agents = svc(ctx, 'agents')
      if (!agents || typeof agents.get !== 'function') return { ok: false, message: 'agents 服务不可用' }

      let lane = null
      try {
        lane = ensureLane(db, { ownerId: cfg.ownerId, key, label: args?.label ? String(args.label) : null })
      } catch (err) {
        return { ok: false, message: '建线失败：' + describeError(err) }
      }

      try {
        const header = readSessionHeader(target)
        if (mode === 'seed') {
          const max = Number(cfg.seedMaxEvents) || 500
          const { events, header: h2 } = readSessionEvents(target)
          const h = h2 || header
          if (!events.length) return { ok: false, message: '读不到这个会话的历史事件（可能不是本机会话）' }
          if (events.length > max) return { ok: false, message: '会话事件太多（' + events.length + ' 条 > 上限 ' + max + '），暂不支持 seed' }
          if (typeof agents.create !== 'function') return { ok: false, message: '不支持创建会话（agents.create）' }
          const newId = 'session-' + randomUUID()
          const handle = await agents.create({
            sessionId: newId,
            seed: events,
            inheritedEventCount: events.length,
            meta: {
              cwd: (h && h.cwd) || cfg.workspaceRoot,
              agentPreset: cfg.workerPreset,
              isSeeded: true,
              parentSession: target,
            },
          })
          const created = (handle && handle.agent && handle.agent.id) || newId
          await disposeAdoptedHandle(lane.id)
          adoptedHandles.set(lane.id, { sessionId: created, dispose: handle ? handle.dispose : null })
          adoptSession(db, lane.id, created, {
            label: args?.label ? String(args.label) : null,
            permission: args?.permission ? String(args.permission) : null,
            backfill: args?.backfill === true,
          })
          return {
            ok: true,
            lane_id: lane.id,
            lane_key: key,
            session_id: created,
            from: target,
            seeded: true,
            events: events.length,
            message: '已从老会话复制 ' + events.length + ' 条历史，生成新工人会话 ' + created,
          }
        }

        // reuse：先做工人资格检查
        const preset = header ? header.agentPreset : null
        const vet = vetWorkerPreset(preset, { workerPreset: cfg.workerPreset, force: args?.force === true })
        if (!vet.ok) return { ok: false, message: vet.reason }

        let resumed = false
        if (!agents.get(target)) {
          if (typeof agents.resume !== 'function') return { ok: false, message: '会话未加载且不支持 resume：' + target }
          const handle = await agents.resume({ resumeSessionId: target })
          if (!handle || !handle.agent) return { ok: false, message: '恢复会话失败：' + target }
          resumed = true
          adoptedHandles.set(target, handle)
        }
        const prev = adoptedHandles.get(lane.id)
        if (prev && prev.sessionId !== target) { adoptedHandles.delete(lane.id); try { if (prev.dispose) await prev.dispose() } catch { /* ignore */ } }
        if (resumed) {
          const handle = adoptedHandles.get(target)
          adoptedHandles.set(lane.id, { sessionId: target, dispose: handle ? handle.dispose : null })
          adoptedHandles.delete(target)
        }
        adoptSession(db, lane.id, target, {
          label: args?.label ? String(args.label) : null,
          permission: args?.permission ? String(args.permission) : null,
          backfill: args?.backfill === true,
        })
        const ageDays = sessionAgeDays(header && header.createdAt)
        const oldWarning = ageDays !== null && ageDays > 7
          ? '（这个会话已经 ' + Math.floor(ageDays) + ' 天了，很老的会话恢复后可能跑不动）'
          : ''
        return {
          ok: true,
          lane_id: lane.id,
          lane_key: key,
          session_id: target,
          preset: preset || '(未知)',
          self: caller === target,
          resumed,
          warning: oldWarning || null,
          message: '已登记：' + target + ' → 线 ' + lane.id +
            (caller === target ? '（就地执行）' : resumed ? '（已从磁盘恢复）' : '') + oldWarning,
        }
      } catch (err) {
        return { ok: false, message: '登记失败：' + describeError(err) }
      }
    },
  }))

  // ---- 工具治理 M1：申请 / 查看 / 决定 ----
  function workerScopeOf(exec) {
    try {
      const sid = agentSessionId(exec)
      if (!sid) return { sessionId: null, workitemId: null, laneId: null }
      const row = db.prepare("SELECT workitem_id FROM sessions WHERE id = ? AND role = 'worker' ORDER BY rowid DESC LIMIT 1").get(sid)
      const w = row && row.workitem_id ? getWorkItem(db, row.workitem_id) : null
      return { sessionId: sid, workitemId: row ? row.workitem_id : null, laneId: w ? w.laneId : null }
    } catch {
      return { sessionId: null, workitemId: null, laneId: null }
    }
  }

  ctx.tools.register(defineTool({
    name: 'secretary_request_tool',
    description:
      '【工人专用】申请使用一个不在允许名单里的工具。填工具名、为什么需要、想要的范围（once 本任务 / lane 本线 / global 长期），然后最多等 wait_seconds 秒等批准。',
    parameters: {
      tool: { type: 'string', required: true, description: '要申请的工具名（例如 printer_print）' },
      reason: { type: 'string', required: true, description: '为什么需要它（一句话，主人要看）' },
      scope: { type: 'string', description: '想要的范围：once（默认，本任务）| lane（本线）| global（长期）' },
      wait_seconds: { type: 'number', description: '最多等多少秒，默认 20，上限 60' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const tool = String(args?.tool || '').trim()
      if (!tool) return { ok: false, message: 'tool 不能为空' }
      const where = workerScopeOf(exec)
      // 黑名单先挡（不可申请）
      if (toolRequestForbidden(tool)) {
        return { ok: false, forbidden: true, message: '这个工具不允许申请（黑名单）：' + tool + '。换别的办法，或调 secretary_work_fail 说明原因。' }
      }
      // M3 策略学习：这条线/全局以前批准过就自动放行
      if (cfg.learnToolPolicies !== false) {
        const learned = learnedToolGrant(db, { tool, laneId: where.laneId, ownerId: cfg.ownerId })
        if (learned) {
          return { ok: true, status: 'allowed', decided_by: 'learned', scope: learned.source, message: '这条线/全局以前批准过 ' + tool + '，自动放行（策略学习）。' }
        }
      }
      // 已有授权（同任务 once / 同线 lane / 全局）就直接返回，避免工人反复申请空转
      try {
        if (hasToolGrant(db, { tool, workitemId: where.workitemId, laneId: where.laneId })) {
          return { ok: true, status: 'allowed', decided_by: 'existing', message: '这个任务/这条线已经有 ' + tool + ' 的授权，可以直接用，不要再重复申请。' }
        }
      } catch { /* ignore */ }
      let req = null
      try {
        req = createToolRequest(db, {
          ownerId: cfg.ownerId,
          laneId: where.laneId,
          workitemId: where.workitemId,
          sessionId: where.sessionId,
          tool,
          reason: String(args?.reason || ''),
          wantScope: args?.scope ? String(args.scope) : 'once',
        })
      } catch (err) {
        return { ok: false, message: '申请失败：' + describeError(err) }
      }
      if (req.status === 'forbidden') {
        return { ok: false, forbidden: true, request_id: req.id, message: '这个工具不允许申请（黑名单）：' + tool + '。换别的办法，或调 secretary_work_fail 说明原因。' }
      }
      if (req.status === 'allowed') {
        return { ok: true, status: 'allowed', request_id: req.id, message: '已有授权，可以直接用。' }
      }
      // 付费视频类工具：永远人工审批（不让 judge 自动批，按秒烧钱）
      const OWNER_ONLY_TOOLS = /^(generate_video|animate_image)$/
      if (OWNER_ONLY_TOOLS.test(tool)) {
        escalateToolRequest(db, req.id, { decidedBy: 'policy' })
        log('付费视频工具强制人工审批：' + tool)
      } else if (cfg.judge && cfg.judge.enabled) {
        try {
          const task = where.workitemId ? getWorkItem(db, where.workitemId) : null
          let laneHint = ''
          if (where.laneId) {
            const lane = getLaneById(db, where.laneId)
            if (lane) laneHint = lane.label || lane.key
          }
          const verdict = await judgeToolDecision({
            llm: svc(ctx, 'llm'),
            cfg,
            request: req,
            taskText: task ? task.intent : '',
            laneHint,
          })
          try {
            const hash = createHash('sha256').update(JSON.stringify({ tool, reason: req.reason, task: task ? task.intent : '' })).digest('hex').slice(0, 32)
            db.prepare(
              'INSERT INTO judge_calls (id, workitem_id, kind, schema_ver, input_hash, output, source, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ).run('jc_' + Date.now().toString(36), where.workitemId || null, JUDGE_KIND, 1, hash, JSON.stringify(verdict), 'judge', verdict.durationMs || 0, Date.now())
          } catch { /* 审计失败不影响判断 */ }
          log('工具审批裁判：' + tool + ' → ' + verdict.decision + '（' + verdict.reason + '）')
          if (verdict.decision === 'allow') {
            decideToolRequest(db, req.id, { approve: true, scope: verdict.scope, decidedBy: 'judge' })
            return { ok: true, status: 'allowed', request_id: req.id, scope: verdict.scope, decided_by: 'judge', message: '裁判批准（' + verdict.scope + '）：' + verdict.reason }
          }
          if (verdict.decision === 'deny') {
            decideToolRequest(db, req.id, { approve: false, decidedBy: 'judge' })
            return { ok: false, status: 'denied', request_id: req.id, decided_by: 'judge', message: '裁判拒绝：' + verdict.reason + '。换别的办法或调 secretary_work_fail。' }
          }
          escalateToolRequest(db, req.id, { decidedBy: 'judge' })
        } catch (err) {
          log('裁判失败（转人工）：' + describeError(err))
        }
      }
      const waitSec = Math.min(60, Math.max(0, Number(args?.wait_seconds ?? 20) || 0))
      const deadline = Date.now() + waitSec * 1000
      while (Date.now() < deadline) {
        await sleep(1000)
        const cur = getToolRequest(db, req.id)
        if (!cur) break
        if (cur.status === 'allowed') {
          return { ok: true, status: 'allowed', request_id: req.id, scope: cur.scopeGranted, message: '已批准（' + (cur.scopeGranted || 'once') + '），可以用了。' }
        }
        if (cur.status === 'denied') {
          return { ok: false, status: 'denied', request_id: req.id, message: '申请被拒绝。换别的办法，或调 secretary_work_fail 说明。' }
        }
      }
      return { ok: false, status: 'pending', request_id: req.id, message: '申请已提交，还在等主人决定（request_id=' + req.id + '）。先做别的部分，稍后再试。' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_tool_requests',
    description: '看待处理的工具申请（主人/Relay 用）。批准或拒绝用 secretary_decide_tool_request。',
    parameters: {
      status: { type: 'string', description: '可选：pending（默认）| allowed | denied | forbidden | 不填看最近全部' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const status = args?.status ? String(args.status) : 'pending'
      const items = listToolRequests(db, { ownerId: cfg.ownerId, status: status === 'all' ? null : status, limit: 20 })
      return { ok: true, count: items.length, items }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_decide_tool_request',
    description: '批准或拒绝一个工具申请（主人/Relay 用）。批准要选范围：once/lane/global。',
    parameters: {
      request_id: { type: 'string', required: true, description: '申请 id（secretary_tool_requests 返回）' },
      approve: { type: 'boolean', description: 'true（默认）= 批准，false = 拒绝' },
      scope: { type: 'string', description: '批准范围：once（默认）| lane | global' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const id = String(args?.request_id || '').trim()
      if (!id) return { ok: false, message: 'request_id 不能为空' }
      try {
        const r = decideToolRequest(db, id, {
          approve: args?.approve !== false,
          scope: args?.scope ? String(args.scope) : null,
          decidedBy: 'owner',
        })
        return {
          ok: true,
          request: r,
          message: r.status === 'allowed'
            ? '已批准：' + r.tool + '（范围 ' + r.scopeGranted + '）'
            : '已拒绝：' + r.tool,
        }
      } catch (err) {
        return { ok: false, message: '处理失败：' + describeError(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_wait',
    description:
      '等一个任务跑完：轮询到 done/failed/blocked 就返回结果；超时返回当前状态（任务不会因此取消）。',
    parameters: {
      workitem_id: { type: 'string', required: true, description: 'secretary_create_task 返回的 workitem_id' },
      timeout_sec: { type: 'number', description: '最多等多少秒，默认 45，上限 120' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const id = String(args?.workitem_id || '').trim()
      if (!id) return { ok: false, message: 'workitem_id 不能为空' }
      const seconds = Math.min(cfg.waitMaxSec, Math.max(1, Number(args?.timeout_sec) || cfg.waitDefaultSec))
      const deadline = Date.now() + seconds * 1000
      let item = getWorkItem(db, id)
      if (!item) return { ok: false, message: '任务不存在：' + id }
      while (Date.now() < deadline) {
        item = getWorkItem(db, id)
        if (isTerminal(item.status)) {
          return {
            ok: item.status === 'done',
            status: item.status,
            workitem_id: id,
            result: item.result,
            error: item.error,
            needs_human: item.needsHuman,
            artifacts: db.prepare('SELECT path FROM artifacts WHERE workitem_id = ?').all(id).map((r) => r.path),
          }
        }
        if (item.status === ITEM_STATUS.WAITING_HUMAN) {
          return { ok: false, status: item.status, workitem_id: id, needs_human: true, message: '任务在等主人确认' }
        }
        await sleep(500)
      }
      item = getWorkItem(db, id)
      return { ok: false, status: item.status, workitem_id: id, message: '还在办（' + item.status + '），稍后再问 secretary_status' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_status',
    description: '看秘书现在在办什么：各状态任务数、在办任务列表、最近错误。回答「现在在干嘛」用。',
    parameters: {},
    output: JSON_OUTPUT,
    async execute() {
      const counts = summaryCounts(db)
      const active = listWorkItems(db, { limit: 20 }).filter((w) => !isTerminal(w.status))
      const needsHuman = active.filter((w) => w.needsHuman)
      return {
        ok: true,
        counts,
        active: active.map((w) => ({ id: w.id, status: w.status, intent: w.intent, updatedAt: w.updatedAt, needsHuman: w.needsHuman })),
        needs_human: needsHuman.length,
        last_error: state.lastError,
        memory: memoryStats(db, { ownerId: cfg.ownerId }),
        message: '在办 ' + active.length + ' 单（需要人 ' + needsHuman.length + '）；' +
          'done ' + counts.done + ' / failed ' + counts.failed + ' / blocked ' + counts.blocked,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_work_finish',
    description:
      '【工人专用】声明任务完成并写入结果事件。不调用它，任务永远不会被判成功。验收模式不是 self 时，提交必须带 evidence。',
    parameters: {
      workitem_id: { type: 'string', required: true, description: '派单里给的任务 ID' },
      result: { type: 'string', required: true, description: '一句话结论 + 关键产物路径' },
      artifacts: { type: 'string', description: '产物路径，多个用换行分隔（可选）' },
      evidence: {
        type: 'string',
        description: '证据，每行一条，格式 kind|ref|摘要（如 file|/root/x.xlsx|更新后的名单）。验收模式 self 时可选，其余模式必填',
      },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const id = String(args?.workitem_id || '').trim()
      if (!id) return { ok: false, message: 'workitem_id 不能为空' }
      try {
        closeWorkerSessions(id)
        const arts = String(args?.artifacts || '').split('\n').map((s) => s.trim()).filter(Boolean)
        const evidence = parseEvidenceLines(args?.evidence)
        const mode = effectiveReviewMode(getWorkItem(db, id))
        if (mode !== 'self' && !evidence.length) {
          return { ok: false, message: '这条线的验收模式是 ' + mode + '：提交必须带 evidence（每行 kind|ref|摘要）' }
        }
        const submitted = submitWorkItem(db, id, {
          result: String(args?.result || ''),
          artifacts: arts,
          evidence,
          reviewMode: mode,
        })
        if (!submitted.submitted) return { ok: false, message: submitted.reason || '提交被拒绝' }
        let item = submitted.item

        // auto/model：提交后立刻让验收员核对；验收器不可用就留在 submitted 等主人，绝不自动通过
        if (mode === 'auto' || mode === 'model') {
          const verdict = await reviewSubmissionWithModel({ llm: svc(ctx, 'llm'), cfg, item })
          if (!verdict.unavailable) {
            if (verdict.pass) {
              item = acceptWorkItem(db, id, { by: 'auto', note: verdict.reason })
              await notifyDelivery(item, 'done', { artifacts: arts })
              laneReleaseAndPump(item.laneId)
              backfillLane(item)
              return { ok: true, workitem_id: id, status: item.status, accepted: true, message: '验收通过：' + (verdict.reason || '') }
            }
            item = rejectWorkItem(db, id, { reason: verdict.reason || '验收未通过', by: 'auto' })
            return {
              ok: false,
              workitem_id: id,
              status: item.status,
              rejected: true,
              reason: verdict.reason,
              failed: verdict.failed || [],
              message: '验收未通过，已退回继续改：' + (verdict.reason || ''),
            }
          }
        }

        await notifyDelivery(item, 'submitted')
        laneReleaseAndPump(item.laneId)
        backfillLane(item)
        return {
          ok: true,
          workitem_id: id,
          status: item.status,
          message: '已提交待验收（' + mode + '）：' + id,
        }
      } catch (err) {
        return { ok: false, message: '记录完成失败：' + describeError(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_work_fail',
    description: '【工人专用】声明任务失败并写原因。做不了时用它，不要硬撑。',
    parameters: {
      workitem_id: { type: 'string', required: true, description: '派单里给的任务 ID' },
      reason: { type: 'string', required: true, description: '失败原因（一句话）' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const id = String(args?.workitem_id || '').trim()
      if (!id) return { ok: false, message: 'workitem_id 不能为空' }
      try {
        closeWorkerSessions(id)
        const item = failWorkItem(db, id, { reason: String(args?.reason || 'worker failed') })
        await notifyDelivery(item, 'failed')
        laneReleaseAndPump(item.laneId)
        backfillLane(item)
        return { ok: true, workitem_id: id, status: item.status, message: '已记录失败：' + id }
      } catch (err) {
        return { ok: false, message: '记录失败失败：' + describeError(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_review',
    description:
      '看待验收的提交并处理：action=list 列出（默认）；accept 通过；reject 驳回（必须写理由，任务退回继续改）。验收模式 self 的线一般用不到。',
    parameters: {
      action: { type: 'string', description: 'list（默认）| accept | reject' },
      workitem_id: { type: 'string', description: 'accept / reject 时的任务 ID' },
      reason: { type: 'string', description: 'reject 的理由（必填）' },
      note: { type: 'string', description: 'accept 的备注（可选）' },
      limit: { type: 'number', description: 'list 条数，默认 10，最大 50' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const action = String(args?.action || 'list').toLowerCase()
      const id = String(args?.workitem_id || '').trim()
      try {
        if (action === 'accept') {
          if (!id) return { ok: false, message: 'workitem_id 不能为空' }
          const item = acceptWorkItem(db, id, { note: String(args?.note || ''), by: ACTOR.OWNER })
          await notifyDelivery(item, 'done')
          laneReleaseAndPump(item.laneId)
          backfillLane(item)
          return { ok: true, workitem_id: id, status: item.status, message: '已验收通过：' + id }
        }
        if (action === 'reject') {
          if (!id) return { ok: false, message: 'workitem_id 不能为空' }
          const reason = String(args?.reason || '').trim()
          if (!reason) return { ok: false, message: '驳回必须写理由' }
          const item = rejectWorkItem(db, id, { reason, by: ACTOR.OWNER })
          return {
            ok: true,
            workitem_id: id,
            status: item.status,
            message: '已驳回并退回继续改：' + reason + '。可对同一工人用 secretary_steer_worker 补充意见。',
          }
        }
        const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10))
        const rows = db.prepare(
          "SELECT id, lane_id, intent, result, acceptance, evidence, submitted_at, review_mode FROM workitems WHERE status = 'submitted' ORDER BY submitted_at ASC LIMIT ?",
        ).all(limit)
        return {
          ok: true,
          pending: rows.map((r) => ({
            id: r.id,
            laneId: r.lane_id,
            reviewMode: r.review_mode,
            intent: String(r.intent || '').slice(0, 120),
            result: String(r.result || '').slice(0, 300),
            acceptance: r.acceptance ? JSON.parse(r.acceptance) : [],
            evidence: r.evidence ? JSON.parse(r.evidence) : [],
            submittedAt: r.submitted_at,
          })),
          message: rows.length ? '有 ' + rows.length + ' 单待验收（accept/reject 传 workitem_id）' : '没有待验收的提交',
        }
      } catch (err) {
        return { ok: false, message: '验收操作失败：' + describeError(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_schedule',
    description:
      '定时计划：action=list 看计划；add 新建（kind=every 给 cron+tz；kind=at 给 at 毫秒时间戳；kind=after_task 给 anchor_task_id+delay_s）；pause/resume/remove 管计划。触发时按 template 参数派任务。',
    parameters: {
      action: { type: 'string', description: 'list（默认）| add | pause | resume | remove' },
      id: { type: 'string', description: 'pause/resume/remove 的计划 id' },
      title: { type: 'string', description: 'add：计划标题' },
      kind: { type: 'string', description: 'add：every（默认）| at | after_task' },
      cron: { type: 'string', description: 'add（every）：5 段 cron，如 "0 20 * * *"' },
      tz: { type: 'string', description: 'add：IANA 时区，默认 Asia/Shanghai' },
      at: { type: 'number', description: 'add（at）：绝对时间 epoch ms' },
      anchor_task_id: { type: 'string', description: 'add（after_task）：锚点任务 id' },
      delay_s: { type: 'number', description: 'add（after_task）：锚点完成后多少秒触发' },
      text: { type: 'string', description: 'add：触发时派什么活（必填）' },
      workspace: { type: 'string', description: 'add：工作区' },
      topic: { type: 'string', description: 'add：任务分类' },
      model: { type: 'string', description: 'add：provider/model' },
      lane: { type: 'string', description: 'add：要接续的线（lane_xxx 或 wi_xxx）' },
      max_per_day: { type: 'number', description: 'add：每天最多触发几次' },
      cooldown_s: { type: 'number', description: 'add：两次触发最小间隔（秒）' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const action = String(args?.action || 'list').toLowerCase()
      try {
        if (action === 'add') {
          const s = createSchedule(db, {
            title: args?.title,
            kind: args?.kind || 'every',
            cron: args?.cron || null,
            tz: args?.tz || 'Asia/Shanghai',
            at: args?.at || null,
            anchorTaskId: args?.anchor_task_id || null,
            delayS: args?.delay_s || 0,
            catchup: 'skip',
            maxPerDay: args?.max_per_day || null,
            cooldownS: args?.cooldown_s || null,
            ownerId: cfg.ownerId,
            template: {
              text: String(args?.text || ''),
              workspace: args?.workspace || null,
              topic: args?.topic || null,
              model: args?.model || null,
              lane: args?.lane || null,
            },
          })
          return { ok: true, schedule: s, message: '已建计划 ' + s.id + '（下次 ' + (s.nextRunAt ? new Date(s.nextRunAt).toISOString() : '等锚点任务') + '）' }
        }
        if (action === 'pause' || action === 'resume') {
          const id = String(args?.id || '').trim()
          if (!id) return { ok: false, message: 'id 不能为空' }
          const s = setScheduleStatus(db, id, action === 'pause' ? 'paused' : 'active')
          return { ok: true, schedule: s, message: (action === 'pause' ? '已暂停 ' : '已恢复 ') + id }
        }
        if (action === 'remove') {
          const id = String(args?.id || '').trim()
          if (!id) return { ok: false, message: 'id 不能为空' }
          const removed = removeSchedule(db, id)
          return { ok: removed, message: (removed ? '已删除 ' : '没找到 ') + id }
        }
        const rows = listSchedules(db, { limit: 20 })
        return {
          ok: true,
          schedules: rows.map((s) => ({
            id: s.id,
            title: s.title,
            kind: s.kind,
            cron: s.cron,
            tz: s.tz,
            nextRunAt: s.nextRunAt,
            nextRunLocal: s.nextRunAt ? new Date(s.nextRunAt).toLocaleString('sv-SE', { timeZone: s.tz || 'Asia/Shanghai' }) : null,
            status: s.status,
            text: String((s.template && s.template.text) || '').slice(0, 80),
          })),
          concurrency: { plan: state.plan, current: state.concurrency.current, overloaded: state.overloaded },
          message: '共 ' + rows.length + ' 个计划',
        }
      } catch (err) {
        return { ok: false, message: '定时计划操作失败：' + describeError(err) }
      }
    },
  }))

  function clientHalfInfo() {
    try {
      const cm = svc(ctx, 'clientModules')
      if (!cm || typeof cm.graph !== 'function') return { available: false }
      const g = cm.graph()
      const ids = Array.isArray(g && g.entries) ? g.entries.map((e) => e.id) : []
      return { available: true, count: ids.length, found: ids.includes('dsh-secretary-core'), rev: g && g.rev }
    } catch (err) {
      return { available: false, error: describeError(err) }
    }
  }

  ctx.tools.register(defineTool({
    name: 'secretary_persona_get',
    description: '看主人设置的语气人设（称呼/自称/语气/口头禅等）。Relay 开场或不确定该用什么口吻时先调它；没设置就按 preset 默认。',
    parameters: {},
    output: JSON_OUTPUT,
    async execute() {
      const items = describePersona(db, { ownerId: cfg.ownerId })
      const set = items.filter((i) => i.value)
      return { ok: true, items, message: set.length ? '已设置 ' + set.length + ' 项人设' : '主人还没有设置语气项（用 preset 默认）' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_persona_set',
    description: '改一项语气人设（只在主人明确要求时调用）。可改：称呼主人/自称/语气/口头禅/敬语/语言；红线与安全规则不可改。',
    parameters: {
      key: { type: 'string', required: true, description: 'nickname_owner | nickname_self | tone | catchphrases | formality | language' },
      value: { type: 'string', required: true, description: '新的值；传空字符串表示恢复默认' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      try {
        const r = setPersona(db, { ownerId: cfg.ownerId, key: String(args?.key || ''), value: String(args?.value ?? '') })
        return { ok: true, key: r.key, value: r.value, removed: r.removed, message: r.removed ? '已恢复默认：' + r.key : '已更新：' + r.key + ' = ' + r.value }
      } catch (err) {
        return { ok: false, message: '改不了：' + describeError(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_steer_worker',
    description:
      '给正在办的任务的工人追加一条人工指令（主人的修改意见/批注）。内核会记录进账本并投递给工人会话；' +
      '不改任务状态，工人仍在原任务里改，改完照常 work_finish。',
    parameters: {
      workitem_id: { type: 'string', required: true, description: '任务 ID' },
      message: { type: 'string', required: true, description: '要转达给工人的修改意见（原文，不要改写）' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const id = String(args?.workitem_id || '').trim()
      const message = String(args?.message || '').trim()
      if (!id || !message) return { ok: false, message: 'workitem_id 和 message 都要填' }
      const item = getWorkItem(db, id)
      if (!item) return { ok: false, message: '找不到任务 ' + id }
      if (!['running', 'blocked', 'waiting_human'].includes(item.status)) {
        return { ok: false, message: '任务当前状态是 ' + item.status + '，只有 running / blocked / waiting_human 能追加指令' }
      }
      if (!item.sessionId) return { ok: false, message: '这个任务还没有工人会话，无法投递' }
      const text = '【主人补充指令】' + message +
        '\n继续原任务，按这条意见修改；改完照常调 secretary_work_finish，不要新建任务。'
      // 优先用 Agent.steer：运行中的工人会在「下一步」就收到（不用等整轮结束）；不行再退回排队
      let mode = 'queued'
      try {
        const agents = svc(ctx, 'agents')
        let agent = null
        try {
          const got = agents && typeof agents.get === 'function' ? agents.get(item.sessionId) : null
          agent = got && (got.agent || got)
        } catch { /* ignore */ }
        if (agent && typeof agent.steer === 'function') {
          let msg = null
          try {
            const mod = await import('@deepseek-ai/dsh-llm')
            if (mod && typeof mod.createUserMessage === 'function') msg = mod.createUserMessage(text)
          } catch { /* 包不可直接 import 时用普通消息结构 */ }
          if (!msg) {
            msg = {
              role: 'user',
              id: randomUUID(),
              content: [{ type: 'text', text }],
              source: { kind: 'user', rpcId: 'sec-steer-' + id.slice(0, 8) + '-' + Date.now().toString(36) },
            }
          }
          agent.steer(msg)
          mode = 'steer'
        }
      } catch (err) {
        log('steer 投递失败，回退排队：' + describeError(err))
      }
      if (mode !== 'steer') {
        try {
          await promptSession(ctx, item.sessionId, text, { log })
        } catch (err) {
          return { ok: false, message: '投递失败：' + describeError(err) }
        }
      }
      try {
        appendEvent(db, {
          type: EVENT_TYPE.WORKER_USER_MESSAGE,
          ownerId: cfg.ownerId,
          workitemId: id,
          sessionId: item.sessionId,
          channel: item.sourceChannel,
          actor: 'owner',
          payload: { source: 'kernel', mode, chars: message.length, preview: message.slice(0, 300), at: Date.now() },
        })
      } catch { /* 审计失败不影响投递 */ }
      return { ok: true, workitem_id: id, mode, message: mode === 'steer' ? '已插话给工人（下一步就生效）；任务状态不变。' : '已转达给工人（排在当前轮之后处理）；任务状态不变。' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_board_post',
    description:
      '【工人/Relay 共用】往共享黑板上贴一条：结论、事实、待办、决定或卡点。同一条线的其他工人和主人都能读到。' +
      '黑板是共享状态不是聊天，一条别超过 4000 字；长内容写文件后贴路径。',
    parameters: {
      text: { type: 'string', required: true, description: '要贴上黑板的一句话/一段结论' },
      kind: { type: 'string', description: 'note（默认）| fact | todo | decision | blocked' },
      lane: { type: 'string', description: '可选：贴到哪条线（lane_xxx 或 wi_xxx）；不填则用当前任务所在的线' },
      workitem_id: { type: 'string', description: '可选：这条贴子属于哪个任务（工人一般传派单里的任务 ID）' },
      pinned: { type: 'boolean', description: '可选：钉住，任何线读黑板都能看到（适合全局约定）' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const text = String(args?.text || '').trim()
      if (!text) return { ok: false, message: 'text 不能为空' }
      let laneId = null
      const laneRef = String(args?.lane || '').trim()
      if (laneRef) {
        const found = findLaneRef(db, laneRef)
        if (!found) return { ok: false, message: '找不到这条线：' + laneRef + '（可传 lane_xxx 或上一单的 wi_xxx）' }
        laneId = found.id
      }
      const wi = String(args?.workitem_id || '').trim() || null
      if (!laneId && wi) {
        const item = getWorkItem(db, wi)
        if (item && item.laneId) laneId = item.laneId
      }
      const r = postBoard(db, { ownerId: cfg.ownerId, laneId, workitemId: wi, kind: args?.kind, text, pinned: !!args?.pinned })
      if (!r.ok) return { ok: false, message: r.reason }
      return { ok: true, post: r.post, message: '已贴到黑板' + (laneId ? '（这条线）' : '（全局）') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_board_read',
    description: '读共享黑板：默认读当前任务所在线的最新贴子；给 lane 读指定线，给 all=true 读全量最近贴子。开工前先读一次，能避免重复劳动。',
    parameters: {
      lane: { type: 'string', description: '可选：哪条线（lane_xxx 或 wi_xxx）；不填则用当前任务所在的线' },
      workitem_id: { type: 'string', description: '可选：用这个任务所在的线' },
      kind: { type: 'string', description: '可选：只看某类，如 decision / todo（多个用逗号）' },
      limit: { type: 'number', description: '最多几条，默认 30' },
      all: { type: 'boolean', description: '可选：true = 不看线，读所有最近贴子' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      let laneId = null
      const laneRef = String(args?.lane || '').trim()
      if (laneRef) {
        const found = findLaneRef(db, laneRef)
        if (!found) return { ok: false, message: '找不到这条线：' + laneRef + '（可传 lane_xxx 或上一单的 wi_xxx）' }
        laneId = found.id
      }
      const wi = String(args?.workitem_id || '').trim()
      if (!laneId && wi) {
        const item = getWorkItem(db, wi)
        if (item && item.laneId) laneId = item.laneId
      }
      const kinds = String(args?.kind || '').split(',').map((s) => s.trim()).filter(Boolean)
      const posts = listBoard(db, {
        ownerId: cfg.ownerId,
        laneId: args?.all ? null : laneId,
        kinds: kinds.length ? kinds : null,
        limit: args?.limit,
      })
      return { ok: true, laneId: args?.all ? null : laneId, count: posts.length, posts }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_prune',
    description: '清理旧的终态任务（done/failed/cancelled）。默认只预览清单；真删必须 dry_run=false 且 confirm=true。事件账本永远保留（可审计）。',
    parameters: {
      days: { type: 'number', description: '清理多少天以前的终态任务，默认 30' },
      dry_run: { type: 'boolean', description: 'true（默认）= 只列清单；false = 真删' },
      confirm: { type: 'boolean', description: '真删时必须显式 true' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const days = Math.max(1, Math.min(365, Number(args?.days) || 30))
      const dryRun = args?.dry_run !== false
      const preview = previewPrune(db, { ownerId: cfg.ownerId, days })
      if (dryRun) {
        return {
          ok: true, dry_run: true, count: preview.count, items: preview.items,
          message: preview.count
            ? '预览：将清理 ' + preview.count + ' 条（' + days + ' 天前的终态任务）。确认后调 secretary_prune(days=' + days + ', dry_run=false, confirm=true)'
            : '没有需要清理的任务（' + days + ' 天内没有终态旧任务）',
        }
      }
      if (args?.confirm !== true) return { ok: false, message: '真删必须 confirm=true（先 dry_run 看清单）' }
      const r = runPrune(db, { ownerId: cfg.ownerId, days })
      return { ok: true, deleted: r.deleted, ids: r.ids, message: '已清理 ' + r.deleted + ' 条（事件账本保留）' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_stats',
    description: '看任务分布与分工建议（近 N 天，按 topic 统计占比/耗时；满足阈值的会给出「要不要单独开 Worker 类型」的建议，只是建议）。',
    parameters: {
      days: { type: 'number', description: '统计最近多少天，默认 14' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const days = Math.max(1, Math.min(90, Number(args?.days) || 14))
      const summary = statsSummary(db, { ownerId: cfg.ownerId, days })
      const div = divisionSuggestions(db, { ownerId: cfg.ownerId, days })
      return {
        ok: true,
        ...summary,
        suggestions: div.suggestions,
        message: summary.message + (div.suggestions.length ? '；有 ' + div.suggestions.length + ' 条分工建议' : '；暂时不建议分工'),
      }
    },
  }))

  // ---------------- 简报 / 复盘 / 归档 / 模板 ----------------
  const appStateGet = (key) => {
    try { const r = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key); return r ? r.value : null } catch { return null }
  }
  const appStateSet = (key, value) => {
    try {
      db.prepare('INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
        .run(key, String(value), Date.now())
    } catch { /* ignore */ }
  }
  const archiveRules = () => (cfg.archive?.rules || []).map((r) => ({ ...r, target: String(r.target || '').replace(/\{workspace\}/g, cfg.workspaceRoot || '') }))
  const briefingEnabled = () => {
    const ov = appStateGet('briefing.enabled')
    if (ov === '1') return true
    if (ov === '0') return false
    return !!(cfg.briefing && cfg.briefing.enabled)
  }
  const briefingRun = (kind) => {
    const text = buildBrief(db, { ownerId: cfg.ownerId, kind: kind === 'weekly' ? 'weekly' : 'daily' })
    const day = new Date().toISOString().slice(0, 10)
    const dir = join(cfg.workspaceRoot || process.cwd(), '简报')
    const file = join(dir, day + '-' + (kind === 'weekly' ? '周报' : '日报') + '.md')
    try { writeReport(file, text) } catch { /* ignore */ }
    appendEvent(db, { type: EVENT_TYPE.BRIEFING_SENT, ownerId: cfg.ownerId, actor: ACTOR.KERNEL, payload: { kind, file, text: text.slice(0, 2000) } })
    appStateSet('briefing.last', text)
    appStateSet('briefing.lastKind', kind)
    appStateSet('briefing.lastAt', String(Date.now()))
    return { text, file }
  }

  ctx.tools.register(defineTool({
    name: 'secretary_briefing',
    description: '每日/每周简报：看最近一份、立即生成、或开关自动简报（开关状态持久化，随时可关）。简报内容来自任务账本/产物/待批工具申请，不调模型。',
    parameters: {
      op: { type: 'string', description: 'get（看最近一份）| run（立即生成）| on / off（开关自动简报）| status（状态）' },
      kind: { type: 'string', description: 'run 时：daily（默认）| weekly' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const op = String(args?.op || 'get').toLowerCase()
      if (op === 'on' || op === 'off') {
        appStateSet('briefing.enabled', op === 'on' ? '1' : '0')
        return { ok: true, enabled: op === 'on', message: op === 'on' ? '已开启自动简报' : '已关闭自动简报' }
      }
      if (op === 'run') {
        const r = briefingRun(String(args?.kind || 'daily').toLowerCase())
        return { ok: true, kind: args?.kind || 'daily', file: r.file, text: r.text, message: '已生成：' + r.file }
      }
      if (op === 'status') {
        return {
          ok: true,
          enabled: briefingEnabled(),
          dailyAt: cfg.briefing?.dailyAt || '08:30',
          weekly: cfg.briefing?.weekly !== false,
          weeklyAt: cfg.briefing?.weeklyAt || '09:00',
          lastAt: Number(appStateGet('briefing.lastAt') || 0) || null,
          lastKind: appStateGet('briefing.lastKind') || null,
        }
      }
      const last = appStateGet('briefing.last')
      return { ok: true, text: last || '（还没有生成过简报；用 run 生成一份）', lastAt: Number(appStateGet('briefing.lastAt') || 0) || null }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_report',
    description: '生成任务复盘报告（最近 N 天）：任务数/状态/类型/平均耗时/产物/删除审计/judge 调用/工具申请/失败明细，写成 markdown 文件。',
    parameters: {
      days: { type: 'number', description: '最近多少天，默认 7' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const days = Math.max(1, Math.min(90, Number(args?.days) || 7))
      const text = buildReview(db, { ownerId: cfg.ownerId, days })
      const file = join(cfg.workspaceRoot || process.cwd(), '简报', '复盘-' + days + 'd-' + new Date().toISOString().slice(0, 10) + '.md')
      try { writeReport(file, text) } catch { /* ignore */ }
      return { ok: true, file, text, message: '复盘已生成：' + file }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_archive',
    description: '桌面/下载归档：scan 扫描候选（默认只提议），apply 执行移动（需配置 app 里 archive.allowApply=true）。规则按扩展名匹配到目标目录。',
    parameters: {
      op: { type: 'string', description: 'scan（默认）| apply | status' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const op = String(args?.op || 'scan').toLowerCase()
      const conf = cfg.archive || {}
      if (op === 'status') {
        return { ok: true, enabled: !!conf.enabled, allowApply: !!conf.allowApply, watchDirs: conf.watchDirs || [], rules: conf.rules || [], minAgeHours: conf.minAgeHours ?? 24 }
      }
      const candidates = scanArchive({ watchDirs: conf.watchDirs || [], rules: archiveRules(), minAgeHours: conf.minAgeHours ?? 24 })
      if (op === 'scan' || !conf.allowApply) {
        appendEvent(db, { type: EVENT_TYPE.ARCHIVE_SCANNED, ownerId: cfg.ownerId, actor: ACTOR.KERNEL, payload: { count: candidates.length, allowApply: !!conf.allowApply } })
        return {
          ok: true,
          op: 'scan',
          candidates: candidates.map((c) => ({ path: c.path, target: c.target, size: c.size })),
          allowed: !!conf.allowApply,
          message: conf.allowApply ? '扫描到 ' + candidates.length + ' 个候选；确认后调 op=apply' : '扫描到 ' + candidates.length + ' 个候选（当前只提议，要执行请先在配置里打开 archive.allowApply）',
        }
      }
      const result = applyArchive(candidates)
      return { ok: true, op: 'apply', moved: result.moved, failed: result.failed, message: '已移动 ' + result.moved.length + ' 个文件' + (result.failed.length ? '，失败 ' + result.failed.length + ' 个' : '') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_templates',
    description: '查看/读取常用模板（markdown 文件，放在工作区 templates/ 或配置 templatesDir）。只读，方便 Relay 把模板内容带进任务。',
    parameters: {
      op: { type: 'string', description: 'list（默认）| get' },
      name: { type: 'string', description: 'get 时的模板文件名' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const dir = cfg.templatesDir || join(cfg.workspaceRoot || process.cwd(), 'templates')
      const op = String(args?.op || 'list').toLowerCase()
      try {
        if (!existsSync(dir)) return { ok: false, message: '模板目录不存在：' + dir + '（手动放几个 .md 进去即可）' }
        const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
        if (op === 'get') {
          const name = String(args?.name || '')
          if (!name || !files.includes(name)) return { ok: false, files, message: '没找到模板：' + name }
          const text = readFileSync(join(dir, name), 'utf8').slice(0, 20000)
          return { ok: true, name, text, message: '已读取模板 ' + name }
        }
        return { ok: true, dir, files, message: files.length ? '共 ' + files.length + ' 个模板' : '模板目录是空的：' + dir }
      } catch (err) {
        return { ok: false, message: '读取模板失败：' + describeError(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_models',
    description: '列出 DSH 当前可路由的模型（按 provider 分组，含默认选择），用来配置 workerModel / workerModelByTopic（按任务类型给工人选模型）。',
    parameters: {},
    output: JSON_OUTPUT,
    async execute() {
      try {
        const catalog = await listModelCatalog(ctx)
        const groups = (catalog && catalog.groups) || []
        const flat = []
        for (const g of groups) {
          for (const m of (g.models || [])) {
            flat.push({ provider: g.id, model: m.id, label: m.label || m.name || m.id, reasoning: m.reasoning || null })
          }
        }
        return {
          ok: true,
          default: catalog && (catalog.default || catalog.selection) || null,
          models: flat,
          workerModel: cfg.workerModel || null,
          workerModelByTopic: cfg.workerModelByTopic || {},
          message: '可路由模型 ' + flat.length + ' 个；工人模型配置：' + (cfg.workerModel && cfg.workerModel.model ? cfg.workerModel.provider + '/' + cfg.workerModel.model : '跟随默认'),
        }
      } catch (err) {
        return { ok: false, message: '读模型目录失败：' + describeError(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_cancel_task',
    description: '取消一个任务（未结束的状态都能取消）。数据不物理删除，只标 cancelled，可审计。用来清理卡住或不再需要的活。',
    parameters: {
      workitem_id: { type: 'string', required: true, description: '要取消的任务 ID' },
      reason: { type: 'string', description: '取消原因（可选）' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const id = String(args?.workitem_id || '').trim()
      if (!id) return { ok: false, message: 'workitem_id 不能为空' }
      const current = getWorkItem(db, id)
      if (!current) return { ok: false, message: '任务不存在：' + id }
      if (isTerminal(current.status)) return { ok: false, message: '任务已结束，不用取消：' + current.status }
      try {
        const item = cancelWorkItem(db, id, { reason: String(args?.reason || '主人取消'), actor: 'owner' })
        closeWorkerSessions(id)
        laneReleaseAndPump(item.laneId)
        return { ok: true, workitem_id: id, status: item.status, message: '已取消：' + id + '（数据保留，可审计）' }
      } catch (err) {
        return { ok: false, message: '取消失败：' + describeError(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_remember',
    description: '记住一条信息（事实/画像/纪事）。同一 key 的新内容会覆盖旧内容，旧内容留痕但不再注入。',
    parameters: {
      text: { type: 'string', required: true, description: '要记住的一句话' },
      type: { type: 'string', description: 'profile|fact|episode，默认 fact' },
      key: { type: 'string', description: '覆盖用的键（例如「打印偏好」），不填则只追加' },
      tags: { type: 'string', description: '关键词，空格分隔（可选）' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      try {
        const r = remember(db, {
          ownerId: cfg.ownerId,
          type: args?.type ? String(args.type) : 'fact',
          key: args?.key ? String(args.key) : null,
          text: String(args?.text || ''),
          tags: args?.tags ? String(args.tags) : '',
        })
        return { ok: true, id: r.id, superseded: r.superseded, message: '记住了：' + r.text.slice(0, 60) }
      } catch (err) {
        return { ok: false, message: '记住失败：' + describeError(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_recall',
    description: '查记忆：按关键词检索事实/画像，或列最近记忆。没查到就说没有，不要编。',
    parameters: {
      query: { type: 'string', description: '关键词（可选；不填列最近的）' },
      limit: { type: 'number', description: '最多几条，默认 5' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      try {
        const items = recall(db, {
          ownerId: cfg.ownerId,
          query: args?.query ? String(args.query) : '',
          limit: args?.limit ? Number(args.limit) : 5,
        })
        return { ok: true, count: items.length, items: items.map((m) => ({ id: m.id, type: m.type, text: m.text, tags: m.tags })) }
      } catch (err) {
        return { ok: false, message: '查询失败：' + describeError(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_forget',
    description: '忘掉匹配关键词的记忆（软删：标记失效，不再注入、不再查出）。只主人明确要求时用。',
    parameters: {
      query: { type: 'string', required: true, description: '要忘掉的关键词' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      try {
        const r = forget(db, { ownerId: cfg.ownerId, query: String(args?.query || '') })
        return { ok: true, forgotten: r.forgotten, message: r.forgotten ? '已忘掉 ' + r.forgotten + ' 条' : '没有匹配的记忆' }
      } catch (err) {
        return { ok: false, message: '忘掉失败：' + describeError(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_propose_group',
    description: '把 2 个以上「还没开始跑」的任务合并成一个。默认不合并：只有明确判断是同一件事、且把握 ≥0.7 时才调用；合并后可拆回。',
    parameters: {
      item_ids: { type: 'string', required: true, description: '要合并的任务 ID，逗号分隔（至少 2 个）' },
      reason: { type: 'string', required: true, description: '为什么判断这是同一件事' },
      confidence: { type: 'number', required: true, description: '把握 0–1，低于阈值会被拒绝' },
      title: { type: 'string', description: '合并后的一句话任务（可选）' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      if (!cfg.merge || !cfg.merge.enabled) return { ok: false, message: '归并没开启' }
      const ids = String(args?.item_ids || '').split(',').map((x) => x.trim()).filter(Boolean)
      const conf = Number(args?.confidence ?? 0)
      if (conf < cfg.merge.minConfidence) return { ok: false, message: '把握不足（' + conf + ' < ' + cfg.merge.minConfidence + '），不合并' }
      try {
        const r = mergeWorkItems(db, {
          ownerId: cfg.ownerId, memberIds: ids, title: args?.title,
          reason: String(args?.reason || ''), confidence: conf, actor: 'relay',
          maxMembers: cfg.merge.maxMembers,
        })
        for (const id of ids) cancelPendingDispatch(id)
        scheduleDispatch(r.merged)
        return { ok: true, merged_workitem_id: r.merged.id, members: r.members, message: '已合并：' + r.merged.id }
      } catch (err) {
        return { ok: false, message: '归并被拒绝：' + describeError(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'secretary_split_merged',
    description: '把合并任务拆回：成员原文各建一个新任务，合并任务取消（原记录保留）。',
    parameters: {
      workitem_id: { type: 'string', required: true, description: '合并任务的 ID' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const id = String(args?.workitem_id || '').trim()
      if (!id) return { ok: false, message: 'workitem_id 不能为空' }
      try {
        const r = splitMerged(db, id, { maxMembers: cfg.merge?.maxMembers || 5 })
        for (const w of r.created) scheduleDispatch(w)
        return { ok: true, cancelled: id, created: r.created.map((w) => w.id), message: '已拆回 ' + r.created.length + ' 个任务' }
      } catch (err) {
        return { ok: false, message: '拆回失败：' + describeError(err) }
      }
    },
  }))

  // 只读 HTTP 的鉴权：
  // - 配了 token：所有请求都要 token（header 或 query）
  // - 没配 token：只放行本机 loopback；且**写操作**必须没有 Origin 头（浏览器跨站/同站 fetch 都会带 Origin，
  //   挡住 no-cors 打 localhost 的 CSRF；curl/脚本不带 Origin，不受影响）
  function isLoopback(req) {
    const ip = String((req && req.socket && req.socket.remoteAddress) || '')
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  }
  function authorized(req, url, method = 'GET') {
    if (cfg.httpToken) {
      const header = String((req.headers && req.headers['x-secretary-token']) || '')
      const query = String(url.searchParams.get('token') || '')
      return header === cfg.httpToken || query === cfg.httpToken
    }
    if (!isLoopback(req)) return false
    const m = String(method || 'GET').toUpperCase()
    if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
      // 写操作：允许「同源」fetch（面板按钮），拒绝外站 Origin（防 CSRF）
      const origin = String((req.headers && req.headers.origin) || '')
      if (origin) {
        const host = String((req.headers && req.headers.host) || '')
        try {
          const o = new URL(origin)
          if (!host || o.host !== host) return false
        } catch { return false }
      }
    }
    return true
  }

  // ---------------- 只读 HTTP ----------------
  function lastWorkerTool(workitemId) {
    try {
      const row = db.prepare(
        "SELECT type, payload FROM events WHERE workitem_id = ? AND type IN ('worker.tool', 'worker.tool.start') ORDER BY seq DESC LIMIT 1",
      ).get(workitemId)
      if (!row) return null
      const p = JSON.parse(row.payload)
      if (row.type === EVENT_TYPE.WORKER_TOOL_START) {
        return { tool: p.tool, running: true, ok: null, durationMs: null, summary: '' }
      }
      return { tool: p.tool, running: false, ok: !!p.ok, durationMs: p.durationMs ?? null, summary: p.summary || '' }
    } catch {
      return null
    }
  }

  function parseFiles(value) {
    return String(value || '')
      .split(/[\n,;]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((path) => ({ path }))
  }

  function outboxSummary() {
    try { return outboxStats(db) } catch (err) { return { error: describeError(err) } }
  }

  // Relay 工具白名单守卫：Relay 会话只能调「传话/建任务/交付」类工具，重活一律拒绝
  ctx.effect(() => {
    const dispose = ctx.tools.guard((exec) => {
      try {
        const name = toolNameOf(exec)
        // 工人：只放行干活类工具（挡浏览器逃生口/IM/打印/插件管理）
        const sid = agentSessionId(exec)
        if (sid) {
          const row = db.prepare("SELECT workitem_id FROM sessions WHERE id = ? AND role = 'worker' ORDER BY rowid DESC LIMIT 1").get(sid)
          if (row) {
            const w = row.workitem_id ? getWorkItem(db, row.workitem_id) : null
            const laneId = w ? w.laneId : null
            // 任务已取消/结束：工人默认必须停手；但主人在会话里手动接管（批注、改稿）时放行
            if (w && (w.status === 'cancelled' || w.status === 'merged' || w.status === 'blocked' || w.status === 'done' || w.status === 'failed')) {
              if (!manualTakeover(sid, w)) {
                log('工人调用被拦（任务已结束 ' + w.status + '）：' + name)
                return '这个任务已经是 ' + w.status + ' 状态，立即停止，不要再调用任何工具，也不要继续修改系统或文件。'
              }
            }
            // 文件写租约：同路径同时只允许一个任务写（读不限）
            try {
              if ((name === 'write' || name === 'edit') && row.workitem_id) {
                const leaseArgs = exec?.arguments ?? exec?.args ?? exec?.input
                const target = leaseArgs && typeof leaseArgs === 'object' ? (leaseArgs.file_path || leaseArgs.path) : null
                if (target) {
                  const lease = acquireLease(db, { path: target, workitemId: row.workitem_id })
                  if (!lease.ok) {
                    log('文件租约冲突：' + target + ' 被 ' + lease.holder + ' 占用')
                    return '这个文件正被另一个任务（' + lease.holder + '）写入：' + target + '。等它完成或换文件，不要强行覆盖。'
                  }
                }
              }
            } catch { /* 租约失败不阻塞 */ }
            // 系统保护边界：写系统目录 / 提权命令，必须走工具申请，不许工人悄悄改
            try {
              const rawArgs0 = exec?.arguments ?? exec?.args ?? exec?.input
              const boundary = protectedBoundaryReason(name, rawArgs0)
              if (boundary && !hasToolGrant(db, { tool: name, workitemId: row.workitem_id, laneId })) {
                log('工人触碰系统边界被拦：' + name + ' ' + boundary.detail)
                return '这个操作触碰系统保护边界（' + boundary.detail + '）：工人不允许直接改系统目录/提权。' +
                  '如果任务确实需要，先调 secretary_request_tool(tool="' + name + '", reason="需要修改系统配置") 申请，由主人单独批准。'
              }
            } catch { /* 检查失败不阻塞正常任务 */ }
            if (!workerToolAllowed(name) && !hasToolGrant(db, { tool: name, workitemId: row.workitem_id, laneId })) {
              log('工人越权调用被拦：' + name + '（' + sid + '）')
              return workerDenialMessage(name) + ' 需要的话先调 secretary_request_tool 申请。'
            }
            // 删除护栏：bash/pwsh 里的删除命令，限制范围 + 规模 + 审计
            if (name === 'bash' || name === 'pwsh') {
              const rawArgs = exec?.arguments ?? exec?.args ?? exec?.input
              const command = typeof rawArgs === 'string' ? rawArgs : String((rawArgs && (rawArgs.command || rawArgs.script)) || '')
              const workdir = rawArgs && typeof rawArgs === 'object' && rawArgs.workdir ? String(rawArgs.workdir) : ''
              const analysis = analyzeDeletionCommand(command, {
                workspaceRoot: cfg.workspaceRoot,
                searchDirs: cfg.searchDirs || [],
                workdir,
                maxFilesAuto: (cfg.deletionGuard && cfg.deletionGuard.maxFilesAuto) || 50,
              })
              if (analysis.kind === 'delete') {
                const w = row.workitem_id ? getWorkItem(db, row.workitem_id) : null
                if (analysis.action === 'deny') {
                  log('删除拦截：' + analysis.reason)
                  return '删除被拒绝：' + analysis.reason + '。把要删的清单先发给主人确认，或改到工作区内。'
                }
                if (analysis.action === 'escalate') {
                  try {
                    const req = createToolRequest(db, {
                      ownerId: cfg.ownerId,
                      laneId: w ? w.laneId : null,
                      workitemId: row.workitem_id,
                      sessionId: sid,
                      tool: 'file.delete',
                      reason: analysis.reason + (analysis.targets && analysis.targets.length ? '：' + analysis.targets.slice(0, 5).join('、') : ''),
                      wantScope: 'once',
                    })
                    log('删除转审批：' + req.id)
                    return '这次删除需要主人确认（已提交申请 request_id=' + req.id + '）：' + analysis.reason + '。等批准后再试，先做别的。'
                  } catch (err) {
                    return '这次删除需要主人确认：' + analysis.reason
                  }
                }
                appendEvent(db, {
                  type: EVENT_TYPE.FILE_DELETED,
                  ownerId: cfg.ownerId,
                  workitemId: row.workitem_id,
                  sessionId: sid,
                  channel: w ? w.sourceChannel : null,
                  actor: 'worker',
                  payload: {
                    targets: (analysis.targets || []).slice(0, 20),
                    count: analysis.count || 0,
                    bytes: analysis.bytes || 0,
                    command: redactText(command, 160),
                  },
                })
                log('删除放行：count=' + (analysis.count || 0) + ' bytes=' + (analysis.bytes || 0))
              }
            }
          }
        }
            // 视频类工具参数纠错：size 与 resolution/aspect_ratio 同时传会报协议冲突
            if (name === 'generate_video') {
              const rawVideoArgs = exec?.arguments ?? exec?.args ?? exec?.input
              const va = rawVideoArgs && typeof rawVideoArgs === 'object' ? rawVideoArgs : {}
              if (va.size && (va.resolution || va.aspect_ratio)) {
                return 'generate_video 参数冲突：size 不能和 resolution / aspect_ratio 同时传。只传 size（如 "1280*720"）+ duration（如 5），其余参数省略。'
              }
            }
        // Relay：只放行传话/交付类工具
        const ap = svc(ctx, 'agentPresets')
        const sess = exec && exec.agent && exec.agent.session
        const preset = ap && sess && typeof ap.presetForSession === 'function' ? ap.presetForSession(sess) : null
        if (preset !== cfg.relayPreset) return undefined
        if (relayToolAllowed(name)) return undefined
        log('Relay 越权调用被拦：' + name)
        return relayDenialMessage(name)
      } catch {
        return undefined
      }
    })
    return () => {
      try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ }
    }
  })

  // ---------------- 对外 HTTP：面板 + 入站 + outbox ----------------
  function readJsonBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          const err = new Error('body too large'); err.statusCode = 413; reject(err)
          try { req.destroy() } catch { /* ignore */ }
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
        } catch {
          const err = new Error('bad json'); err.statusCode = 400; reject(err)
        }
      })
      req.on('error', reject)
    })
  }

  ctx.inject(['webServer'], (httpCtx) => {
    try {
      const server = httpCtx.webServer
      if (!server || typeof server.register !== 'function') {
        log('没有 webServer，HTTP 接口跳过')
        return
      }
      const send = (res, code, payload) => {
        res.statusCode = code
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      httpCtx.effect(() => server.register({
        kind: 'prefix',
        path: '/secretary/v1',
        handler: async (req, res) => {
          try {
            const url = new URL(String(req.url || '/'), 'http://x')
            const method = String(req.method || 'GET').toUpperCase()
            if (!authorized(req, url, method)) return send(res, 401, { ok: false, error: 'unauthorized' })
            const path = url.pathname.replace(/^\/secretary\/v1/, '') || '/'
            if (method === 'POST' && !String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
              return send(res, 415, { ok: false, error: 'content-type must be application/json' })
            }

            if (method === 'POST' && path === '/inbound') {
              const body = await readJsonBody(req)
              const r = gatewayInbound(db, body, { ownerId: cfg.ownerId })
              if (r.accepted && !r.duplicate && r.workitemId) {
                try {
                  transition(db, r.workitemId, ITEM_STATUS.TRIAGED, { reason: 'inbound: ' + String(body.channel || ''), actor: 'system' })
                  transition(db, r.workitemId, ITEM_STATUS.QUEUED, { reason: 'route: default', actor: 'system' })
                  const policy = getPolicy(db, body.channel)
                  scheduleDispatch(getWorkItem(db, r.workitemId), policy && policy.mode === 'direct' ? 0 : undefined)
                } catch (err) {
                  log('入站建任务后续失败：' + describeError(err))
                }
              }
              return send(res, r.accepted ? 200 : 400, { ok: r.accepted, ...r })
            }

            if (method === 'POST' && path === '/tasks') {
              const body = await readJsonBody(req)
              const text = String(body.text || '').trim()
              if (!text) return send(res, 400, { ok: false, error: 'text 不能为空' })
              if (body.model && !parseModelRef(body.model)) return send(res, 400, { ok: false, error: 'model 格式应为 provider/model' })
              const ws = resolveTaskWorkspace(body.workspace, cfg)
              if (ws.error) return send(res, 400, { ok: false, error: ws.error })
              let cwd = ws.cwd
              // 显式接续某条线：lane_xxx 或上一单 wi_xxx
              let lane = null
              let laneSource = 'auto'
              const laneRefRaw = String(body.lane || '').trim()
              if (laneRefRaw) {
                lane = findLaneRef(db, laneRefRaw)
                if (!lane) return send(res, 400, { ok: false, error: '找不到这条线：' + laneRefRaw })
                if (!body.workspace && lane.workspace) cwd = lane.workspace
                laneSource = 'explicit'
              }
              if (!lane) {
                try {
                  const focus = focusFromText(text)
                  const unique = String(body.worker || '').toLowerCase() === 'new' ? Date.now().toString(36) : null
                  laneSource = unique ? 'new' : 'auto'
                  lane = ensureLane(db, {
                    ownerId: cfg.ownerId,
                    key: laneKeyFor({ channel: 'gui', peer: cfg.ownerId, workspace: cwd, baseWorkspace: cfg.workspaceRoot, focus, unique }),
                    workspace: cwd,
                  })
                } catch (err) { log('建线失败：' + describeError(err)) }
              if (lane) syncLaneLabel(lane.id, text)
              }
              try {
                if (lane) {
                  const prev = db.prepare(
                    "SELECT topic, updated_at FROM workitems WHERE lane_id = ? ORDER BY updated_at DESC LIMIT 1",
                  ).get(lane.id)
                  appendEvent(db, {
                    type: EVENT_TYPE.LANE_ROUTED,
                    ownerId: cfg.ownerId,
                    channel: 'gui',
                    actor: ACTOR.RELAY,
                    payload: {
                      laneKey: lane.key,
                      laneId: lane.id,
                      laneSource,
                      focus: focusFromText(text),
                      topic: body.topic ? String(body.topic) : classifyTopic(text),
                      workerParam: body.worker ? String(body.worker) : 'auto',
                      hasSession: !!lane.sessionId,
                      idleGapMs: prev ? Date.now() - Number(prev.updated_at) : null,
                      prevTopic: prev ? prev.topic : null,
                      topicMismatch: false,
                    },
                  })
                }
              } catch { /* ignore */ }
              // 建任务（与 create_task 工具同一条路）
              const scoped = inferScope({ text, cfg, lane })
              const { item } = createWorkItem(db, {
                ownerId: cfg.ownerId,
                channel: 'gui',
                peer: cfg.ownerId,
                kind: 'task',
                intent: text,
                inputs: Array.isArray(body.files) ? body.files.map((p) => ({ path: String(p) })) : [],
                permission: normalizeWorkerPermission(body.permission, cfg.workerPermissionPreset),
                laneId: lane ? lane.id : null,
                workspace: cwd,
                origin: 'http',
                projectRoot: scoped.projectRoot,
                scope: scoped.scope,
                scopeSource: scoped.source,
                scopeConfidence: scoped.confidence,
                topic: body.topic ? String(body.topic) : classifyTopic(text),
                model: body.model ? String(body.model) : null,
              })
              transition(db, item.id, ITEM_STATUS.TRIAGED, { reason: 'http: task' })
              transition(db, item.id, ITEM_STATUS.QUEUED, { reason: 'route: default' })
              scheduleDispatch(getWorkItem(db, item.id))
              return send(res, 200, { ok: true, workitem_id: item.id, workspace: cwd, status: 'queued' })
            }

            if (method === 'POST' && path === '/tool-requests/decide') {
              const body = await readJsonBody(req)
              const id = String(body.id || '').trim()
              if (!id) return send(res, 400, { ok: false, error: 'id 不能为空' })
              const scope = ['once', 'lane', 'global'].includes(String(body.scope || '')) ? String(body.scope) : 'once'
              const r = decideToolRequest(db, id, { approve: body.approve !== false, scope, decidedBy: 'owner' })
              return send(res, 200, { ok: true, request: r })
            }

            if (method === 'POST' && /^\/outbox\/[^/]+\/ack$/.test(path)) {
              const id = path.split('/')[2]
              const body = await readJsonBody(req)
              const r = outboxAck(db, id, { ok: body.ok !== false, receipt: body.receipt, error: body.error })
              return send(res, r.ok ? 200 : 404, { ok: r.ok, ...r })
            }

            if (method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' })

            let body
            if (path === '/status' || path === '/') {
              body = { ok: true, dbPath: cfg.dbPath, schemaVersion: getSchemaVersion(db), events: countEvents(db), counts: summaryCounts(db), lastError: state.lastError, startedAt: state.startedAt, clientHalf: clientHalfInfo(), reporter: deliveryBudget(db, { ownerId: cfg.ownerId, budget: cfg.reporter.dailyL3Budget }), outbox: outboxSummary(), hardware: state.hardware, resources: { sample: state.sample, plan: state.plan, concurrency: state.concurrency.current, overloaded: state.overloaded }, schedules: listSchedules(db, { limit: 10 }).length }
            } else if (path === '/tree') {
              // 任务树 + 线时间条：给面板/看板画泳道与 outline，纯数据
              const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200))
              const rows = db.prepare('SELECT * FROM workitems ORDER BY created_at DESC LIMIT ?').all(limit)
              const nodes = new Map()
              for (const row of rows) {
                const acc = row.acceptance ? JSON.parse(row.acceptance) : []
                const ev = row.evidence ? JSON.parse(row.evidence) : []
                nodes.set(row.id, {
                  id: row.id,
                  status: row.status,
                  topic: row.topic,
                  intent: String(row.intent || '').slice(0, 140),
                  createdAt: Number(row.created_at),
                  updatedAt: Number(row.updated_at),
                  laneId: row.lane_id,
                  parentId: row.parent_id,
                  reviewMode: row.review_mode,
                  submittedAt: row.submitted_at,
                  acceptance: acc,
                  evidenceCount: ev.length,
                  result: String(row.result || '').slice(0, 300),
                  children: [],
                })
              }
              const roots = []
              for (const node of nodes.values()) {
                if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId).children.push(node)
                else roots.push(node)
              }
              // 负责人/工时：worker 类型 + 模型；工时从建单到处结（submitted/done/failed）或最后活跃
              for (const node of nodes.values()) {
                const ended = node.submittedAt || (['done', 'failed', 'cancelled', 'merged'].includes(node.status) ? node.updatedAt : null)
                node.durationMs = ended ? Math.max(0, ended - node.createdAt) : null
                node.acceptanceDone = (node.acceptance || []).filter((a) => a && a.done).length
                node.acceptanceTotal = (node.acceptance || []).length
              }
              const laneList = listLanes(db, { ownerId: cfg.ownerId, limit: 30 })
              const laneIds = new Set(laneList.map((l) => l.id))
              // 按线分组的任务树：线是根，任务是子；无线归属的单独一组（游离）
              const groups = laneList.map((l) => {
                const items = [...nodes.values()]
                  .filter((n) => n.laneId === l.id)
                  .sort((a, b) => a.createdAt - b.createdAt)
                  .map((n) => ({
                    id: n.id, status: n.status, intent: n.intent, createdAt: n.createdAt, updatedAt: n.updatedAt,
                    durationMs: n.durationMs, reviewMode: n.reviewMode, acceptanceDone: n.acceptanceDone,
                    acceptanceTotal: n.acceptanceTotal, evidenceCount: n.evidenceCount, parentId: n.parentId,
                  }))
                return {
                  id: l.id,
                  label: l.label || (items[0] ? String(items[0].intent || '').slice(0, 24) : null),
                  labelDerived: !l.label,
                  status: l.status,
                  workspace: l.workspace || null,
                  reviewMode: l.reviewMode || null,
                  lastUsedAt: l.lastUsedAt || null,
                  total: items.length,
                  running: items.filter((i) => ['running', 'submitted', 'queued', 'triaged'].includes(i.status)).length,
                  done: items.filter((i) => i.status === 'done').length,
                  failed: items.filter((i) => ['failed', 'blocked'].includes(i.status)).length,
                  items,
                }
              }).filter((g) => g.total > 0 || g.status === 'active')
              const loose = [...nodes.values()]
                .filter((n) => !n.laneId || !laneIds.has(n.laneId))
                .sort((a, b) => b.createdAt - a.createdAt)
                .map((n) => ({
                  id: n.id, status: n.status, intent: n.intent, createdAt: n.createdAt, updatedAt: n.updatedAt,
                  durationMs: n.durationMs, reviewMode: n.reviewMode, acceptanceDone: n.acceptanceDone,
                  acceptanceTotal: n.acceptanceTotal, evidenceCount: n.evidenceCount,
                }))
              const lanes = laneList.map((l) => {
                const items = db.prepare(
                  'SELECT id, status, created_at, updated_at, submitted_at, review_mode, acceptance, evidence, substr(intent, 1, 60) AS intent FROM workitems WHERE lane_id = ? ORDER BY created_at ASC LIMIT 100',
                ).all(l.id)
                const rev = db.prepare(
                  'SELECT COUNT(*) AS c FROM revisions WHERE workitem_id IN (SELECT id FROM workitems WHERE lane_id = ?)',
                ).get(l.id)
                const mapped = items.map((w) => {
                  let acc = []
                  let ev = []
                  try { acc = w.acceptance ? JSON.parse(w.acceptance) : [] } catch { acc = [] }
                  try { ev = w.evidence ? JSON.parse(w.evidence) : [] } catch { ev = [] }
                  const ended = Number(w.submitted_at || 0) || (['done', 'failed', 'cancelled', 'merged'].includes(w.status) ? Number(w.updated_at) : 0)
                  return {
                    id: w.id,
                    status: w.status,
                    from: Number(w.created_at),
                    to: Number(w.updated_at),
                    intent: w.intent,
                    durationMs: ended ? Math.max(0, ended - Number(w.created_at)) : null,
                    reviewMode: w.review_mode || null,
                    acceptanceDone: acc.filter((a) => a && a.done).length,
                    acceptanceTotal: acc.length,
                    evidenceCount: ev.length,
                  }
                })
                return {
                  id: l.id,
                  label: l.label || (mapped[0] ? String(mapped[0].intent || '').slice(0, 24) : null),
                  status: l.status,
                  workspace: l.workspace,
                  reviewMode: l.reviewMode,
                  sessionId: l.sessionId,
                  revisions: Number(rev.c),
                  total: mapped.length,
                  running: mapped.filter((w) => ['running', 'submitted', 'queued'].includes(w.status)).length,
                  done: mapped.filter((w) => w.status === 'done').length,
                  failed: mapped.filter((w) => ['failed', 'blocked'].includes(w.status)).length,
                  latestAt: mapped.length ? Math.max(...mapped.map((w) => w.to)) : Number(l.lastUsedAt || 0),
                  items: mapped,
                }
              })
              body = { ok: true, generatedAt: Date.now(), counts: summaryCounts(db), roots, groups, loose, lanes }
            } else if (path === '/stats') {
              const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 14))
              body = { ok: true, ...statsSummary(db, { ownerId: cfg.ownerId, days }), suggestions: divisionSuggestions(db, { ownerId: cfg.ownerId, days }).suggestions }
            } else if (path === '/panel') {
              const active = listWorkItems(db, { limit: 50 }).filter((w) => !isTerminal(w.status))
              const runningCount = db.prepare("SELECT COUNT(*) AS n FROM workitems WHERE status = 'running'").get()
              const guidanceCounts = {}
              const revisionCounts = {}
              const costToday = (() => {
                const d = new Date()
                d.setHours(0, 0, 0, 0)
                return costTotals(db, { since: d.getTime() })
              })()
              const costMonth = (() => {
                const d = new Date()
                d.setDate(1)
                d.setHours(0, 0, 0, 0)
                return costTotals(db, { since: d.getTime() })
              })()
              try {
                for (const g of db.prepare("SELECT workitem_id, COUNT(*) AS n FROM events WHERE type = 'worker.user_message' GROUP BY workitem_id").all()) {
                  guidanceCounts[g.workitem_id] = Number(g.n || 0)
                }
                for (const r of db.prepare("SELECT workitem_id, COUNT(*) AS n FROM revisions GROUP BY workitem_id").all()) {
                  revisionCounts[r.workitem_id] = Number(r.n || 0)
                }
              } catch { /* ignore */ }
              body = {
                ok: true,
                counts: summaryCounts(db),
                active: active.map((w) => ({ id: w.id, status: w.status, intent: w.intent, needsHuman: w.needsHuman, createdAt: w.createdAt, updatedAt: w.updatedAt, sessionId: w.sessionId, laneId: w.laneId, workspace: w.workspace, projectRoot: w.projectRoot, scope: w.scope, scopeSource: w.scopeSource, lastStep: lastWorkerTool(w.id), guidance: guidanceCounts[w.id] || 0, revisions: revisionCounts[w.id] || 0, latestRevision: latestRevision(db, w.id), cost: costFor(db, w.id) })),
                lanes: listLanes(db, { ownerId: cfg.ownerId, limit: 20 }).map((l) => ({ id: l.id, key: l.key, status: l.status, projectRoot: l.projectRoot, scope: l.scope, scopeMode: l.scopeMode, sessionId: l.sessionId, current: l.currentWorkitemId, lastUsedAt: l.lastUsedAt })),
                needsHuman: active.filter((w) => w.needsHuman).length,
                recent: db.prepare("SELECT * FROM workitems WHERE status IN ('done','failed','cancelled') ORDER BY updated_at DESC LIMIT 5").all().map((r) => ({ id: r.id, status: r.status, intent: String(r.intent || '').slice(0, 60), updatedAt: Number(r.updated_at), sessionId: r.session_id || null, laneId: r.lane_id || null, projectRoot: r.project_root || null, scope: r.scope || null, scopeSource: r.scope_source || null, scopeConfidence: r.scope_confidence ?? null, workspace: r.workspace || null, guidance: guidanceCounts[r.id] || 0, revisions: revisionCounts[r.id] || 0, latestRevision: latestRevision(db, r.id) })),
                workers: Number(runningCount.n || 0),
                // 告警：面板顶部要人看一眼的几件事（都不用点开才知道）
                alerts: (() => {
                  const out = []
                  const timeoutSec = Math.max(60, Number(cfg.workerTimeoutSec) || 900)
                  try {
                    const silentMs = Math.max(120, Number(cfg.dispatchSilentSec) || 8 * 60) * 1000
                    for (const s of findSilentDispatches(db, { silentMs })) {
                      out.push({ level: 'warn', kind: 'silent', workitemId: s.id, text: '派单后没回音：' + String(s.intent || s.id).slice(0, 28) })
                    }
                  } catch { /* 检测失败不影响面板 */ }
                  try {
                    const slowCut = Date.now() - timeoutSec * 0.7 * 1000
                    for (const r of db.prepare(
                      `SELECT w.id, w.intent, COALESCE((SELECT MAX(e.ts) FROM events e WHERE e.workitem_id = w.id), w.updated_at) AS last
                         FROM workitems w WHERE w.status = 'running'`,
                    ).all()) {
                      if (Number(r.last) < slowCut) {
                        out.push({ level: 'warn', kind: 'slow', workitemId: r.id, text: '快超时（超 ' + timeoutSec + ' 秒不动就判死）：' + String(r.intent || r.id).slice(0, 26) })
                      }
                    }
                  } catch { /* ignore */ }
                  try {
                    const sub = Number(db.prepare("SELECT COUNT(*) AS n FROM workitems WHERE status = 'submitted'").get().n || 0)
                    if (sub) out.push({ level: 'info', kind: 'review', text: sub + ' 单待验收（secretary_review）' })
                  } catch { /* ignore */ }
                  try {
                    const pend = Number(db.prepare("SELECT COUNT(*) AS n FROM tool_requests WHERE owner_id = ? AND status IN ('pending','escalated')").get(cfg.ownerId).n || 0)
                    if (pend) out.push({ level: 'info', kind: 'tool', text: pend + ' 个工具申请待批' })
                  } catch { /* ignore */ }
                  if (state.overloaded) out.push({ level: 'warn', kind: 'resource', text: '资源过载，已收紧派单' })
                  return out
                })(),
                system: {
                  cores: state.hardware ? state.hardware.cores : null,
                  totalMB: state.hardware ? state.hardware.totalMB : null,
                  sampledAt: state.sample ? state.sample.at : null,
                  availMB: state.sample ? state.sample.availMB : null,
                  memUsedPercent: state.sample && state.sample.totalMB
                    ? Math.round(((state.sample.totalMB - state.sample.availMB) / state.sample.totalMB) * 100)
                    : null,
                  load1: state.sample && state.sample.loadKnown ? state.sample.load1 : null,
                  loadKnown: !!(state.sample && state.sample.loadKnown),
                  concurrency: state.concurrency ? state.concurrency.current : null,
                  desired: state.plan ? state.plan.desired : null,
                  reason: state.plan ? state.plan.reason : null,
                  overloaded: !!state.overloaded,
                },
                toolRequests: (() => {
                  const rows = db.prepare(
                    "SELECT id, tool, reason, workitem_id AS workitemId, want_scope AS scopeWanted, status, created_at AS createdAt FROM tool_requests WHERE owner_id = ? AND status IN ('pending','escalated') ORDER BY created_at DESC LIMIT 10",
                  ).all(cfg.ownerId)
                  return {
                    pending: Number(db.prepare("SELECT COUNT(*) AS n FROM tool_requests WHERE owner_id = ? AND status IN ('pending','escalated')").get(cfg.ownerId).n || 0),
                    items: rows.map((r) => ({ id: r.id, tool: r.tool, reason: r.reason, workitemId: r.workitemId, status: r.status, createdAt: Number(r.createdAt || 0) })),
                  }
                })(),
                httpResults: db.prepare("SELECT * FROM workitems WHERE origin = 'http' AND status IN ('done','failed','blocked') ORDER BY updated_at DESC LIMIT 5").all().map((r) => ({
                  id: r.id,
                  status: r.status,
                  intent: String(r.intent || '').slice(0, 60),
                  result: String(r.result || r.error || '').slice(0, 220),
                  workspace: r.workspace || null,
                  updatedAt: Number(r.updated_at),
                  artifacts: db.prepare('SELECT path FROM artifacts WHERE workitem_id = ?').all(r.id).map((a) => a.path),
                })),
                briefings: db.prepare("SELECT seq, ts, payload FROM events WHERE type = 'briefing.sent' ORDER BY seq DESC LIMIT 3").all().map((r) => {
                  let p = {}
                  try { p = JSON.parse(r.payload) } catch { /* ignore */ }
                  return { seq: r.seq, at: Number(r.ts), kind: p.kind || 'daily', file: p.file || null, text: String(p.text || '').slice(0, 500) }
                }),
                archive: (() => {
                  const row = db.prepare("SELECT payload FROM events WHERE type = 'archive.scanned' ORDER BY seq DESC LIMIT 1").get()
                  if (!row) return null
                  try { return JSON.parse(row.payload) } catch { return null }
                })(),
                briefingEnabled: briefingEnabled(),
                pendingDeliveries: Number(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'delivery.pending' AND ts >= ?").get(Date.now() - 86400000).n || 0),
                costToday,
                costMonth,
                lastError: state.lastError,
              }
            } else if (path === '/lanes') {
              body = { ok: true, lanes: listLanes(db, { ownerId: cfg.ownerId, limit: 50 }) }
            } else if (path === '/board') {
              const laneRef = url.searchParams.get('lane') || ''
              const lane = laneRef ? findLaneRef(db, laneRef) : null
              const kinds = String(url.searchParams.get('kind') || '').split(',').map((s) => s.trim()).filter(Boolean)
              body = {
                ok: true,
                laneId: lane ? lane.id : null,
                posts: listBoard(db, {
                  ownerId: cfg.ownerId,
                  laneId: lane ? lane.id : null,
                  kinds: kinds.length ? kinds : null,
                  limit: Number(url.searchParams.get('limit')) || 50,
                }),
              }
            } else if (path === '/channels') {
              body = { ok: true, policies: listPolicies(db) }
            } else if (path === '/outbox') {
              const channel = url.searchParams.get('channel') || undefined
              const after = Number(url.searchParams.get('after')) || 0
              body = { ok: true, items: outboxList(db, { channel, afterSeq: after }) }
            } else if (path === '/workitems') {
              const status = url.searchParams.get('status') || undefined
              body = { ok: true, items: listWorkItems(db, { status, limit: 100 }) }
            } else if (/^\/workitems\/[^/]+\/trace$/.test(path)) {
              const id = path.split('/')[2]
              const trace = buildWorkitemTrace(db, id)
              body = trace ? { ok: true, ...trace } : { ok: false, error: 'not found' }
            } else {
              return send(res, 404, { ok: false, error: 'not found' })
            }
            return send(res, 200, body)
          } catch (err) {
            return send(res, 500, { ok: false, error: describeError(err) })
          }
        },
      }), 'secretary: /secretary/v1')
      log('HTTP 已挂：/secretary/v1/{status,stats,panel,lanes,workitems,trace,channels,outbox,inbound}')
    } catch (err) {
      log('HTTP 接口注册失败：' + describeError(err))
    }
  })

  // ---------------- 简报定时（默认关闭；app_state 可覆盖开关） ----------------
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        if (!briefingEnabled()) return
        const now = new Date()
        const pad = (n) => String(n).padStart(2, '0')
        const hhmm = pad(now.getHours()) + ':' + pad(now.getMinutes())
        const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
        const dailyAt = (cfg.briefing && cfg.briefing.dailyAt) || '08:30'
        if (hhmm >= dailyAt && appStateGet('briefing.daily.' + today) !== '1') {
          briefingRun('daily')
          appStateSet('briefing.daily.' + today, '1')
          log('已生成每日简报')
        }
        const wd = cfg.briefing && Number.isFinite(Number(cfg.briefing.weeklyDay)) ? Number(cfg.briefing.weeklyDay) : 1
        const weeklyAt = (cfg.briefing && cfg.briefing.weeklyAt) || '09:00'
        if (cfg.briefing && cfg.briefing.weekly !== false && now.getDay() === wd && hhmm >= weeklyAt && appStateGet('briefing.weekly.' + today) !== '1') {
          briefingRun('weekly')
          appStateSet('briefing.weekly.' + today, '1')
          log('已生成每周简报')
        }
        const arch = cfg.archive || {}
        if (arch.enabled && Array.isArray(arch.watchDirs) && arch.watchDirs.length) {
          const hourKey = today + 'T' + pad(now.getHours())
          if (appStateGet('archive.lastHour') !== hourKey) {
            try {
              const cands = scanArchive({ watchDirs: arch.watchDirs, rules: archiveRules(), minAgeHours: arch.minAgeHours ?? 24 })
              appendEvent(db, { type: EVENT_TYPE.ARCHIVE_SCANNED, ownerId: cfg.ownerId, actor: ACTOR.KERNEL, payload: { count: cands.length, allowApply: !!arch.allowApply } })
              appStateSet('archive.lastHour', hourKey)
              if (cands.length) log('归档候选 ' + cands.length + ' 个（' + (arch.allowApply ? '可执行' : '仅提议') + '）')
            } catch (err) { log('归档扫描失败：' + describeError(err)) }
          }
        }
      } catch (err) {
        log('简报定时失败：' + describeError(err))
      }
    }, 60 * 1000)
    return () => clearInterval(timer)
  })

  // ---------------- 看门狗：running 超时 → blocked ----------------
  const timeoutMs = Math.max(60, Number(cfg.workerTimeoutSec) || 900) * 1000
  ctx.effect(() => {
    const timer = setInterval(async () => {
      try {
        const cutoff = Date.now() - timeoutMs
        // 活跃度按「任务最近事件」算，不只看 updated_at：工人一直在调工具/跑命令就不该被判超时。
        const rows = db.prepare(
          `SELECT w.*, COALESCE((SELECT MAX(e.ts) FROM events e WHERE e.workitem_id = w.id), w.updated_at) AS last_active
           FROM workitems w
           WHERE w.status = 'running'
             AND COALESCE((SELECT MAX(e.ts) FROM events e WHERE e.workitem_id = w.id), w.updated_at) < ?`,
        ).all(cutoff)
        for (const row of rows) {
          transition(db, row.id, ITEM_STATUS.BLOCKED, {
            reason: 'worker 超时（超过 ' + Math.round(timeoutMs / 60000) + ' 分钟无进展）',
            payload: { needsHuman: true },
          })
          closeWorkerSessions(row.id)
          const timedOut = getWorkItem(db, row.id)
          await notifyDelivery(timedOut, 'blocked')
          if (timedOut.laneId) laneReleaseAndPump(timedOut.laneId)
          log('任务超时标 blocked：' + row.id)
        }
        // 派单后毫无回音（resume 到死会话的典型症状）：不必等满 15 分钟，按更短的静默窗口判死
        try {
          const silentMs = Math.max(120, Number(cfg.dispatchSilentSec) || 8 * 60) * 1000
          for (const row of findSilentDispatches(db, { silentMs })) {
            const cur = getWorkItem(db, row.id)
            if (!cur || cur.status !== ITEM_STATUS.RUNNING) continue
            transition(db, cur.id, ITEM_STATUS.BLOCKED, {
              reason: '派单后 ' + Math.round(silentMs / 60000) + ' 分钟工人没有任何回音（会话可能已失效）',
              payload: { needsHuman: true },
            })
            closeWorkerSessions(cur.id)
            // 这条线绑定的会话已经不可信：清掉，下次派单直接建新工人
            if (cur.laneId) {
              try { releaseLane(db, cur.laneId, { keepSession: false }) } catch { /* ignore */ }
            }
            const dead = getWorkItem(db, cur.id)
            await notifyDelivery(dead, 'blocked')
            if (dead.laneId) laneReleaseAndPump(dead.laneId)
            log('派单后无回音标 blocked：' + dead.id)
          }
        } catch (err) { log('无回音检测失败：' + describeError(err)) }
        // 任务已结束但工具申请还挂着：自动拒绝，避免永久 pending 无人处理
        try {
          const stale = db.prepare(
            "UPDATE tool_requests SET status = 'denied', decided_by = 'system', decided_at = ? " +
            "WHERE status IN ('pending','escalated') AND workitem_id IN (SELECT id FROM workitems WHERE status IN ('done','failed','cancelled','merged'))",
          ).run(Date.now())
          if (stale.changes) log('自动拒绝终态任务的挂起申请：' + stale.changes + ' 条')
        } catch { /* 清理失败不影响主循环 */ }
        // 旁路审计：工人会话里主人直接说的/批注的内容，补记进账本
        auditWorkerGuidanceLite()
        scanUsageLite()
        scanContinuationArtifacts()
        refreshResources()
        fireDueSchedules()
        // 租约维护：过期清掉；任务终态后释放（1 小时窗口内的终态任务）
        try { expireLeases(db) } catch { /* ignore */ }
        try {
          const recentTerminal = db.prepare(
            "SELECT id FROM workitems WHERE status IN ('done','failed','cancelled') AND updated_at > ?",
          ).all(Date.now() - 3600 * 1000)
          for (const r of recentTerminal) releaseItemLeases(db, r.id)
        } catch { /* ignore */ }
        // 线维护：空闲太久关会话；卡住的线自动释放；空线但有排队就拉起
        try {
          const closed = sweepIdleLanes(db, { ttlMs: Number(cfg.laneIdleTtlMs) || 30 * 60 * 1000 })
          if (closed.length) log('回收空闲线会话：' + closed.length + ' 条')
          for (const l of closed) { if (adoptedHandles.has(l.id)) { void disposeAdoptedHandle(l.id); log('释放已登记会话：' + l.id) } }
          const repaired = repairStuckLanes(db)
          if (repaired) log('修复卡住的线：' + repaired + ' 条')
          const waiting = db.prepare(
            "SELECT DISTINCT lane_id FROM workitems WHERE status = 'queued' AND lane_id IS NOT NULL",
          ).all()
          for (const w of waiting) {
            const lane = getLaneById(db, w.lane_id)
            if (lane && !lane.currentWorkitemId) {
              const next = nextQueuedOnLane(db, w.lane_id)
              if (next) dispatchOrQueue(getWorkItem(db, next.id))
            }
          }
        } catch (err) {
          log('线维护失败：' + describeError(err))
        }
        // 派单没成功（会话建不出来）不能永远 queued：2 分钟没进 running 就标 blocked；
        // 但「等线」的任务不算超时。
        const queued = db.prepare("SELECT * FROM workitems WHERE status = 'queued' AND updated_at < ?")
          .all(Date.now() - 120000)
        for (const row of queued) {
          if (row.lane_id) {
            const lane = getLaneById(db, row.lane_id)
            if (lane && lane.currentWorkitemId) continue
            if (lane) { dispatchOrQueue(getWorkItem(db, row.id)); continue }
          }
          transition(db, row.id, ITEM_STATUS.BLOCKED, {
            reason: '派单超时（2 分钟未进入执行）',
            payload: { needsHuman: true },
          })
          log('任务派单超时标 blocked：' + row.id)
        }
        // 自动重试：blocked、不需要人、重试次数 < 2 的，退避 60s 后重新排队派单
        const retryable = db.prepare(
          "SELECT * FROM workitems WHERE status = 'blocked' AND needs_human = 0 AND attempts < 2 AND updated_at < ?",
        ).all(Date.now() - 60000)
        for (const row of retryable) {
          try {
            transition(db, row.id, ITEM_STATUS.QUEUED, {
              reason: '自动重试（第 ' + (row.attempts + 1) + ' 次）',
              payload: { attempts: row.attempts + 1, needsHuman: false },
            })
            dispatchOrQueue(getWorkItem(db, row.id))
            log('自动重试派单：' + row.id)
          } catch (err) {
            log('自动重试失败 ' + row.id + '：' + describeError(err))
          }
        }
      } catch (err) {
        log('看门狗失败：' + describeError(err))
      }
    }, 30000)
    return () => clearInterval(timer)
  })

  log('内核已加载：db=' + cfg.dbPath + ' ws=' + cfg.workspaceRoot +
    ' relay=' + cfg.relayPreset + ' worker=' + cfg.workerPreset)
}

export { DELIVERY_LEVEL }
