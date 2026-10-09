/* Runs once when the server starts: a malformed setting stops it here with a readable list, instead of
   surfacing later as a broken page. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertStartup } = await import("./lib/server/startup");
  assertStartup();
}
