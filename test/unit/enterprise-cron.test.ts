/**
 * The cron arithmetic behind schedule bounds and SCHEDULE_OVERLAP (design §7.2, §8.2; review round 2, LOW 1): five
 * unix-cron fields, a `TZ=`/`CRON_TZ=` prefix, the next runs, and the *minimum* gap. Vertex's `Schedule.cron` documents
 * the prefix (v1 discovery revision 20261107); the time zone data is the host's IANA database through Intl.
 */
import { describe, expect, it } from "vitest"
import { ColabError } from "../../src/domain/errors.js"
import { cronWithZone, minimumGap, nextRuns, occurrencesBetween, parseCron } from "../../src/enterprise/cron.js"

const at = (iso: string) => new Date(iso)

describe("parsing", () => {
  it("reads the five fields with wildcards, ranges, lists, steps and names", () => {
    const cron = parseCron("*/15 9-17 1,15 JAN-JUN MON-FRI")
    expect(cron.minutes).toEqual([0, 15, 30, 45])
    expect(cron.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(cron.daysOfMonth).toEqual([1, 15])
    expect(cron.months).toEqual([1, 2, 3, 4, 5, 6])
    expect(cron.daysOfWeek).toEqual([1, 2, 3, 4, 5])
    expect(cron.timeZone).toBe("UTC")
  })

  it("reads CRON_TZ and TZ prefixes, and treats Sunday as 0 or 7", () => {
    expect(parseCron("CRON_TZ=America/New_York 0 9 * * *").timeZone).toBe("America/New_York")
    expect(parseCron("TZ=Asia/Tokyo 30 8 * * *").timeZone).toBe("Asia/Tokyo")
    expect(parseCron("0 0 * * 7").daysOfWeek).toEqual([0])
    expect(cronWithZone("0 9 * * *", "Europe/London")).toBe("TZ=Europe/London 0 9 * * *")
    expect(cronWithZone("0 9 * * *", undefined)).toBe("0 9 * * *")
  })

  it("refuses a malformed expression, an out-of-range field and a zone the host does not know", () => {
    for (const bad of ["0 9 * *", "61 * * * *", "0 25 * * *", "0 9 * FOO *", "0 9 * * * *"]) {
      expect(() => parseCron(bad), bad).toThrow(ColabError)
      expect(() => parseCron(bad), bad).toThrow(/INPUT_INVALID/)
    }
    expect(() => parseCron("TZ=Mars/Olympus 0 9 * * *")).toThrow(/IANA/)
    expect(() => cronWithZone("0 9 * * *", "Nowhere/Nothing")).toThrow(/IANA/)
  })
})

describe("the next runs", () => {
  it("gives five daily runs in UTC", () => {
    const runs = nextRuns(parseCron("0 9 * * *"), at("2026-11-17T10:00:00Z"), 5)
    expect(runs.map((run) => run.toISOString())).toEqual([
      "2026-11-18T09:00:00.000Z",
      "2026-11-19T09:00:00.000Z",
      "2026-11-20T09:00:00.000Z",
      "2026-11-21T09:00:00.000Z",
      "2026-11-22T09:00:00.000Z",
    ])
  })

  it("reads the zone: 09:00 in New York is 14:00 UTC in November", () => {
    const runs = nextRuns(parseCron("TZ=America/New_York 0 9 * * *"), at("2026-11-17T09:00:00Z"), 2)
    expect(runs.map((run) => run.toISOString())).toEqual(["2026-11-17T14:00:00.000Z", "2026-11-18T14:00:00.000Z"])
  })

  it("skips a local time the spring transition removes, and runs a repeated one once", () => {
    // US DST starts 2027-03-14: 02:30 does not exist in New York that day.
    const spring = nextRuns(parseCron("TZ=America/New_York 30 2 * * *"), at("2027-03-13T12:00:00Z"), 2)
    expect(spring.map((run) => run.toISOString())).toEqual(["2027-03-15T06:30:00.000Z", "2027-03-16T06:30:00.000Z"])
    // US DST ends 2026-11-01: 01:30 happens twice; the first instant is the run.
    const fall = nextRuns(parseCron("TZ=America/New_York 30 1 * * *"), at("2026-10-31T12:00:00Z"), 2)
    expect(fall.map((run) => run.toISOString())).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"])
  })

  it("matches weekdays by name and either day field when both are restricted", () => {
    // 2026-11-17 is a Tuesday; the next weekday 09:00 is Wednesday.
    expect(nextRuns(parseCron("0 9 * * MON-FRI"), at("2026-11-17T10:00:00Z"), 2).map((run) => run.toISOString())).toEqual(["2026-11-18T09:00:00.000Z", "2026-11-19T09:00:00.000Z"])
    // The 1st of a month OR a Monday, whichever comes first after 2026-11-17.
    const either = nextRuns(parseCron("0 0 1 * 1"), at("2026-11-17T00:00:00Z"), 3).map((run) => run.toISOString())
    expect(either[0]).toBe("2026-11-23T00:00:00.000Z") // a Monday
    expect(either).toContain("2026-12-01T00:00:00.000Z") // the 1st
  })
})

describe("the minimum gap", () => {
  it("uses the shortest interval, so 0 9,10 * * * is judged by its hour", () => {
    expect(minimumGap(parseCron("0 9,10 * * *"), at("2026-11-17T00:00:00Z")).gapMs).toBe(60 * 60_000)
    expect(minimumGap(parseCron("*/20 * * * *"), at("2026-11-17T00:00:00Z")).gapMs).toBe(20 * 60_000)
    expect(minimumGap(parseCron("0 9 * * *"), at("2026-11-17T00:00:00Z")).gapMs).toBe(24 * 60 * 60_000)
  })

  it("measures only the bounded run count when the plan gives one", () => {
    // The 1st and 4th: from Nov 2 the two runs a maxRunCount of 2 allows are Nov 4 and Dec 1, 27 days apart.
    expect(minimumGap(parseCron("0 9 1,4 * *"), at("2026-11-02T00:00:00Z"), { runs: 2 }).gapMs).toBe(27 * 24 * 60 * 60_000)
    // A bound of one run cannot overlap with itself, though the cron repeats a day later.
    expect(minimumGap(parseCron("0 9 1,2 * *"), at("2026-11-02T00:00:00Z"), { runs: 1 }).gapMs).toBe(Number.POSITIVE_INFINITY)
    // A single occurrence in the window has no gap to measure.
    expect(minimumGap(parseCron("0 0 1 1 *"), at("2026-11-17T00:00:00Z")).gapMs).toBe(Number.POSITIVE_INFINITY)
  })

  it("counts the runs in a window, for a schedule's monthly worst case", () => {
    const now = at("2026-11-17T00:00:00Z")
    expect(occurrencesBetween(parseCron("0 9 * * *"), now, new Date(now.getTime() + 30 * 86_400_000))).toBe(30)
    expect(occurrencesBetween(parseCron("0 9 * * *"), now, new Date(now.getTime() + 7 * 86_400_000))).toBe(7)
  })
})
