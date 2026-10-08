import { describe, expect, it } from "vitest";
import {
  clockShares,
  dayNumber,
  holidayName,
  hourOfWeek,
  localToUtc,
  tsOfHour,
  weekShare,
  kindAt,
  meridianReadout,
  mondayOf,
  sectorsOfWeek,
  typicalWeekSectors,
  weekSectors,
} from "../lib/planisphere/sessions";
import type { Sector, SectorKind } from "../lib/planisphere/types";

/* New York hour of the week straight from the platform's tz database, as an independent reference */
function intlHour(ts: number) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(ts * 1000));
  const g = (k: string) => p.find((x) => x.type === k)!.value;
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(g("weekday")) * 24 + +g("hour") + +g("minute") / 60 + +g("second") / 3600;
}

/* the generic week of the original wheel design: fixed hours, no holidays */
function plainSession(h: number): SectorKind {
  const d = Math.floor(h / 24);
  const t = h % 24;
  if ((d === 4 && t >= 20) || d === 5 || (d === 6 && t < 20)) return "weekend";
  if (d < 5 && t >= 9.5 && t < 16) return "regular";
  if (d < 5 && t >= 4 && t < 9.5) return "pre";
  if (d < 5 && t >= 16 && t < 20) return "post";
  return "overnight";
}

const runs = (sectors: Sector[], kind: SectorKind) => sectors.filter((s) => s.kind === kind).map((s) => [s.h0, s.h1]);

function expectContiguousWeek(sectors: Sector[]) {
  expect(sectors[0]!.h0).toBe(0);
  expect(sectors[sectors.length - 1]!.h1).toBe(168);
  for (let i = 1; i < sectors.length; i++) {
    expect(sectors[i]!.h0).toBe(sectors[i - 1]!.h1);
    expect(sectors[i]!.kind).not.toBe(sectors[i - 1]!.kind);
  }
}

describe("hour of the week from the @ballast/risk calendar", () => {
  it("reads the New York clock across the autumn DST change", () => {
    expect(hourOfWeek(1793021400)).toBe(9.5); // Mon 26 Oct 2026 09:30 EDT
    expect(hourOfWeek(1793629800)).toBe(9.5); // Mon 2 Nov 2026 09:30 EST
    expect(hourOfWeek(1793511000)).toBe(6 * 24 + 1.5); // Sun 1 Nov 01:30 EDT
    expect(hourOfWeek(1793514600)).toBe(6 * 24 + 1.5); // the repeated 01:30, now EST
  });

  it("skips the missing hour in spring", () => {
    expect(hourOfWeek(1805007540)).toBeCloseTo(6 * 24 + 1 + 59 / 60, 9); // Sun 14 Mar 2027 01:59 EST
    expect(hourOfWeek(1805007600)).toBe(6 * 24 + 3); // one minute later it is 03:00 EDT
  });

  it("agrees with the tz database every 7h13m through 2026 and 2027", () => {
    for (let ts = 1767243600; ts < 1830315600; ts += 7 * 3600 + 13 * 60) expect(hourOfWeek(ts)).toBeCloseTo(intlHour(ts), 9);
  });

  it("falls back to the tz database outside the calendar's range", () => {
    expect(hourOfWeek(1909143000)).toBeCloseTo(intlHour(1909143000), 9); // 1 Jul 2030
    expect(hourOfWeek(1909143000)).toBe(9.5);
  });
});

describe("session sectors", () => {
  it("a plain week matches the plain session rule, quarter hour by quarter hour", () => {
    const sectors = typicalWeekSectors();
    expectContiguousWeek(sectors);
    for (let q = 0; q < 672; q++) expect(kindAt(sectors, q / 4 + 0.01)).toBe(plainSession(q / 4 + 0.01));
    expect(runs(sectors, "regular")).toEqual([0, 1, 2, 3, 4].map((d) => [d * 24 + 9.5, d * 24 + 16]));
    expect(runs(sectors, "weekend")).toEqual([[116, 164]]);
    expect(runs(sectors, "overnight")[0]).toEqual([0, 4]);
    expect(runs(sectors, "overnight").at(-1)).toEqual([164, 168]);
  });

  it("weeks around a DST change keep the sessions on New York hours", () => {
    const plain = typicalWeekSectors();
    for (const ts of [
      1793021400, // week ending Sun 1 Nov 2026 (fall back)
      1793629800, // first week on EST
      1773072000, // Mon 9 Mar 2026, first week on EDT
      1805007600, // Sun 14 Mar 2027 (spring forward), its week starts Mon 8 Mar
    ]) {
      const w = weekSectors(ts);
      expect(w.source).toBe("calendar");
      expect(w.sectors).toEqual(plain);
    }
  });

  it("Thanksgiving: closed from Wednesday 20:00 to Thursday 20:00, Friday closes at 13:00", () => {
    const { sectors, source } = weekSectors(1795453200); // Mon 23 Nov 2026
    expect(source).toBe("calendar");
    expectContiguousWeek(sectors);
    expect(runs(sectors, "holiday")).toEqual([[68, 92]]);
    expect(runs(sectors, "regular")).toEqual([
      [9.5, 16],
      [33.5, 40],
      [57.5, 64],
      [105.5, 109],
    ]);
    expect(kindAt(sectors, 109.5)).toBe("post");
    expect(runs(sectors, "overnight")).toContainEqual([92, 100]);
    expect(runs(sectors, "weekend")).toEqual([[116, 164]]);
  });

  it("Juneteenth on a Friday runs straight into the weekend", () => {
    const { sectors } = weekSectors(1781539200); // Mon 15 Jun 2026
    expect(runs(sectors, "holiday")).toEqual([[92, 120]]);
    expect(runs(sectors, "weekend")).toEqual([[120, 164]]);
    expect(runs(sectors, "regular")).toHaveLength(4);
  });

  it("Christmas Eve closes early and Christmas is a holiday", () => {
    const { sectors } = weekSectors(1797872400); // Mon 21 Dec 2026
    expect(runs(sectors, "regular").at(-1)).toEqual([81.5, 85]);
    expect(runs(sectors, "holiday")).toEqual([[92, 120]]);
  });

  it("the same week whichever instant in it is asked", () => {
    expect(mondayOf(1793021400)).toBe(mondayOf(1793511000));
    expect(sectorsOfWeek(mondayOf(1795453200))).toEqual(weekSectors(1795453200).sectors);
  });

  it("outside the calendar's range it draws the plain week and says so", () => {
    const w = weekSectors(1909143000);
    expect(w.source).toBe("typical");
    expect(w.sectors).toEqual(typicalWeekSectors());
  });

  it("reads the meridian in words", () => {
    const plain = typicalWeekSectors();
    expect(meridianReadout(plain, 24 + 7 + 35 / 60)).toBe("Tuesday 07:35 New York, pre-market");
    expect(meridianReadout(plain, 10)).toBe("Monday 10:00 New York, market open");
    expect(meridianReadout(plain, 18)).toBe("Monday 18:00 New York, after hours");
    expect(meridianReadout(plain, 125)).toBe("Saturday 05:00 New York, weekend, closed");
    expect(meridianReadout(plain, 166)).toBe("Sunday 22:00 New York, overnight, closed");
    const thanksgiving = weekSectors(1795453200).sectors;
    expect(meridianReadout(thanksgiving, 84)).toBe("Thursday 12:00 New York, Thanksgiving, closed");
    expect(meridianReadout(thanksgiving, 70)).toBe("Wednesday 22:00 New York, Thanksgiving, closed");
  });
});

describe("calendar helpers", () => {
  it("names the holidays the calendar lists, and only those", () => {
    expect(holidayName(dayNumber("2026-06-19"))).toBe("Juneteenth");
    expect(holidayName(dayNumber("2026-11-26"))).toBe("Thanksgiving");
    expect(holidayName(dayNumber("2026-09-07"))).toBe("Labor Day");
    expect(holidayName(dayNumber("2026-07-03"))).toBe("Independence Day");
    expect(holidayName(dayNumber("2027-01-18"))).toBe("Martin Luther King Jr. Day");
    expect(holidayName(dayNumber("2027-03-26"))).toBe("Good Friday");
    expect(holidayName(dayNumber("2027-12-24"))).toBe("Christmas");
    expect(holidayName(dayNumber("2026-10-12"))).toBeNull(); // Columbus Day: the exchange is open
    expect(holidayName(dayNumber("2026-11-27"))).toBeNull(); // early close, not a holiday
  });

  it("maps an hour of the shown week back to an instant, across DST", () => {
    const monday = dayNumber("2026-10-26");
    expect(tsOfHour(monday, 9.5)).toBe(1793021400); // Mon 26 Oct 09:30 EDT
    expect(tsOfHour(monday, 6 * 24 + 12)).toBe(localToUtc(dayNumber("2026-11-01"), 12 * 3600)); // Sun 1 Nov noon, now EST
    expect(tsOfHour(monday, 6 * 24 + 12) - tsOfHour(monday, 9.5)).toBe((6 * 24 + 2.5 + 1) * 3600);
    expect(hourOfWeek(tsOfHour(monday, 100.25))).toBe(100.25);
  });

  it("splits the clock of a plain week: 32.5 h regular, 48 h weekend", () => {
    const plain = typicalWeekSectors();
    expect(weekShare(plain, ["regular"]) * 168).toBe(32.5);
    expect(weekShare(plain, ["weekend"]) * 168).toBe(48);
    expect(1 - weekShare(plain, ["regular"])).toBeCloseTo(0.8065, 4);
  });

  it("measures wall-clock shares over a span from the calendar", () => {
    const mon = dayNumber("2026-09-14");
    const week = clockShares(localToUtc(mon, 0), localToUtc(mon + 7, 0));
    expect(week.regular * 168).toBeCloseTo(32.5, 9);
    expect(week.prePost * 168).toBeCloseTo(47.5, 9);
    expect(week.weekend * 168).toBeCloseTo(48, 9);
    expect(week.holiday).toBe(0);
    expect(Object.values(week).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(() => clockShares(1909143000, 1909143000 + 3600)).toThrow(/does not cover/);
  });
});
