// 宿主机资源探测与并发准入：只做判断，不碰进程。
// 原则：内存是硬闸门（不够会打死机器），CPU 是软上限（不够只是慢）；
// 升并发要滞回确认，降并发立即生效。
import { cpus, freemem, totalmem, availableParallelism, loadavg } from 'node:os'

const MB = 1024 * 1024

export function defaultCfg() {
  return {
    maxConcurrentWorkers: 4,
    reserveMB: 512,
    peakMB: 700,
    cpuFactor: 0.6,
    confirmRounds: 3,
    batteryPenalty: 1,
  }
}

function mb(n) {
  return Math.max(0, Math.round(Number(n || 0) / MB))
}

/** 启动时采一次设备情况（不轮询）。execCommand 可选：用来补 GPU（nvidia-smi，500ms 超时）。 */
export async function probeHardware({ execCommand = null, platform = process.platform } = {}) {
  const cores = typeof availableParallelism === 'function' ? availableParallelism() : Math.max(1, cpus().length)
  const totalMB = mb(totalmem())
  const freeMB = mb(freemem())
  const info = {
    platform,
    cores,
    totalMB,
    freeMB,
    usedPct: totalMB ? Math.round(((totalMB - freeMB) / totalMB) * 100) : 0,
    cpuModel: (cpus()[0] && cpus()[0].model) || 'unknown',
    loadavg: typeof loadavg === 'function' ? loadavg() : [0, 0, 0],
    gpu: null,
    gpuProbe: 'skipped',
  }
  if (typeof execCommand === 'function') {
    try {
      const out = await execCommand(
        'nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits',
        { timeoutMs: 500 },
      )
      const line = String(out || '').split('\n').map((s) => s.trim()).filter(Boolean)[0]
      if (line) {
        const [name, total, used, util] = line.split(',').map((s) => s.trim())
        info.gpu = { name, totalMB: Number(total) || null, usedMB: Number(used) || null, utilPct: Number(util) || 0 }
        info.gpuProbe = 'ok'
      } else {
        info.gpuProbe = 'empty'
      }
    } catch {
      info.gpuProbe = 'unavailable'
    }
  }
  return info
}

/** 当前视角的资源占用（30s 心跳采一次）。 */
export function sampleUsage({ platform = process.platform, battery = null } = {}) {
  const totalMB = mb(totalmem())
  const freeMB = mb(freemem())
  const cores = typeof availableParallelism === 'function' ? availableParallelism() : Math.max(1, cpus().length)
  const la = typeof loadavg === 'function' ? loadavg() : [0, 0, 0]
  return {
    at: Date.now(),
    totalMB,
    freeMB,
    availMB: freeMB,
    // Windows 上 loadavg 恒为 0：用 1 分钟负载只在 Linux/macOS 上有意义
    load1: Number(la[0] || 0),
    loadKnown: platform !== 'win32',
    cores,
    battery,
  }
}

/** 过载判定：任意两项成立算过载（避免单指标抖动误报）。 */
export function isOverloaded(sample, cfg = defaultCfg()) {
  const c = { ...defaultCfg(), ...cfg }
  const hits = []
  if (sample.availMB < Math.max(c.reserveMB, sample.totalMB * 0.1)) hits.push('内存可用低位')
  if (sample.loadKnown && sample.load1 > sample.cores * 1.5) hits.push('负载高位')
  if (sample.battery && sample.battery.isCharging === false) hits.push('电池供电')
  return { overloaded: hits.length >= 2, hits }
}

/** 按 CPU 与内存分别算出允许并发，取小者。 */
export function planConcurrency({ hardware, sample = null, running = 0, cfg = defaultCfg() } = {}) {
  const c = { ...defaultCfg(), ...cfg }
  const cores = Math.max(1, Number(hardware && hardware.cores) || 1)
  const totalMB = Number((hardware && hardware.totalMB) || (sample && sample.totalMB) || 0)
  const freeMB = Number((sample && sample.availMB) || (hardware && hardware.freeMB) || 0)
  const peakMB = Math.max(128, Number(c.peakMB) || 700)
  const reserveMB = Math.max(128, Number(c.reserveMB) || 512)

  const byCpu = Math.max(1, Math.floor(cores * (Number(c.cpuFactor) || 0.6)))
  const usableMB = Math.max(0, freeMB - reserveMB)
  const byMem = Math.max(1, Math.floor(usableMB / peakMB))
  const hardCap = Math.max(1, Number(c.maxConcurrentWorkers) || 4)
  let desired = Math.max(1, Math.min(byCpu, byMem, hardCap))
  if (totalMB && totalMB < 4096) desired = 1 // 4G 以下一律单并发（实测结论）
  if (sample && sample.battery && sample.battery.isCharging === false) {
    desired = Math.max(1, desired - (Number(c.batteryPenalty) || 1))
  }
  return {
    desired,
    running,
    byCpu,
    byMem,
    hardCap,
    peakMB,
    reserveMB,
    usableMB,
    reason: 'cpu≤' + byCpu + ' / mem≤' + byMem + ' / cap ' + hardCap + ' → ' + desired,
  }
}

/**
 * 滞回：降并发立即生效；升并发要连续 confirmRounds 次都想要更高才生效。
 * streak 由调用方持久化（内存里一个数字即可）。
 */
export function applyHysteresis({ current, desired, streak = 0, confirmRounds = 3 } = {}) {
  const cur = Math.max(1, Number(current) || 1)
  const want = Math.max(1, Number(desired) || 1)
  if (want < cur) return { next: want, streak: 0, changed: want !== cur }
  if (want === cur) return { next: cur, streak: 0, changed: false }
  const s = Number(streak) + 1
  if (s >= Math.max(1, Number(confirmRounds) || 3)) return { next: want, streak: 0, changed: true }
  return { next: cur, streak: s, changed: false }
}

/** 派单准入：当前在飞 + 1 是否还放得下。 */
export function decideAdmission({ plan, running = 0 } = {}) {
  const allowed = Number(running) < Number(plan && plan.desired ? plan.desired : 1)
  return {
    allow: allowed,
    reason: allowed
      ? '在飞 ' + running + ' < 上限 ' + (plan && plan.desired)
      : '并发已满（在飞 ' + running + ' / 上限 ' + (plan && plan.desired) + '）：' + ((plan && plan.reason) || ''),
  }
}
