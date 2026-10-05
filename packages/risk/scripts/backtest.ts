import { readFileSync, writeFileSync } from "node:fs";
import { runBacktest, type ClosureWindow } from "../src/backtest";

const windows = JSON.parse(readFileSync(new URL("../../../data/closure-windows.json", import.meta.url), "utf8")) as ClosureWindow[];
const grid = [0.6, 0.65, 0.7, 0.72].map((startLtv) => ({ startLtv, ...runBacktest(windows, { lltv: 0.75, startLtv, targetHfAfterGap: 1.05 }) }));
const out = { generatedAt: new Date().toISOString(), lltv: 0.75, targetHfAfterGap: 1.05, results: grid };
writeFileSync(new URL("../../../data/backtest-lltv75.json", import.meta.url), JSON.stringify(out, null, 2));
console.table(grid.map(({ startLtv, windows, unprotectedLiquidations, protectedLiquidations, shieldsTriggered }) => ({ startLtv, windows, unprotectedLiquidations, protectedLiquidations, shieldsTriggered })));
