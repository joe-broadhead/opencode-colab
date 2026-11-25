/**
 * The cron arithmetic the schedule plans need (design §7.2, §8.2): the next five run times, and the *minimum* gap
 * between consecutive occurrences, which `SCHEDULE_OVERLAP` compares with `executionTimeout` +
 * `provisioningMarginMinutes` — a cron such as `0 9,10 * * *` is judged by its shortest gap, not its daily one.
 *
 * Google's `Schedule.cron` is a unix-cron expression with an optional `CRON_TZ=<IANA zone>` or `TZ=<IANA zone>` prefix
 * and UTC when the prefix is absent (Vertex AI API v1 discovery revision 20261107, `GoogleCloudAiplatformV1Schedule.cron`:
 * "apply a prefix in the cron tab: `CRON_TZ=${IANA_TIME_ZONE}` or `TZ=${IANA_TIME_ZONE}` … For example,
 * `CRON_TZ=America/New_York 1 * * * *`" — https://aiplatform.googleapis.com/$discovery/rest?version=v1 ; the schedule
 * run guide shows `TZ=America/Los_Angeles * * * * *` — https://docs.cloud.google.com/colab/docs/schedule-notebook-run).
 *
 * Five fields, minute hour day-of-month month day-of-week; `*`, numbers, ranges, lists and steps, three-letter month and
 * weekday names, and 0 or 7 for Sunday. Day of month and day of week follow unix cron: when both are restricted, a day
 * matches if either does. Nothing here is a Google call.
 *
 * Time zones come from the host's IANA database through `Intl.DateTimeFormat`, so a local time that does not exist
 * (spring forward) is skipped and one that happens twice (fall back) runs once, at its first instant.
 */
import { ColabError } from "../../domain/errors.js"

export interface Cron {
  readonly expression: string
  readonly timeZone: string
  readonly minutes: readonly number[]
  readonly hours: readonly number[]
  readonly daysOfMonth: readonly number[] | undefined
  readonly months: readonly number[] | undefined
  readonly daysOfWeek: readonly number[] | undefined
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const
const HORIZON_DAYS = 400

const all = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, index) => min + index)

const invalid = (detail: string) =>
  new ColabError("INPUT_INVALID", `The cron expression is not valid: ${detail}.`, { next: 'Use five unix-cron fields, such as "0 9 * * 1-5", with an optional "CRON_TZ=<IANA zone>" prefix.' })

/** `["1-5/2", "7"]` → numbers, or undefined when the field is a bare wildcard. */
function parseField(field: string, min: number, max: number, names?: readonly string[], alias?: (value: number) => number): readonly number[] | undefined {
  if (field === "*") return undefined
  const values = new Set<number>()
  for (const part of field.split(",")) {
    const match = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!match) throw invalid(`"${part}" in "${field}" is not a number, range, list or step`)
    const step = match[3] === undefined ? 1 : Number(match[3])
    if (step < 1) throw invalid(`the step in "${part}" is not positive`)
    const first = match[1] === undefined ? min : Number(match[1])
    const last = match[2] === undefined ? (match[1] === undefined ? max : first) : Number(match[2])
    if (first < min || last > max || first > last) throw invalid(`"${part}" is outside ${min}-${max}`)
    for (let value = first; value <= last; value += step) values.add(alias ? alias(value) : value)
  }
  if (values.size === 0) throw invalid(`"${field}" selects nothing`)
  return [...values].sort((a, b) => a - b)
}

function named(field: string, names: readonly string[], offset: number): string {
  return field.replace(/[A-Za-z]{3}/g, (token) => {
    const index = names.indexOf(token.toUpperCase() as never)
    if (index === -1) throw invalid(`"${token}" is not a month or weekday name`)
    return String(index + offset)
  })
}

function zoneOf(text: string): { readonly zone: string; readonly rest: string } {
  const match = /^(?:CRON_TZ|TZ)=([^\s]+)\s+(.+)$/.exec(text.trim())
  if (!match) return { zone: "UTC", rest: text.trim() }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: match[1] }).format(0)
  } catch {
    throw invalid(`"${match[1]}" is not an IANA time zone`)
  }
  return { zone: match[1]!, rest: match[2]!.trim() }
}

export function parseCron(text: string): Cron {
  const { zone, rest } = zoneOf(text)
  const fields = rest.split(/\s+/)
  if (fields.length !== 5) throw invalid(`expected 5 fields, found ${fields.length}`)
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  return {
    expression: rest,
    timeZone: zone,
    minutes: parseField(minute, 0, 59) ?? all(0, 59),
    hours: parseField(hour, 0, 23) ?? all(0, 23),
    daysOfMonth: parseField(dayOfMonth, 1, 31),
    months: parseField(named(month, MONTHS, 1), 1, 12),
    // 0 and 7 are both Sunday in unix cron; the API's own examples use names too.
    daysOfWeek: parseField(named(dayOfWeek, WEEKDAYS, 0), 0, 7, WEEKDAYS, (value) => (value === 7 ? 0 : value)),
  }
}

/** `TZ=America/New_York 0 9 * * *` for a cron and its zone, or the expression alone for UTC. */
export function cronWithZone(expression: string, timeZone: string | undefined): string {
  const parsed = parseCron(expression)
  const zone = timeZone ?? parsed.timeZone
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0)
  } catch {
    throw invalid(`"${zone}" is not an IANA time zone`)
  }
  return zone === "UTC" ? parsed.expression : `TZ=${zone} ${parsed.expression}`
}

// ── Local time ↔ UTC, through the host's IANA data ──────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(zone: string): Intl.DateTimeFormat {
  const existing = formatters.get(zone)
  if (existing) return existing
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  })
  formatters.set(zone, created)
  return created
}

interface Wall {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
}

function wallIn(zone: string, date: Date): Wall & { readonly weekday: number } {
  const parts = formatter(zone).formatToParts(date)
  const value = (type: string) => parts.find((part) => part.type === type)?.value
  const weekday = WEEKDAYS.indexOf((value("weekday") ?? "Sun").toUpperCase().slice(0, 3) as never)
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
    weekday: weekday === -1 ? 0 : weekday,
  }
}

/** The offset at an instant, cached per hour: `wall clock as if UTC` minus the instant. */
const offsets = new Map<string, number>()
function offsetAt(zone:string, utcMs: number): number {
  const key = `${zone}:${Math.floor(utcMs / 3_600_000)}`
  const cached = offsets.get(key)
  if (cached !== undefined) return cached
  const wall = wallIn(zone, new Date(utcMs))
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0)
  const offset = asUtc - (utcMs - (utcMs % 60_000))
  offsets.set(key, offset)
  return offset
}

const sameWall = (left: Wall, right: Wall) => left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour && left.minute === right.minute

/** Every UTC instant whose local wall clock is `wall`: none for a spring-forward gap, two in a fall-back fold. */
function zonedToUtcAll(zone: string, wall: Wall): number[] {
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0)
  const candidates = new Set<number>()
  for (const probe of [asIfUtc - 26 * 3_600_000, asIfUtc, asIfUtc + 26 * 3_600_000]) candidates.add(asIfUtc - offsetAt(zone, probe))
  return [...candidates].filter((utc) => sameWall(wallIn(zone, new Date(utc)), wall)).sort((a, b) => a - b)
}

/** The first UTC instant whose local wall clock is `wall`, or undefined when that local time does not exist. */
function zonedToUtc(zone: string, wall: Wall): number | undefined {
  return zonedToUtcAll(zone, wall)[0]
}

// ── Occurrences ─────────────────────────────────────────────────────────

function matchesDay(cron: Cron, wall: Wall & { readonly weekday: number }): boolean {
  if (cron.months && !cron.months.includes(wall.month)) return false
  const dayOfMonth = cron.daysOfMonth?.includes(wall.day) ?? false
  const dayOfWeek = cron.daysOfWeek?.includes(wall.weekday) ?? false
  if (cron.daysOfMonth && cron.daysOfWeek) return dayOfMonth || dayOfWeek
  if (cron.daysOfMonth) return dayOfMonth
  if (cron.daysOfWeek) return dayOfWeek
  return true
}

const dayStart = (ms: number) => Math.floor(ms / 86_400_000) * 86_400_000

/**
 * The occurrences strictly after `after`, oldest first, at most `count`, and never more than 400 days ahead. A cron
 * that fires less often than that returns fewer (or none); callers report what they have.
 */
export function nextRuns(cron: Cron, after: Date, count: number): Date[] {
  if (count <= 0) return []
  const afterMs = after.getTime()
  const horizon = afterMs + HORIZON_DAYS * 86_400_000
  const zone = cron.timeZone
  const startWall = wallIn(zone, new Date(afterMs))
  let day = dayStart(Date.UTC(startWall.year, startWall.month - 1, startWall.day))
  const runs: Date[] = []
  for (let index = 0; index <= HORIZON_DAYS; index += 1, day += 86_400_000) {
    const date = new Date(day)
    const dayWall = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: 0, minute: 0, weekday: 0 }
    // The weekday of the local day, read at local noon (a DST transition can move local midnight).
    const noon = wallIn(zone, new Date(day + 12 * 3_600_000))
    if (!matchesDay(cron, { ...dayWall, weekday: noon.weekday })) continue
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const utc = zonedToUtc(zone, { year: dayWall.year, month: dayWall.month, day: dayWall.day, hour, minute })
        if (utc === undefined || utc <= afterMs || utc > horizon) continue
        runs.push(new Date(utc))
        if (runs.length >= count) return runs
      }
    }
  }
  return runs
}

/**
 * Every instant a schedule could fire, with both fold instants of a repeated local time: the conservative reading until
 * L10 records which one Google fires (review LOW 7). Spring-forward gaps stay skipped.
 */
function allInstants(cron: Cron, afterMs: number, horizonDays: number, limit: number): number[] {
  const zone = cron.timeZone
  const horizon = afterMs + horizonDays * 86_400_000
  const startWall = wallIn(zone, new Date(afterMs))
  let day = dayStart(Date.UTC(startWall.year, startWall.month - 1, startWall.day))
  const found: number[] = []
  for (let index = 0; index <= horizonDays; index += 1, day += 86_400_000) {
    const date = new Date(day)
    const noon = wallIn(zone, new Date(day + 12 * 3_600_000))
    const dayWall = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: 0, minute: 0, weekday: noon.weekday }
    if (!matchesDay(cron, dayWall)) continue
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        for (const utc of zonedToUtcAll(zone, { year: dayWall.year, month: dayWall.month, day: dayWall.day, hour, minute })) {
          if (utc <= afterMs || utc > horizon) continue
          found.push(utc)
          if (found.length >= limit) return found.sort((a, b) => a - b)
        }
      }
    }
  }
  return found.sort((a, b) => a - b)
}

/**
 * The shortest gap between consecutive occurrences, measured over `runs` occurrences when a bound gives one, or over
 * a year otherwise (review round 2, LOW 1). `Infinity` when the cron has fewer than two occurrences in the window.
 * Both fold instants count (review LOW 7), so a repeated local time is judged as the 1 h pair it may be.
 */
export function minimumGap(cron: Cron, after: Date, input: { readonly runs?: number; readonly horizonDays?: number } = {}): { readonly gapMs: number; readonly occurrences: number } {
  const count = Math.min(Math.max(input.runs ?? 366, 1), 1000)
  const horizonDays = Math.min(Math.max(input.horizonDays ?? 366, 1), HORIZON_DAYS)
  const instants = allInstants(cron, after.getTime(), horizonDays, count)
  let gapMs = Number.POSITIVE_INFINITY
  for (let index = 1; index < instants.length; index += 1) gapMs = Math.min(gapMs, instants[index]! - instants[index - 1]!)
  return { gapMs, occurrences: instants.length }
}

/** How many occurrences fall in `[after, until]`, at most `cap`; used for a schedule's worst-case monthly cost. */
export function occurrencesBetween(cron: Cron, after: Date, until: Date, cap = 1000): number {
  const occurrences = nextRuns(cron, after, cap)
  return occurrences.filter((date) => date.getTime() <= until.getTime()).length
}
