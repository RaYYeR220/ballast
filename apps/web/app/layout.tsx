import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Jost } from "next/font/google";
import type { ReactNode } from "react";
import { WEEK } from "@/lib/clock";
import { pct } from "@/lib/liquidations";
import "./globals.css";

/* only the faces the pages use: Cormorant 400 (chart labels), 500 (headings), 600 (marks, figures), italic 400 (captions);
   Jost 300 (body), 400 (data, tooltips), 500 (buttons, emphasis) */
const display = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-cormorant",
  display: "swap",
});
const ui = Jost({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  variable: "--font-jost",
  display: "swap",
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const TITLE = "Ballast";
const SHARE_TITLE = `Ballast: Wall Street sleeps ${pct(WEEK.closedShare)} of the week`;
const DESCRIPTION =
  "A credit line on your tokenized stocks that keeps the watch while New York is closed. Before every close an agent shields the loan; while the market is shut, a contract on BNB Chain lets it only reduce risk.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: TITLE,
    title: SHARE_TITLE,
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: SHARE_TITLE,
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#faf6ea",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable}`}>
      <body>{children}</body>
    </html>
  );
}
