import app from "./app";
import { logger } from "./lib/logger";
import { seedDemoData } from "./lib/seed";
import { initDb } from "@workspace/db";

const rawPort = process.env["PORT"] ?? "3001";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Initialize DB (handles PGlite schema creation if needed) before starting server
initDb()
  .then(() => {
    app.listen(port, async (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");
      try {
        await seedDemoData();
      } catch (seedError) {
        logger.error({ err: seedError }, "Unable to seed StockSense demo data");
      }
    });
  })
  .catch((err: unknown) => {
    logger.error({ err }, "Failed to initialize database");
    process.exit(1);
  });
