/* Outbound links that only exist once Ballast is deployed and published. Until a URL is set the page
   shows the label without a link, instead of a link to nowhere. */
export const LINKS: { contracts: string | null; notebook: string | null; source: string | null } = {
  contracts: process.env.NEXT_PUBLIC_CONTRACTS_URL ?? null,
  notebook: process.env.NEXT_PUBLIC_NOTEBOOK_URL ?? null,
  source: process.env.NEXT_PUBLIC_SOURCE_URL ?? null,
};
