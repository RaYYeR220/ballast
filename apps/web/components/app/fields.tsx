"use client";
/* Form fields shared by the account, create and cover forms. */
import { useId, type ReactNode } from "react";
import { formatUnits } from "viem";
import { MANDATE_HELP } from "@/lib/mandate";
import s from "./app.module.css";

export function AmountField(p: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  help?: ReactNode;
  max?: { raw: bigint; decimals: number; label: string } | null;
}) {
  const id = useId();
  return (
    <div className={s.field}>
      <label htmlFor={id}>{p.label}</label>
      <div className={s.row}>
        <input id={id} inputMode="decimal" autoComplete="off" placeholder="0.0" value={p.value} onChange={(e) => p.onChange(e.target.value)} />
        <span className={s.unit}>{p.unit}</span>
        {p.max && p.max.raw > 0n ? (
          <button type="button" className={s.btnGhost} onClick={() => p.onChange(formatUnits(p.max!.raw, p.max!.decimals))}>
            Max
          </button>
        ) : null}
      </div>
      {p.max ? (
        <span className={s.help}>
          {p.max.label}: {Number(formatUnits(p.max.raw, p.max.decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} {p.unit}
        </span>
      ) : null}
      {p.help ? <span className={s.help}>{p.help}</span> : null}
    </div>
  );
}

export interface MandateInputs {
  maxLtv: string;
  shieldLtv: string;
  slippage: string;
  autoRestore: boolean;
}

export const mandateInputs = (m: { maxLtvBps: number; shieldLtvBps: number; maxSlippageBps: number; autoRestore: boolean }): MandateInputs => ({
  maxLtv: String(m.maxLtvBps / 100),
  shieldLtv: String(m.shieldLtvBps / 100),
  slippage: String(m.maxSlippageBps / 100),
  autoRestore: m.autoRestore,
});

function PctField({ label, value, onChange, help }: { label: string; value: string; onChange: (v: string) => void; help: string }) {
  const id = useId();
  return (
    <div className={s.field}>
      <label htmlFor={id}>{label}</label>
      <div className={s.row}>
        <input id={id} inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
        <span className={s.unit}>%</span>
      </div>
      <span className={s.help}>{help}</span>
    </div>
  );
}

export function MandateFields({ value, onChange }: { value: MandateInputs; onChange: (m: MandateInputs) => void }) {
  return (
    <div className={s.fields}>
      <PctField label="Max loan to value" value={value.maxLtv} onChange={(v) => onChange({ ...value, maxLtv: v })} help={MANDATE_HELP.maxLtvBps} />
      <PctField label="Shield loan to value" value={value.shieldLtv} onChange={(v) => onChange({ ...value, shieldLtv: v })} help={MANDATE_HELP.shieldLtvBps} />
      <PctField label="Max slippage on a sale" value={value.slippage} onChange={(v) => onChange({ ...value, slippage: v })} help={MANDATE_HELP.maxSlippageBps} />
      <div className={s.field}>
        <span className={s.lbl}>Restore after the open</span>
        <label className={s.check}>
          <input type="checkbox" checked={value.autoRestore} onChange={(e) => onChange({ ...value, autoRestore: e.target.checked })} />
          <span>Let the agent restore the loan</span>
        </label>
        <span className={s.help}>{MANDATE_HELP.autoRestore}</span>
      </div>
    </div>
  );
}
