import { appendFileSync } from "node:fs";

export interface ProbeRecord {
  ts: string;
  surface: "keyed" | "public" | "b402";
  method: string;
  endpoint: string;
  status: number;
  code: string;
  ok: boolean;
  latencyMs: number;
  attempt: number;
  error?: string;
}

export function createProbe(file = process.env.DX_PROBE_FILE ?? ".dx-probe.jsonl"): (r: ProbeRecord) => void {
  if (file === "off") return () => {};
  return (r) => {
    try {
      appendFileSync(file, `${JSON.stringify(r)}\n`);
    } catch {
      // the probe must never break a request
    }
  };
}
