#!/usr/bin/env bash
# `sudo apt-get "$@"` for CI, with a hard time limit and retries.
#
# A package mirror that accepts the connection and then stops sending held
# `apt-get update` for six hours, until GitHub cancelled the job. apt's own
# timeouts only cover a mirror that never answers, so each attempt also runs
# under `timeout`, and a stalled attempt is retried instead of waiting out
# the job.
#
#   bash scripts/apt-get-retry.sh update
#   bash scripts/apt-get-retry.sh install -y --no-install-recommends xvfb
set -euo pipefail

ATTEMPTS=3
LIMIT=600

echo 'Acquire::Retries "5"; Acquire::http::Timeout "30"; Acquire::https::Timeout "30";' |
  sudo tee /etc/apt/apt.conf.d/80-hippius-retries >/dev/null

for attempt in $(seq "$ATTEMPTS"); do
  if sudo timeout "$LIMIT" apt-get "$@"; then
    exit 0
  fi
  echo "::warning::apt-get $1 failed or stalled (attempt $attempt of $ATTEMPTS)"
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep 15
    # A killed install can leave dpkg half done; finish it before retrying.
    sudo dpkg --configure -a || true
  fi
done
exit 1
