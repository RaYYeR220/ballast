import { describe, expect, it } from "vitest";
import {
  angleOf,
  hourAtTop,
  hourLabel,
  polar,
  radiusForUsd,
  rotationFor,
  sectorPath,
  shortestTurn,
  starSize,
  wrapHour,
} from "../lib/planisphere/geometry";

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("time of week to angle", () => {
  it("maps the week onto a full turn, clockwise from the top", () => {
    expect(angleOf(0)).toBe(0);
    expect(angleOf(42)).toBe(90);
    expect(angleOf(84)).toBe(180);
    expect(angleOf(168)).toBe(360);
    close(angleOf(9.5), (9.5 / 168) * 360);
  });

  it("puts angle 0 at the top and 90 deg on the right", () => {
    const [x0, y0] = polar(0, 10);
    close(x0, 0);
    close(y0, -10);
    const [x1, y1] = polar(90, 10);
    close(x1, 10);
    close(y1, 0);
  });

  it("rotationFor brings an hour under the meridian, hourAtTop reads it back", () => {
    for (const h of [0, 7.5833, 33.5, 115.99, 167.9]) close(hourAtTop(rotationFor(h)), h, 1e-9);
    close(hourAtTop(rotationFor(-1)), 167);
    close(hourAtTop(rotationFor(170)), 2);
    // a full extra turn does not change the hour
    close(hourAtTop(rotationFor(10) - 360), 10);
  });

  it("wraps hours into [0, 168)", () => {
    expect(wrapHour(168)).toBe(0);
    expect(wrapHour(-0.5)).toBe(167.5);
    expect(wrapHour(200)).toBe(32);
  });

  it("labels hours like the meridian readout", () => {
    expect(hourLabel(0)).toBe("Monday 00:00");
    expect(hourLabel(24 + 7 + 35 / 60)).toBe("Tuesday 07:35");
    expect(hourLabel(4 * 24 + 16)).toBe("Friday 16:00");
    expect(hourLabel(-0.5)).toBe("Sunday 23:30");
  });

  it("turns the short way", () => {
    expect(shortestTurn(0, 10)).toBe(10);
    expect(shortestTurn(10, 0)).toBe(-10);
    expect(shortestTurn(-350, 0)).toBe(-10);
    expect(shortestTurn(0, 350)).toBe(-10);
  });

  it("draws sectors as closed annular paths, with the large-arc flag only past half a turn", () => {
    const d = sectorPath(9.5, 16, 10, 20);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("A20 20 0 0 1");
    expect(sectorPath(0, 100, 10, 20)).toContain("A20 20 0 1 1");
  });
});

describe("star radius from repaid USD", () => {
  const R = 100;
  it("puts $3 on the inner ring and $12k on the outer ring", () => {
    close(radiusForUsd(3, R), 20);
    close(radiusForUsd(12_000, R), 80);
  });
  it("is a log scale: the geometric midpoint lands half way", () => {
    close(radiusForUsd(Math.sqrt(3 * 12_000), R), 50, 1e-9);
    close(radiusForUsd(30, R) - radiusForUsd(3, R), radiusForUsd(300, R) - radiusForUsd(30, R), 1e-9);
  });
  it("clamps below $3 and above $12k", () => {
    expect(radiusForUsd(1, R)).toBe(20);
    expect(radiusForUsd(0, R)).toBe(20);
    expect(radiusForUsd(1e9, R)).toBe(80);
  });
  it("grows with the amount", () => {
    let prev = 0;
    for (const u of [3, 10, 100, 1000, 8959.23]) {
      expect(radiusForUsd(u, R)).toBeGreaterThan(prev);
      prev = radiusForUsd(u, R);
    }
  });
  it("sizes organic stars by the square root of their share of the largest", () => {
    expect(starSize(1000, 1000)).toBe(12);
    expect(starSize(1000, 1000, true)).toBe(7.4);
    expect(starSize(250, 1000)).toBe(7);
    expect(starSize(0, 1000)).toBe(2);
    expect(starSize(1000, 1000, false, 1.4)).toBe(16);
  });
});
