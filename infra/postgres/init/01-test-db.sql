-- Separate database for integration tests (packages/db/test/*.int.test.ts),
-- kept apart from the development database so int-test cleanup never touches
-- local dev data. Runs only on a fresh volume (Postgres entrypoint convention);
-- on an existing volume, run `docker compose down -v` or create it by hand.
CREATE DATABASE shorts_factory_test OWNER sf;
