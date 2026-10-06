#!/usr/bin/env bash
# Run the screen-capture runtime checks (src-tauri/tests/capture_recorder_runtime.rs)
# against the built app binary, and turn their output into something a
# workflow run can be judged by.
#
#   scripts/capture-runtime-check.sh [libtest filter...]
#
# Used by ci.yml's capture-runtime-windows (Git Bash) and capture-runtime-linux
# (under scripts/with-xvfb.sh) jobs; it runs the same on a Windows or Linux dev machine.
# The caller sets the environment the tests read:
#   HIPPIUS_CAPTURE_RUNTIME_REQUIRE=1  what the job installs must be present
#   HIPPIUS_CAPTURE_RUNTIME_AUDIO=1    an audio server with a default output runs
#   HIPPIUS_CAPTURE_RUNTIME_KEEP=<dir> copy the test recording there
#
# Three things a plain `cargo test` would let through, each caught here:
#   - A `RUNTIME-SKIP:` line (a runner limit such as no Media Foundation) only
#     prints; it becomes a workflow warning so a skip is visible on the run's
#     summary, not buried in the log.
#   - Zero tests executed (a dropped `--ignored`, a renamed file or filter)
#     exits 0 with "0 passed"; that fails here.
#   - Fewer tests than expected run: CAPTURE_RUNTIME_MIN_TESTS (default 1)
#     sets the floor.
set -euo pipefail

cd "$(dirname "$0")/../src-tauri"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

set +e
cargo test --test capture_recorder_runtime -- --ignored --nocapture --test-threads=1 "$@" 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"
set -e

while IFS= read -r line; do
  echo "::warning title=Capture runtime check skipped::${line#*RUNTIME-SKIP: }"
done < <(grep -a 'RUNTIME-SKIP:' "$log" || true)

if [[ "$status" -ne 0 ]]; then
  echo "::error title=Capture runtime checks failed::cargo test exited $status; the failing test's output is above."
  exit "$status"
fi

passed="$(grep -aoE 'test result: ok\. [0-9]+ passed' "$log" | grep -oE '[0-9]+' | awk '{s+=$1} END {print s+0}')"
min="${CAPTURE_RUNTIME_MIN_TESTS:-1}"
if [[ "$passed" -lt "$min" ]]; then
  echo "::error title=Capture runtime checks did not run::$passed test(s) executed, expected at least $min. Was --ignored dropped or the filter renamed?"
  exit 1
fi
echo "capture runtime checks: $passed test(s) executed"
