import calendarJson from "../../../config/nyse-calendar.json" with { type: "json" };
import bscJson from "../../../config/bsc-mainnet.json" with { type: "json" };

export interface TickerConfig {
  symbol: string;
  bStock: string;
  ondo: string;
  xStock: string;
  chainlink: string;
  atlas: string;
  gapBps: { overnight: number; weekend: number; holiday: number; earnings: number };
}

export const calendarConfig = calendarJson as unknown as {
  validFrom: number;
  validThrough: number;
  dst: [number, number][];
  holidayDays: number[];
  earlyCloseDays: number[];
  secondsOfDay: { preOpen: number; regularOpen: number; regularClose: number; earlyClose: number; postClose: number };
};

export const bscConfig = bscJson;
export const tickers = bscJson.tickers as TickerConfig[];

export function tickerBySymbol(sym: string): TickerConfig {
  const t = tickers.find((x) => x.symbol === sym);
  if (!t) throw new Error(`unknown ticker ${sym}`);
  return t;
}
