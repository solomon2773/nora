#!/usr/bin/env bash
# infra-tests/lib/minio_ctl.sh — thin `mc` wrapper against the local dev
# MinIO instance (docker-compose.override.yml's `minio`/`minio-init`
# services, set up earlier this session for testing the S3/R2 storage
# destination). Parallels lib/db.sh's role for the object-storage side of
# an assertion — "does this key exist in the bucket," not "does this row
# exist in the table."
#
# Credentials/bucket match what minio-init already provisions — see
# docker-compose.override.yml's comment block on the `minio` service for
# the full rationale (fixed dev creds, same as the Kind e2e smoke test).

MINIO_CTL_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$MINIO_CTL_LIB_DIR/docker_ctl.sh"

MINIO_ALIAS="local"
MINIO_BUCKET="${MINIO_BUCKET:-nora-logs-local}"
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-noraminio}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-noraminiosecret}"

# mc_run <mc-subcommand-and-args...> — runs one `mc` invocation via a
# throwaway container on the compose network, aliasing itself first. Not
# reusing the long-lived minio-init container since that one's job is
# strictly bucket creation at stack boot, not a general-purpose `mc` shell.
mc_run() {
  compose run --rm --entrypoint /bin/sh minio-init -c "
    mc alias set ${MINIO_ALIAS} http://minio:9000 ${MINIO_ACCESS_KEY} ${MINIO_SECRET_KEY} >/dev/null &&
    mc $*
  "
}

# minio_object_exists <key> — 0 if present, 1 if not.
minio_object_exists() {
  mc_run stat "${MINIO_ALIAS}/${MINIO_BUCKET}/$1" >/dev/null 2>&1
}

# minio_object_count <prefix> — count of objects under a prefix.
#
# Not `grep -c . || echo 0`: when the count is genuinely zero, `grep -c .`
# itself already prints "0" but exits 1 (no matches), which ALSO triggers
# the `|| echo 0` fallback — producing a bogus two-line "0\n0" instead of
# a single "0". `wc -l` never fails on empty input, so there's no fallback
# needed at all.
minio_object_count() {
  mc_run find "${MINIO_ALIAS}/${MINIO_BUCKET}/$1" --name '*' 2>/dev/null | wc -l | tr -d ' '
}
