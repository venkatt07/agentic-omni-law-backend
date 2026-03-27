import { createApp } from "./app.js";
import { getEnv } from "./config/env.js";
import { logger } from "./config/logger.js";
import { prisma } from "./prisma/client.js";

const env = getEnv();
const app = createApp();

async function start() {
  try {
    await prisma.$connect();
    app.listen(env.PORT, () => {
      logger.info(`backend listening on http://127.0.0.1:${env.PORT}`);
      logger.info(`cors origins: ${env.corsOrigins.join(", ")}`);
      logger.info(`smtp configured: ${env.smtpConfigured}`);
    });
  } catch (error) {
    logger.error("startup failed", error);
    process.exit(1);
  }
}

start();
