import { serveRest } from "./server";

if (import.meta.main) {
  try {
    await serveRest();
  } catch (error) {
    console.error("Failed to start Setupless/rest", error);
    process.exitCode = 1;
  }
}
