/* "Your tokenized stocks": what the connected wallet holds across bStocks, Ondo and xStocks, as the Binance
   Wallet API reports it (or as read from BNB Chain when Binance is not answering, which the panel says).
   Only a bStock with a lending market can back a credit line here; the others are listed as "no market". */
import { formatUnits } from "viem";
import type { HeldStock, StocksBody } from "@/lib/views";
import s from "./app.module.css";

const amount = (raw: string) => {
  const n = Number(formatUnits(BigInt(raw), 18));
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 4 });
};

function value(st: HeldStock): string {
  if (st.priceUsd === null) return "";
  const usd = Number(formatUnits(BigInt(st.rawBalance), 18)) * Number(st.priceUsd);
  return `, about $${usd.toLocaleString("en-US", { maximumFractionDigits: usd < 100 ? 2 : 0 })}`;
}

export function sourceLine(b: StocksBody): string {
  if (b.status !== "ok") return b.binance === "unavailable" ? "Binance API unavailable, and BNB Chain did not answer either." : "Your holdings could not be read from BNB Chain.";
  if (b.source === "binance") return "From the Binance Wallet API.";
  return b.binance === "unavailable" ? "Binance API unavailable: read from BNB Chain instead, without prices." : "Read from BNB Chain.";
}

export function StockPicker(p: { stocks: StocksBody | undefined; loading: boolean; selected: string | null; onPick: (marketId: string) => void }) {
  const b = p.stocks;
  return (
    <div className={s.field} role="group" aria-label="Your tokenized stocks">
      <span className={s.lbl}>Your tokenized stocks</span>
      {p.loading && !b ? <span className={s.help}>Reading your holdings...</span> : null}
      {b?.status === "ok" && b.stocks.length === 0 ? (
        <span className={s.help}>This wallet holds none of the tokenized stocks Ballast knows. A credit line needs a bStock as collateral.</span>
      ) : null}
      {b?.status === "ok" && b.stocks.length > 0 ? (
        <ul className={s.stockList}>
          {b.stocks.map((st) => (
            <li key={st.token}>
              <span>
                <b>
                  {amount(st.rawBalance)} {st.tokenSymbol}
                </b>
                <span className={s.muted}>
                  {" "}
                  {st.symbol} as {st.issuer === "bStock" ? "a bStock" : st.issuer === "Ondo" ? "an Ondo token" : "an xStock"}
                  {value(st)}
                </span>
              </span>
              {st.market ? (
                <button type="button" className={s.linkBtn} aria-pressed={p.selected === st.market.id} onClick={() => p.onPick(st.market!.id)}>
                  {p.selected === st.market.id ? "Selected" : "Use as collateral"}
                </button>
              ) : (
                <span className={s.faint}>no market</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {b ? <span className={s.help}>{sourceLine(b)}</span> : null}
    </div>
  );
}
