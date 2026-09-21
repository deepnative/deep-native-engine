import { start } from "./runtime.ts";
try {
  const running = await start(process.env);
  console.info("Deep Native Engine local preview is ready.");
  let closing = false;
  const shutdown = () => {
    if (!closing) {
      closing = true;
      void running.close().catch(() => {
        console.error("Preview shutdown failed.");
        process.exitCode = 1;
      });
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch {
  console.error(
    "Preview startup failed. Check the local database and configuration.",
  );
  process.exitCode = 1;
}
