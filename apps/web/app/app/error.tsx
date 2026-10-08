"use client";
/* Shown when something on /app throws while rendering: the page says so and offers to draw itself again,
   instead of going blank. Nothing here reads the chain or the wallet. */
import Link from "next/link";
import { useEffect } from "react";
import s from "@/components/app/app.module.css";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className={s.shell}>
      <header className={s.bar}>
        <Link href="/" className={s.mark}>
          Ballast
        </Link>
      </header>
      <main className={s.page}>
        <div className={s.head}>
          <div>
            <h1>This page hit an error</h1>
            <p>
              Nothing was sent from your wallet by this error. Your loans and covers are on BNB Chain and are not affected by what this page
              shows.
            </p>
          </div>
        </div>
        <section className={s.panel} aria-label="What you can do">
          <p className={s.muted}>
            Draw the page again. If a transaction was waiting for its receipt, check your wallet for its state before sending anything a second
            time.
          </p>
          <div className={s.stepButtons} style={{ marginTop: 16 }}>
            <button type="button" className={s.btn} onClick={reset}>
              Draw the page again
            </button>
            <Link href="/" className={s.btnGhost}>
              Back to the overview
            </Link>
          </div>
          {error.digest ? <p className={s.hint} style={{ marginTop: 16 }}>Reference {error.digest}</p> : null}
        </section>
      </main>
    </div>
  );
}
