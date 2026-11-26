// 常量与契约：状态、事件、交付等级、schema 版本。
// 所有"魔法字符串"只允许在这里出现，别的模块一律 import。

export const SCHEMA_VERSION = 18;

/** 多用户缝：v0 恒为 'owner'，但代码里不许出现单用户隐含假设 */
export const OWNER_DEFAULT = 'owner';

export const ITEM_STATUS = Object.freeze({
  INTAKE: 'intake',
  TRIAGED: 'triaged',
  QUEUED: 'queued',
  RUNNING: 'running',
  BLOCKED: 'blocked',
  WAITING_HUMAN: 'waiting_human',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  MERGED: 'merged',
});

export const TERMINAL_STATUS = Object.freeze([
  ITEM_STATUS.DONE,
  ITEM_STATUS.FAILED,
  ITEM_STATUS.CANCELLED,
  ITEM_STATUS.MERGED,
]);

/**
 * 合法状态转移。未列出的目标一律非法——状态机是唯一允许改状态的地方。
 * done 只能经 finish() 进入（见 workitems.finish）。
 */
export const TRANSITIONS = Object.freeze({
  [ITEM_STATUS.INTAKE]: [ITEM_STATUS.TRIAGED, ITEM_STATUS.CANCELLED, ITEM_STATUS.MERGED],
  [ITEM_STATUS.TRIAGED]: [ITEM_STATUS.QUEUED, ITEM_STATUS.WAITING_HUMAN, ITEM_STATUS.CANCELLED, ITEM_STATUS.MERGED],
  [ITEM_STATUS.QUEUED]: [ITEM_STATUS.RUNNING, ITEM_STATUS.BLOCKED, ITEM_STATUS.WAITING_HUMAN, ITEM_STATUS.CANCELLED, ITEM_STATUS.MERGED],
  [ITEM_STATUS.RUNNING]: [
    ITEM_STATUS.DONE,
    ITEM_STATUS.FAILED,
    ITEM_STATUS.BLOCKED,
    ITEM_STATUS.CANCELLED,
  ],
  [ITEM_STATUS.BLOCKED]: [
    ITEM_STATUS.QUEUED,
    ITEM_STATUS.FAILED,
    ITEM_STATUS.WAITING_HUMAN,
    ITEM_STATUS.CANCELLED,
  ],
  [ITEM_STATUS.WAITING_HUMAN]: [ITEM_STATUS.QUEUED, ITEM_STATUS.CANCELLED, ITEM_STATUS.MERGED],
  [ITEM_STATUS.DONE]: [],
  [ITEM_STATUS.FAILED]: [],
  [ITEM_STATUS.CANCELLED]: [],
  [ITEM_STATUS.MERGED]: [],
});

/** 事件类型白名单（v0）。只许新增，不许改语义；每条事件带 schemaVersion。 */
export const EVENT_TYPE = Object.freeze({
  MSG_RECEIVED: 'msg.received',
  MSG_SENT: 'msg.sent',
  ASSESS_DECIDED: 'assess.decided',
  JUDGE_CALLED: 'judge.called',
  ITEM_CREATED: 'item.created',
  ITEM_STATE: 'item.state',
  ITEM_FINISHED: 'item.finished',
  ITEM_METRICS: 'item.metrics',
  MEMORY_REMEMBER: 'memory.remember',
  MEMORY_FORGET: 'memory.forget',
  FILE_DELETED: 'file.deleted',
  LANE_ROUTED: 'lane.routed',
  BRIEFING_SENT: 'briefing.sent',
  ARCHIVE_SCANNED: 'archive.scanned',
  WORKITEM_PRUNED: 'workitem.pruned',
  DELIVERY_PENDING: 'delivery.pending',
  NOTIFY_SENT: 'notify.sent',
  NOTIFY_FAILED: 'notify.failed',
  ITEM_MERGED: 'item.merged',
  ITEM_SPLIT: 'item.split',
  WORKER_TOOL: 'worker.tool',
  WORKER_TOOL_START: 'worker.tool.start',
  WORKER_USER_MESSAGE: 'worker.user_message',
  WORKER_CONTINUATION: 'worker.continuation',
  ITEM_REOPENED: 'item.reopened',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_ANSWERED: 'approval.answered',
  DELIVERY_DECIDED: 'delivery.decided',
  MEMORY_WRITTEN: 'memory.written',
  MEMORY_SUPERSEDED: 'memory.superseded',
  SESSION_BOUND: 'session.bound',
  SESSION_ROTATED: 'session.rotated',
  SESSION_ERROR: 'session.error',
  CHANNEL_HEALTH: 'channel.health',
  BUDGET_CONSUMED: 'budget.consumed',
  KERNEL_STARTED: 'kernel.started',
  DIVISION_PROPOSED: 'division.proposed',
  DIVISION_ACCEPTED: 'division.accepted',
  DIVISION_REJECTED: 'division.rejected',
  ERROR: 'error',
});

export const EVENT_TYPES = Object.freeze(Object.values(EVENT_TYPE));

export const DELIVERY_LEVEL = Object.freeze({
  SILENT: 'L0',
  PANEL: 'L1',
  REPLY: 'L2',
  PUSH: 'L3',
});

export const ACTOR = Object.freeze({
  OWNER: 'owner',
  KERNEL: 'kernel',
  RELAY: 'relay',
  WORKER: 'worker',
  SYSTEM: 'system',
});
