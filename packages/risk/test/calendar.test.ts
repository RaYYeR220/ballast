import { describe, expect, it } from "vitest";
import { session, nextClose, nextOpen, prevClose, windowAfter, nextWindow, currentWindow, localDay, isTradingDay, regularOpenAt, regularCloseAt } from "../src/calendar";

describe("calendar parity with SessionCalendar.sol", () => {
  it.each([
    [1790341200, "PRE"], [1790344800, "REGULAR"], [1790368200, "POST"], [1790382600, "CLOSED_WEEKEND"],
    [1790434800, "CLOSED_WEEKEND"], [1790551800, "CLOSED_WEEKEND"], [1790555400, "OVERNIGHT"], [1790578800, "OVERNIGHT"],
    [1788793200, "CLOSED_HOLIDAY"], [1788741000, "CLOSED_WEEKEND"], [1788827400, "OVERNIGHT"], [1795708800, "CLOSED_HOLIDAY"],
    [1795800600, "REGULAR"], [1795804200, "POST"], [1793367900, "REGULAR"], [1793630700, "REGULAR"], [1793628900, "PRE"],
    [1767182400, "UNKNOWN"], [1830524400, "UNKNOWN"],
  ])("session(%i) = %s", (ts, s) => expect(session(ts)).toBe(s));

  it("boundaries", () => {
    expect(nextClose(1790344800)).toBe(1790366400);
    expect(nextOpen(1790434800)).toBe(1790602200);
    expect(nextClose(1795791600)).toBe(1795802400);
    expect(nextOpen(1795806000)).toBe(1796049000);
    expect(prevClose(1767182400)).toBe(0);
    expect(prevClose(1790434800)).toBe(1790366400);
    expect(prevClose(1788868800)).toBe(1788552000);
    expect(nextOpen(1830524400)).toBe(0);
  });

  it("windowAfter", () => {
    expect(windowAfter(20721)).toBe("WEEKEND");
    expect(windowAfter(20720)).toBe("OVERNIGHT");
    expect(windowAfter(20700)).toBe("HOLIDAY");
    expect(windowAfter(20782)).toBe("HOLIDAY");
    expect(windowAfter(20545)).toBe("HOLIDAY");
    expect(windowAfter(20784)).toBe("WEEKEND");
    expect(windowAfter(20454)).toBe("NONE");
  });

  it("next/current window", () => {
    expect(nextWindow(1790344800)).toEqual({ type: "WEEKEND", startsAt: 1790366400, endsAt: 1790602200 });
    expect(currentWindow(1790434800)).toEqual({ type: "WEEKEND", closedAt: 1790366400, opensAt: 1790602200 });
    expect(currentWindow(1790344800).type).toBe("NONE");
  });

  it("REGULAR only inside the day's regular hours (sampled)", () => {
    for (let ts = 1767243600; ts < 1830315600; ts += 7919) {
      if (session(ts) === "REGULAR") {
        const { day } = localDay(ts);
        expect(isTradingDay(day)).toBe(true);
        expect(regularOpenAt(day)).toBeLessThanOrEqual(ts);
        expect(ts).toBeLessThan(regularCloseAt(day));
      }
    }
  });
});
