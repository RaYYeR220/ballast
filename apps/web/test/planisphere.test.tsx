// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closureHours, Planisphere } from "../components/planisphere/Planisphere";
import { LIQUIDATIONS } from "../lib/liquidations";

const TUE_0735 = 1791286500; // Tue 6 Oct 2026 07:35 EDT
const THU_1000 = 1791468000; // Thu 8 Oct 2026 10:00 EDT

let width = 600;

/* jsdom has no PointerEvent: give pointer events their pointer fields */
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

beforeEach(() => {
  width = 600;
  // jsdom has no layout, media queries or resize observer
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width, height: width, top: 0, left: 0, right: width, bottom: width, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
  vi.stubGlobal("matchMedia", vi.fn((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("PointerEvent", TestPointerEvent);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const dial = () => screen.getByRole("slider");
const reading = () => dial().getAttribute("aria-valuetext");

describe("<Planisphere>", () => {
  it("renders the week turned to now, with a readable meridian", () => {
    render(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" frame="card" caption="Lista bStock liquidations" />);
    expect(screen.getByRole("slider", { name: "Week" })).toBeTruthy();
    expect(reading()).toBe("Tuesday 07:35 New York, pre-market");
    expect(Number(dial().getAttribute("aria-valuenow"))).toBeCloseTo(31.58, 2);
    expect(dial().querySelectorAll("[data-star]")).toHaveLength(121);
    expect(dial().querySelectorAll('[data-group="seed"] circle[fill="none"]')).toHaveLength(87);
    expect(dial().querySelector("textPath")?.textContent).toBe("Lista bStock liquidations");
    expect(dial().innerHTML).toContain(">MONDAY<");
    expect(screen.getByText("Tuesday 07:35 New York, pre-market")).toBeTruthy();
  });

  it("goes compact when drawn narrower than 480 px, or when told to", () => {
    width = 400;
    const { rerender } = render(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" />);
    expect(dial().innerHTML).toContain(">MON<");
    rerender(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" compact={false} />);
    expect(dial().innerHTML).toContain(">MONDAY<");
  });

  it("scrubs with the keyboard and reports the hour and the instant", () => {
    const onScrub = vi.fn();
    render(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" onScrub={onScrub} />);
    const keys: [string, string][] = [
      ["ArrowRight", "Tuesday 08:00 New York, pre-market"],
      ["ArrowRight", "Tuesday 09:00 New York, pre-market"],
      ["ArrowRight", "Tuesday 10:00 New York, market open"],
      ["PageUp", "Wednesday 10:00 New York, market open"],
      ["PageDown", "Tuesday 10:00 New York, market open"],
      ["ArrowLeft", "Tuesday 09:00 New York, pre-market"],
      ["End", "Sunday 23:00 New York, overnight, closed"],
      ["ArrowRight", "Monday 00:00 New York, overnight, closed"],
      ["Home", "Monday 00:00 New York, overnight, closed"],
      ["PageDown", "Sunday 00:00 New York, weekend, closed"],
    ];
    for (const [key, text] of keys) {
      fireEvent.keyDown(dial(), { key });
      expect(reading()).toBe(text);
    }
    expect(onScrub).toHaveBeenCalledTimes(keys.length);
    expect(onScrub.mock.calls[0]![0].hourOfWeek).toBeCloseTo(32, 9);
    expect(onScrub.mock.calls[0]![0].ts).toBe(1791288000); // Tue 6 Oct 08:00 EDT
    expect(onScrub.mock.calls.at(-1)![0].hourOfWeek).toBeCloseTo(144, 9);
    expect(onScrub.mock.calls.at(-1)![0].ts).toBe(1791691200); // Sun 11 Oct 00:00 EDT
  });

  it("reads the live clock on each minute boundary", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime((TUE_0735 + 30) * 1000);
    render(<Planisphere liquidations={LIQUIDATIONS} label="Week" />);
    expect(reading()).toBe("Tuesday 07:35 New York, pre-market");
    act(() => vi.advanceTimersByTime(30_100));
    expect(reading()).toBe("Tuesday 07:36 New York, pre-market");
    act(() => vi.advanceTimersByTime(29 * 60_000));
    expect(reading()).toBe("Tuesday 08:05 New York, pre-market");
  });

  it("drifts back to now after a turn, but not while the dial has focus, and not with followNow off", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
    vi.setSystemTime(TUE_0735 * 1000);
    const { rerender } = render(<Planisphere liquidations={LIQUIDATIONS} label="Week" />);
    fireEvent.focusIn(dial());
    fireEvent.keyDown(dial(), { key: "PageUp" });
    expect(reading()).toBe("Wednesday 07:00 New York, pre-market");
    act(() => vi.advanceTimersByTime(3 * 60_000));
    expect(reading()).toBe("Wednesday 07:00 New York, pre-market");
    fireEvent.focusOut(dial());
    act(() => vi.advanceTimersByTime(60_100));
    expect(reading()).toBe("Tuesday 07:39 New York, pre-market");

    rerender(<Planisphere liquidations={LIQUIDATIONS} label="Week" followNow={false} />);
    fireEvent.keyDown(dial(), { key: "PageUp" });
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(reading()).toBe("Wednesday 07:00 New York, pre-market");
  });

  it("a new controlled now always re-centres, even right after a turn", () => {
    const { rerender } = render(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" />);
    fireEvent.keyDown(dial(), { key: "PageUp" });
    expect(reading()).toBe("Wednesday 07:00 New York, pre-market");
    rerender(<Planisphere liquidations={LIQUIDATIONS} now={THU_1000} label="Week" />);
    expect(reading()).toBe("Thursday 10:00 New York, market open");
  });

  it("marks a closure window by its New York hours, also across a DST change", () => {
    // Fri 30 Oct 2026 16:00 EDT to Mon 2 Nov 09:30 EST: 66.5 real hours, 65.5 on the wheel
    const fallBack = { startsAt: 1793390400, endsAt: 1793629800 };
    expect(closureHours(fallBack)).toEqual({ h0: 112, h1: 177.5 });
    expect(closureHours({ startsAt: 1791316800, endsAt: 1791379800 })).toEqual({ h0: 40, h1: 57.5 }); // Tue 16:00 to Wed 09:30
    render(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" window={fallBack} />);
    expect(dial().querySelectorAll('path[fill="#ff9f80"]')).toHaveLength(1);
  });
});

describe("<Planisphere> pointer input", () => {
  const touch = (type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel", x: number, y: number, target?: Element) =>
    fireEvent[type](target ?? dial(), { pointerId: 7, pointerType: "touch", clientX: x, clientY: y, button: 0 });

  it("a vertical swipe on the wheel is left to the page", () => {
    const onScrub = vi.fn();
    render(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" onScrub={onScrub} />);
    touch("pointerDown", 300, 300);
    touch("pointerMove", 304, 330);
    touch("pointerMove", 306, 380);
    touch("pointerCancel", 306, 380); // the browser took the scroll
    expect(onScrub).not.toHaveBeenCalled();
    expect(reading()).toBe("Tuesday 07:35 New York, pre-market");
    expect(dial().hasAttribute("data-dragging")).toBe(false);
  });

  it("a sideways drag turns it linearly: half a turn across the full width", () => {
    const onScrub = vi.fn();
    render(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" onScrub={onScrub} />);
    touch("pointerDown", 300, 300);
    touch("pointerMove", 306, 301); // inside the slop: nothing yet
    expect(onScrub).not.toHaveBeenCalled();
    touch("pointerMove", 310, 302); // 10 px sideways: the dial takes it, +3 deg
    expect(dial().hasAttribute("data-dragging")).toBe(true);
    expect(onScrub.mock.calls.at(-1)![0].hourOfWeek).toBeCloseTo(31.5833 - (3 / 360) * 168, 3);
    touch("pointerMove", 450, 320); // 150 px: +45 deg = 21 h earlier at the top
    expect(reading()).toBe("Monday 10:35 New York, market open");
    touch("pointerUp", 450, 320);
    expect(dial().hasAttribute("data-dragging")).toBe(false);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    fireEvent.click(dial(), { detail: 1 }); // the click that ends a drag is swallowed
    expect(open).not.toHaveBeenCalled();
  });

  it("a mouse drag still turns it by angle", () => {
    render(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" />);
    const mouse = (type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number) =>
      fireEvent[type](dial(), { pointerId: 1, pointerType: "mouse", clientX: x, clientY: y, button: 0 });
    mouse("pointerDown", 600, 300); // right of centre
    mouse("pointerMove", 300, 600); // below centre: +90 deg
    mouse("pointerUp", 300, 600);
    expect(reading()).toBe("Sunday 13:35 New York, weekend, closed");
  });

  it("on touch the first tap on a star shows its tip and the second opens BscScan", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" />);
    const star = dial().querySelector('[data-star="6"] .star-hit')!;
    const tap = () => {
      touch("pointerDown", 100, 100, star);
      touch("pointerUp", 100, 100, star);
      fireEvent.click(star, { detail: 1 });
    };
    tap();
    expect(open).not.toHaveBeenCalled();
    const tip = document.querySelector(".star-tip") as HTMLElement;
    expect(tip.style.opacity).toBe("1");
    expect(tip.textContent).toContain("$8,705 repaid, SPCXB");
    expect(tip.textContent).toContain("Tap again to open on BscScan");
    tap();
    expect(open).toHaveBeenCalledWith(`https://bscscan.com/tx/${LIQUIDATIONS[6]!.tx}`, "_blank", "noopener");
  });

  it("with a mouse a click on a star opens BscScan at once", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" />);
    const star = dial().querySelector('[data-star="6"] .star-hit')!;
    fireEvent.pointerDown(star, { pointerId: 1, pointerType: "mouse", button: 0 });
    fireEvent.click(star, { detail: 1 });
    expect(open).toHaveBeenCalledTimes(1);
  });
});
