// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Planisphere } from "../components/planisphere/Planisphere";
import { LIQUIDATIONS } from "../lib/liquidations";

const TUE_0735 = 1791286500; // Tue 6 Oct 2026 07:35 EDT

beforeEach(() => {
  // jsdom has no layout, media queries or resize observer
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 600, height: 600, top: 0, left: 0, right: 600, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("<Planisphere>", () => {
  it("renders the week turned to now, with a readable meridian", () => {
    render(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" frame="card" caption="Lista bStock liquidations" />);
    const dial = screen.getByRole("slider", { name: "Week" });
    expect(dial.getAttribute("aria-valuetext")).toBe("Tuesday 07:35 New York, pre-market");
    expect(Number(dial.getAttribute("aria-valuenow"))).toBeCloseTo(31.58, 2);
    expect(dial.querySelectorAll("[data-star]")).toHaveLength(121);
    expect(dial.querySelectorAll('[data-group="seed"] circle[fill="none"]')).toHaveLength(87 * 1);
    expect(dial.querySelector("textPath")?.textContent).toBe("Lista bStock liquidations");
    expect(screen.getByText("Tuesday 07:35 New York, pre-market")).toBeTruthy();
  });

  it("scrubs with the keyboard: hours, days, Home and End", () => {
    const onScrub = vi.fn();
    render(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" onScrub={onScrub} />);
    const dial = screen.getByRole("slider");
    const text = () => dial.getAttribute("aria-valuetext");

    fireEvent.keyDown(dial, { key: "ArrowRight" });
    expect(text()).toBe("Tuesday 08:00 New York, pre-market");
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    expect(text()).toBe("Tuesday 09:00 New York, pre-market");
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    expect(text()).toBe("Tuesday 10:00 New York, market open");
    fireEvent.keyDown(dial, { key: "PageUp" });
    expect(text()).toBe("Wednesday 10:00 New York, market open");
    fireEvent.keyDown(dial, { key: "PageDown" });
    fireEvent.keyDown(dial, { key: "ArrowLeft" });
    expect(text()).toBe("Tuesday 09:00 New York, pre-market");
    fireEvent.keyDown(dial, { key: "End" });
    expect(text()).toBe("Sunday 23:00 New York, overnight, closed");
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    expect(text()).toBe("Monday 00:00 New York, overnight, closed");
    fireEvent.keyDown(dial, { key: "Home" });
    expect(text()).toBe("Monday 00:00 New York, overnight, closed");
    fireEvent.keyDown(dial, { key: "PageDown" });
    expect(text()).toBe("Sunday 00:00 New York, weekend, closed");

    expect(onScrub).toHaveBeenCalledTimes(10);
    expect(onScrub.mock.calls[0]![0]).toBeCloseTo(32, 9);
    expect(onScrub.mock.calls.at(-1)![0]).toBeCloseTo(144, 9);
  });

  it("follows the live clock when no time is given", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(TUE_0735 * 1000);
    render(<Planisphere liquidations={LIQUIDATIONS} label="Week" />);
    const dial = screen.getByRole("slider");
    expect(dial.getAttribute("aria-valuetext")).toBe("Tuesday 07:35 New York, pre-market");
    act(() => {
      vi.advanceTimersByTime(60_000 * 30);
    });
    expect(dial.getAttribute("aria-valuetext")).toBe("Tuesday 08:05 New York, pre-market");
    vi.useRealTimers();
  });

  it("marks a closure window on the wheel", () => {
    // Tue 6 Oct 2026 16:00 EDT to Wed 09:30 EDT
    render(<Planisphere liquidations={LIQUIDATIONS} now={TUE_0735} label="Week" window={{ startsAt: 1791316800, endsAt: 1791379800 }} />);
    expect(screen.getByRole("slider").querySelectorAll('path[fill="#ff9f80"]')).toHaveLength(1);
  });
});
