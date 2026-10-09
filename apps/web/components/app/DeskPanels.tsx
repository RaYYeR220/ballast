/* What the desk agent did and will do (watch log), what the contract turned down (refusal log) and the desk's
   own notes. All of it comes from the desk's feed; when the desk is offline each panel says so. */
"use client";
import { useState } from "react";
import { txUrl } from "@/lib/app-config";
import type { DeskEvent, DeskOffline, DeskResult } from "@/lib/desk";
import { eventRow, refusalRows, type LogRow, type Units } from "@/lib/feed-rows";
import { nyDayTime, shortHex } from "@/lib/format";
import s from "./app.module.css";

const ICON: Record<LogRow["kind"], string> = { shield: s.sh!, restore: s.rs!, refused: s.rf!, alert: s.al!, noop: s.nn!, publish: s.nn!, other: s.nn! };
/** routine entries (checks with nothing to do, oracle overlay posts) stay in the full history */
const ROUTINE: ReadonlySet<LogRow["kind"]> = new Set(["noop", "publish"]);

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** `then`: one short sentence for secondary panels instead of the full explanation */
export function OfflineNote({ off, then }: { off: DeskOffline; then?: string }) {
  const title = off.reason === "not-configured" ? "No desk agent is connected." : "The desk is offline.";
  return (
    <p className={s.offline} role="status">
      <span>
        <b>{title}</b> {then ?? `${cap(off.detail)}. Nothing from the agent is shown until it answers; the contract limits hold without it.`}
      </span>
    </p>
  );
}

function TxCell({ hash, chainId, status }: { hash?: string; chainId: number; status?: string }) {
  if (!hash) return <span className={s.faint}>{status ?? ""}</span>;
  const url = txUrl(chainId, hash);
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {shortHex(hash)}
    </a>
  ) : (
    <span className={s.muted}>{shortHex(hash)}</span>
  );
}

export interface WatchLogProps {
  feed: DeskResult<{ events: DeskEvent[] }> | undefined;
  planned: LogRow[];
  units?: Units;
  chainId: number;
  /** "account": one account's log; "desk": every account the desk keeps */
  scope: "account" | "desk";
}

export function WatchLog({ feed, planned, units, chainId, scope }: WatchLogProps) {
  const [all, setAll] = useState(false);
  const events = feed?.status === "online" ? feed.data.events : [];
  const rows = events.map((e) => eventRow(e, units)).filter((r) => all || !ROUTINE.has(r.kind));
  const shown = all ? rows : rows.slice(0, 6);
  return (
    <section className={`${s.panel} ${s.span7}`} aria-label="Shield and restore timeline">
      <div className={s.ph}>
        <div>
          <h2>Watch log</h2>
          <p className={s.sub}>
            {scope === "account" ? "What the agent did around each close, and what it will do next." : "What the desk agent did around each close, across every account it keeps."}
          </p>
        </div>
        {feed?.status === "online" && events.length > 0 ? (
          <button type="button" className={s.linkBtn} aria-expanded={all} onClick={() => setAll((a) => !a)}>
            {all ? "Recent only" : "Full history"}
          </button>
        ) : null}
      </div>
      <ul className={s.log}>
        {planned.map((r) => (
          <li key={r.key} className={s.plan}>
            <time>{nyDayTime(r.ts)}</time>
            <i className={ICON[r.kind]} aria-hidden="true" />
            <span>
              <b>{r.title}</b>, {r.text}
            </span>
            <span>planned</span>
          </li>
        ))}
        {shown.map((r) => (
          <li key={r.key}>
            <time>{nyDayTime(r.ts)}</time>
            <i className={ICON[r.kind]} aria-hidden="true" />
            <span>
              <b>{r.title}</b>
              {r.text ? `, ${r.text}` : ""}
            </span>
            <TxCell hash={r.txHash} chainId={chainId} status={r.status} />
          </li>
        ))}
      </ul>
      {feed === undefined ? <p className={s.offline}>Reading the desk feed...</p> : null}
      {feed?.status === "offline" ? <OfflineNote off={feed} /> : null}
      {feed?.status === "online" && rows.length === 0 ? (
        <p className={s.offline}>
          {scope === "account" ? "The desk has not acted on this account yet. Its first entry appears before the next close." : "The desk has not recorded any action yet."}
        </p>
      ) : null}
    </section>
  );
}

export function RefusalLog({ feed, units, chainId }: { feed: DeskResult<{ events: DeskEvent[] }> | undefined; units?: Units; chainId: number }) {
  const rows = feed?.status === "online" ? refusalRows(feed.data.events, units).slice(0, 8) : [];
  return (
    <section className={`${s.panel} ${s.span5}`} aria-label="Refusal log">
      <div className={s.ph}>
        <div>
          <h2>Refusal log</h2>
          <p className={s.sub}>Calls by the desk agent that the contract turned down, with the reason.</p>
        </div>
      </div>
      {rows.length > 0 ? (
        <div className={s.scroll}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>When</th>
                <th>Refused call</th>
                <th>Reason</th>
                <th className={s.r}>Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{nyDayTime(r.ts)}</td>
                  <td>
                    {r.call}
                    <br />
                    <span className={s.faint}>{r.from}</span>
                  </td>
                  <td>
                    <span className={`${s.tag} ${s.no}`} title={r.message}>
                      {r.reason}
                    </span>
                  </td>
                  <td className={s.r}>
                    <TxCell hash={r.txHash} chainId={chainId} status="simulated" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {feed === undefined ? <p className={s.offline}>Reading the desk feed...</p> : null}
      {feed?.status === "offline" ? <OfflineNote off={feed} then="The refusal log fills in when it answers." /> : null}
      {feed?.status === "online" && rows.length === 0 ? (
        <p className={s.offline}>No refusals yet. When the contract turns a call down, it is listed here with its reason and transaction.</p>
      ) : null}
    </section>
  );
}

export function DeskNotes({ feed }: { feed: DeskResult<{ events: DeskEvent[] }> | undefined }) {
  const notes = feed?.status === "online" ? feed.data.events.filter((e) => e.note).slice(0, 3) : [];
  return (
    <section className={`${s.panel} ${s.span12}`} aria-label="Agent desk notes">
      <div className={s.ph}>
        <div>
          <h2>Desk notes</h2>
          <p className={s.sub}>Short notes from the desk agent, written after it acts.</p>
        </div>
      </div>
      {notes.length > 0 ? (
        <div className={s.notes}>
          {notes.map((e) => (
            <article key={`${e.seq}-${e.ts}`}>
              <time>{nyDayTime(e.ts)}</time>
              <p className={s.note}>{e.note}</p>
              <p className={s.by}>Ballast desk{e.symbol ? `, ${e.symbol}` : ""}</p>
            </article>
          ))}
        </div>
      ) : null}
      {feed === undefined ? <p className={s.offline}>Reading the desk feed...</p> : null}
      {feed?.status === "offline" ? <OfflineNote off={feed} then="Its notes appear here when it answers." /> : null}
      {feed?.status === "online" && notes.length === 0 ? <p className={s.offline}>No notes yet. The desk writes one after each shield, restore or refusal.</p> : null}
    </section>
  );
}
