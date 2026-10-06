import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JOB_STATUSES, REASONS, Reason, RISK_WINDOWS, SESSIONS, WINDOW_TYPES, flagNames, reasonName } from "../src/index";

const src = (rel: string) => readFileSync(new URL(`../../../contracts/src/${rel}`, import.meta.url), "utf8");

/** Member names of `enum <name> { ... }` in Solidity source, in declaration order. */
function solEnum(source: string, name: string): string[] {
  const m = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(source);
  if (!m?.[1]) throw new Error(`enum ${name} not found`);
  return m[1]
    .split(",")
    .map((s) => s.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean);
}

describe("enum maps follow the Solidity declarations", () => {
  it("Reason", () => {
    expect([...REASONS]).toEqual(solEnum(src("SessionOracle.sol"), "Reason"));
    expect(Reason.WINDOW_AHEAD).toBe(10);
    expect(reasonName(7)).toBe("PRICE_UNAVAILABLE");
    expect(() => reasonName(42)).toThrow(RangeError);
  });
  it("RiskWindow", () => expect([...RISK_WINDOWS]).toEqual(solEnum(src("SessionOracle.sol"), "RiskWindow")));
  it("Session and WindowType", () => {
    expect([...SESSIONS]).toEqual(solEnum(src("SessionCalendar.sol"), "Session"));
    expect([...WINDOW_TYPES]).toEqual(solEnum(src("SessionCalendar.sol"), "WindowType"));
  });
  it("JobStatus", () => expect([...JOB_STATUSES]).toEqual(solEnum(src("interfaces/IACP.sol"), "JobStatus")));
  it("overlay flags", () => {
    expect(flagNames(0)).toEqual([]);
    expect(flagNames(1 | 8)).toEqual(["HALTED", "ASSET_LIMITED"]);
  });
});
