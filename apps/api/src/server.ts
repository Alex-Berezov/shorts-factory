import { env } from "@sf/config";
import Fastify from "fastify";

/**
 * REST API entry point. Route modules are registered per epic:
 *   /radar/*        E1   tracked channels, signals
 *   /intel/*        E2   trigger analysis, read DNA
 *   /inbox/*        E3   idea cards, approve/reject/later
 *   /research/*     E4   briefs
 *   /scripts/*      E5
 *   /production/*   E6
 *   /analytics/*    E7   + /oauth/google/* callbacks
 *   /experiments/*  E8
 *   /localization/* E9-E10
 *   /publishing/*   E11
 *   /system/*       E13  queues, quota, budget
 */
const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true, env: env.NODE_ENV }));

// TODO(E0-06): basic auth, zod type provider, error handler, route registration.

const port = 3001;
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
