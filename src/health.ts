import http from "node:http";
import type { Client } from "discord.js";
import type { Db } from "./db/db.js";

/**
 * Tiny HTTP health endpoint for the Docker healthcheck and deploy
 * verification. It is not published outside the container.
 */
export function startHealthServer(port: number, client: Client, db: Db): http.Server {
  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    void (async () => {
      const dbOk = await Promise.race([
        db.query("SELECT 1").then(() => true, () => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      const discordOk = client.isReady();
      const ok = dbOk && discordOk;
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: ok ? "ok" : "unhealthy",
          discord: discordOk ? "ready" : "not ready",
          database: dbOk ? "ok" : "unreachable",
          pingMs: discordOk ? client.ws.ping : null,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        }),
      );
    })();
  });
  server.listen(port);
  return server;
}
