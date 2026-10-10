#!/usr/bin/env bash
# Nightly dump of the shorts_factory database with a 14-day rotation.
#
# Runs pg_dump inside the running `postgres` service of the full stack
# (compose.yaml at the repository root), so the host needs Docker only - no
# Postgres client, no password: the dump connects over the container's local
# socket. Cron example and restore: infra/README.md.
#
# Settings (environment, all optional):
#   BACKUP_DIR       where dumps go            (default $HOME/backups/shorts-factory)
#   KEEP_DAYS        how many days to keep     (default 14)
#   SF_COMPOSE_FILE  compose file of the stack (default <repo>/compose.yaml)
#
# The defaults are writable by whoever runs the script - in particular by the
# user whose crontab runs it (a member of the `docker` group, not root): a
# root-owned default would make every unattended run fail before the dump.
# Not `COMPOSE_FILE`: Compose itself reads that variable (a `:`-separated
# list), and a value exported for another project must not land in `-f`.
# Dumps are created readable by their owner only (umask 077): they hold the
# whole database.
#
# Compose reads the root `.env` as its interpolation file on every call and
# prints to stderr what it cannot interpolate - for a `$` inside a password,
# `The "<rest of the password>" variable is not set`. The cron line appends
# stderr to a log that is kept, so every night would add a piece of the secret
# to it. The script gives Compose the template `.env.example` of its checkout
# instead (`--env-file`): `exec` needs no variable of `.env`, and the running
# containers keep the `.env` they have mounted.
#
# A dump is written to a temporary file and renamed only when pg_dump
# succeeded: a failed run leaves no half-written dump behind, exits non-zero
# and does not rotate - the old dumps are all there is then.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${BACKUP_DIR:-}" && -z "${HOME:-}" ]]; then
  echo "backup: neither BACKUP_DIR nor HOME is set - nowhere to write" >&2
  exit 2
fi
BACKUP_DIR="${BACKUP_DIR:-${HOME}/backups/shorts-factory}"
KEEP_DAYS="${KEEP_DAYS:-14}"
compose_file="${SF_COMPOSE_FILE:-${script_dir}/../../compose.yaml}"
interpolation_file="${script_dir}/../../.env.example"
umask 077

if ! [[ "$KEEP_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "backup: KEEP_DAYS must be a positive integer, got '${KEEP_DAYS}'" >&2
  exit 2
fi

if ! mkdir -p "$BACKUP_DIR" 2>/dev/null || ! [[ -w "$BACKUP_DIR" ]]; then
  echo "backup: cannot write to ${BACKUP_DIR} as $(id -un) - set BACKUP_DIR to a directory this user owns" >&2
  exit 1
fi
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${BACKUP_DIR}/shorts_factory-${stamp}.dump"
tmp="$(mktemp "${BACKUP_DIR}/.shorts_factory-${stamp}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

docker compose -f "$compose_file" --env-file "$interpolation_file" exec -T postgres \
  pg_dump -U sf -d shorts_factory --format=custom >"$tmp"

mv "$tmp" "$target"
echo "backup: wrote ${target} ($(wc -c <"$target") bytes)"

# Only our own dumps, by name: anything else in the directory is not ours to
# delete. The cut-off is KEEP_DAYS minus half a day, in minutes: a nightly
# dump is a few minutes older or younger than "exactly N days" depending on
# how long each run took, and whole-day -mtime rounding kept KEEP_DAYS dumps
# one night and one more the next. Half a day away from both neighbours, a
# daily run always keeps exactly KEEP_DAYS dumps - tonight's and the ones of
# the KEEP_DAYS-1 nights before.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'shorts_factory-*.dump' \
  -mmin +"$((KEEP_DAYS * 1440 - 720))" -print -delete |
  sed 's/^/backup: rotated out /'
