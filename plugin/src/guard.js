// Relay 工具白名单：Relay 只负责传话/建任务/交付，不许自己动手干重活。
// 白名单之外的全局工具（修图、浏览器、IM、打印、KSP…）一律拒绝。
// 注意：秘书工具这里**显式枚举**，不能整段放行 /^secretary_/——
// 否则 Relay 可自批工具申请（decide_tool_request）、收养全权工人（adopt）、清理账本（prune）。
const RELAY_SECRETARY_ALLOW = [
  /^secretary_create_task$/,
  /^secretary_wait$/,
  /^secretary_status$/,
  /^secretary_cancel_task$/,
  /^secretary_recall$/,
  /^secretary_remember$/,
  /^secretary_forget$/,
  /^secretary_persona_get$/,
  /^secretary_persona_set$/,
  /^secretary_briefing$/,
  /^secretary_report$/,
  /^secretary_models$/,
  /^secretary_templates$/,
  /^secretary_tool_requests$/,
  /^secretary_propose_group$/,
  /^secretary_split_merged$/,
  /^secretary_stats$/,
]

const RELAY_ALLOW = [
  ...RELAY_SECRETARY_ALLOW,
  /^present$/,
  /^bagu_guard$/,
  /^bagu_meme$/,
  /^ask_user_question$/,
  /^todo_write$/,
  /^skill$/,
  /^get_goal$/,
  /^create_goal$/,
  /^update_goal$/,
  /^wait_agent$/,
  /^list_agents$/,
  /^send_message$/, // 只允许给子 agent 发消息？先允许，后续按需收紧
]

export function relayToolAllowed(name) {
  const n = String(name || '')
  return RELAY_ALLOW.some((re) => re.test(n))
}

export function relayDenialMessage(name) {
  return 'Relay 只负责传话：' + name + ' 不该由你调用。请用 secretary_create_task 交给任务层去做。'
}

/** 合法的工作器权限档（Worker 会话用）。 */
export const WORKER_PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access', 'auto-review']

export function normalizeWorkerPermission(value, fallback) {
  const v = String(value || '').trim()
  if (WORKER_PERMISSIONS.includes(v)) return v
  const f = String(fallback || '').trim()
  if (WORKER_PERMISSIONS.includes(f)) return f
  return 'workspace-write'
}

// Worker 工具允许名单：工人只该用「干活」类工具；浏览器逃生口、IM、打印、插件管理等一律挡掉。
const WORKER_ALLOW = [
  /^secretary_work_/, // work_finish / work_fail
  /^secretary_wait$/,
  /^secretary_status$/,
  /^secretary_request_tool$/,
  /^secretary_tool_request_status$/,
  /^read$/, /^write$/, /^edit$/, /^glob$/, /^grep$/,
  /^pwsh$/, /^bash$/,
  /^read_image$/,
  /^web_search$/, /^web_fetch$/,
  /^skill$/, /^todo_write$/,
  /^job_(list|output|kill)$/,
  /^(generate_image|generate_images|edit_image|view_canvas|canvas_state)$/,
  /^load_workspace_dependencies$/,
  /^(univer_|office_)/,
  /^transcribe_audio$/, /^speak_text$/,
]

export function workerToolAllowed(name) {
  const n = String(name || '')
  return WORKER_ALLOW.some((re) => re.test(n))
}

export function workerDenialMessage(name) {
  return '工人不该用这个工具：' + name + '（不在允许名单里）。用文件/终端/搜索类工具完成任务；做不了就调 secretary_work_fail 说明原因。'
}