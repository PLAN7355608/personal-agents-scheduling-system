// 5 段 cron（分 时 日 月 周）+ IANA 时区 → 下一次触发时间（UTC epoch ms）。
// 只做一件事：把「每日 20:00」这类表达式换算成 next_run_at；调度状态与幂等都在表里。
// 语义约定（与 systemd/Quartz 对齐，测试锁住）：
//   - 5 段：分 时 日 月 周；周日=0；
//   - 日与周同时给定时按 OR 处理（cron 传统语义）；
//   - DST：跳过不存在的本地时间；重复的本地时间只取第一次（localToUtc 取较早解）。
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 6 },
]

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周（收到 ' + parts.length + ' 段）')
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]))
  const hasDay = parts[2] !== '*'
  const hasWeekday = parts[4] !== '*'
  return {
    expr: parts.join(' '),
    minutes: sets[0],
    hours: sets[1],
    days: sets[2],
    months: sets[3],
    weekdays: sets[4],
    dayOrWeekday: hasDay && hasWeekday,
  }
}

function parseField(text, spec) {
  const out = new Set()
  for (const piece of String(text).split(',')) {
    const [rangePart, stepPart] = piece.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) throw new Error(spec.name + ' 步长不合法：' + piece)
    let lo
    let hi
    if (rangePart === '*') {
      lo = spec.min
      hi = spec.max
    } else if (String(rangePart).includes('-')) {
      const [a, b] = String(rangePart).split('-')
      lo = Number(a)
      hi = Number(b)
    } else {
      lo = Number(rangePart)
      hi = stepPart === undefined ? lo : spec.max
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < spec.min || hi > spec.max || lo > hi) {
      throw new Error(spec.name + ' 范围不合法：' + piece + '（允许 ' + spec.min + '-' + spec.max + '）')
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  if (!out.size) throw new Error(spec.name + ' 字段为空：' + text)
  return [...out].sort((a, b) => a - b)
}

const fmtCache = new Map()
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      weekday: 'short',
    }))
  }
  return fmtCache.get(tz)
}

export function assertTimeZone(tz) {
  try {
    formatter(tz).format(new Date())
  } catch {
    throw new Error('时区不合法：' + tz + '（要 IANA 名，如 Asia/Shanghai）')
  }
  return tz
}

/** 本地时间各分量（用于 cron 匹配与 DST 判定）。 */
export function localParts(ms, tz) {
  const parts = formatter(tz).formatToParts(new Date(ms))
  const get = (type) => {
    const p = parts.find((x) => x.type === type)
    return p ? p.value : ''
  }
  const weekday = WEEKDAYS.indexOf(get('weekday'))
  const hourText = get('hour') === '24' ? '00' : get('hour')
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    H: Number(hourText),
    M: Number(get('minute')),
    S: Number(get('second')),
    weekday: weekday >= 0 ? weekday : 0,
  }
}

/** 本地时间 → UTC ms：迭代两次抵消时区偏移；不存在的本地时间会得到「漂移后」的结果，由调用方比对过滤。 */
export function localToUtc({ y, m, d, H = 0, M = 0 }, tz) {
  let guess = Date.UTC(y, m - 1, d, H, M)
  for (let i = 0; i < 3; i += 1) {
    const p = localParts(guess, tz)
    const drift = Date.UTC(y, m - 1, d, H, M) - Date.UTC(p.y, p.m - 1, p.d, p.H, p.M)
    if (drift === 0) break
    guess += drift
  }
  return guess
}

function addDays(y, m, d, offset) {
  const dt = new Date(Date.UTC(y, m - 1, d + offset))
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

/** 下一次触发（严格大于 from）。找不到（400 天内）抛错，由调用方把该计划禁用。 */
export function nextCronAt({ cron, expr = null, tz = 'UTC', from = Date.now() } = {}) {
  const spec = typeof cron === 'string' ? parseCron(cron) : cron || parseCron(expr)
  assertTimeZone(tz)
  const start = localParts(from, tz)
  for (let offset = 0; offset <= 400; offset += 1) {
    const day = addDays(start.y, start.m, start.d, offset)
    if (!spec.months.includes(day.m)) continue
    const weekday = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay()
    const dayOk = spec.days.includes(day.d)
    const weekdayOk = spec.weekdays.includes(weekday)
    const match = spec.dayOrWeekday ? dayOk || weekdayOk : dayOk && weekdayOk
    if (!match) continue
    for (const H of spec.hours) {
      for (const M of spec.minutes) {
        const t = localToUtc({ y: day.y, m: day.m, d: day.d, H, M }, tz)
        const p = localParts(t, tz)
        // DST 跳过的本地时间：换算回来对不上就跳过这一格
        if (p.y !== day.y || p.m !== day.m || p.d !== day.d || p.H !== H || p.M !== M) continue
        if (t > from) return t
      }
    }
  }
  throw new Error('400 天内找不到下一次触发：' + spec.expr + ' (' + tz + ')')
}

/** 人话描述，给面板/日报用。 */
export function describeCron(expr) {
  const spec = parseCron(expr)
  const pad = (n) => String(n).padStart(2, '0')
  const p = spec.expr.split(' ')
  const time = spec.minutes.length === 1 && spec.hours.length === 1
    ? pad(spec.hours[0]) + ':' + pad(spec.minutes[0])
    : pad(spec.hours[0] || 0) + ':' + pad(spec.minutes[0] || 0) + '（多时刻）'
  if (p[0].startsWith('*/') && p[1] === '*' && p[2] === '*' && p[3] === '*' && p[4] === '*') {
    return '每 ' + p[0].slice(2) + ' 分钟'
  }
  if (p[1] === '*' && p[2] === '*' && p[3] === '*' && p[4] === '*') return '每小时 ' + pad(spec.minutes[0] || 0) + ' 分'
  if (p[2] === '*' && p[3] === '*' && p[4] === '*') return '每天 ' + time
  if (p[2] === '*' && p[3] === '*') {
    const names = spec.weekdays.map((w) => WEEKDAYS[w]).join('、')
    return '每周 ' + names + ' ' + time
  }
  return '按表达式 ' + spec.expr
}
