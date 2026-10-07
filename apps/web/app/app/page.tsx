import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Ballast app" };

export default function AppComingOnline() {
  return (
    <div className="flex min-h-svh flex-col bg-bg font-ui text-ink">
      <header className="flex h-16 items-center border-b border-rule bg-p-950 px-[clamp(16px,2.6vw,40px)]">
        <Link href="/" className="font-display text-2xl leading-none font-semibold text-ink no-underline">
          Ballast
        </Link>
      </header>
      <main className="mx-auto flex w-full max-w-[1520px] flex-1 flex-col justify-center px-[clamp(16px,2.6vw,40px)] py-16">
        <h1 className="font-display text-[38px] leading-[1.05] font-medium">The app is coming online</h1>
        <p className="mt-4 max-w-[60ch] text-[17px] leading-[1.6] text-ink-2">
          Credit lines, cushion covers and the refusal log open here once the Ballast contracts are live on BNB Chain. Nothing on this page is
          connected to a wallet yet, and no figures are shown until they can be read from the chain.
        </p>
        <p className="mt-10">
          <Link
            href="/"
            className="inline-block rounded-full bg-btn px-8 py-[15px] text-base leading-none font-medium text-btn-ink no-underline"
          >
            Back to the overview
          </Link>
        </p>
      </main>
    </div>
  );
}
