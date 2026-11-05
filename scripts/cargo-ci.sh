#!/usr/bin/env bash
# `cargo "$@"` for the Linux Rust CI jobs, held to what our own runners can take.
#
# On a GitHub-hosted runner this is plain cargo. On one of our self-hosted
# runners (4 CPUs, 14 GB at the largest) a full clippy or test build with one
# rustc per CPU starved the machine until the runner dropped off mid-compile,
# with no log to say why. There it builds two crates at a time, and logs the
# memory and disk left every 30 seconds so a runner that still runs out says
# which one it was.
#
# Set inside the step rather than in `env:` on purpose: rust-cache hashes
# CARGO_* variables into its key, and the cap must not split the cache
# between hosted and self-hosted runs.
#
#   bash scripts/cargo-ci.sh clippy --all-targets -- -D warnings
#   bash scripts/cargo-ci.sh test
set -euo pipefail

if [[ "${RUNNER_ENVIRONMENT:-}" == "self-hosted" ]]; then
  export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
  # One logger per job, however many steps call this.
  marker="${RUNNER_TEMP:-/tmp}/cargo-ci-resource-log"
  if [[ ! -e "$marker" ]]; then
    : >"$marker"
    (
      while sleep 30; do
        mem=$(free -m | awk '/^Mem:/ {print $7 " MB free of " $2 " MB"}')
        disk=$(df -h . | awk 'NR == 2 {print $4 " free of " $2}')
        echo "[runner] memory: $mem, disk: $disk"
      done
    ) &
  fi
  echo "[runner] self-hosted: CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS"
fi

exec cargo "$@"
