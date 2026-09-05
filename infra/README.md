# Infra

- `docker-compose.yml` — local Postgres 16 + Redis 7. Apps run via `pnpm dev` during development.
- Production target (MVP): single VPS with the same compose file extended by api/worker/web services, or Fly.io/Railway.
- Backups: daily `pg_dump` cron on the host (to be scripted in E0).
