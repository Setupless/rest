import { Elysia } from "elysia";

export const app = new Elysia().get("/health", () => ({
  status: "ok",
}));

if (import.meta.main) {
  const port = process.env.PORT ?? 3000;
  let shutdownStarted = false;

  app.listen(port);

  console.log(
    `Setupless/rest is running at http://localhost:${app.server?.port}`,
  );

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shutdownStarted) return;

    shutdownStarted = true;
    console.log(`Received ${signal}; shutting down Setupless/rest`);

    try {
      await app.stop();
    } catch (error) {
      console.error("Failed to shut down Setupless/rest cleanly", error);
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
