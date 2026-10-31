// Runs once when the server starts, before it takes requests (Next 16: not during `next build`).
// A server that fails its startup checks exits instead of answering every request with an error. The checks live in a
// Node.js-only module: Next also compiles this file for the Edge runtime, which has no process.exit.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startServer } = await import("./server/startup");
  await startServer();
}
