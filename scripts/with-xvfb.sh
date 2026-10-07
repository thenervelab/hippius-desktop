#!/usr/bin/env bash
# Run a command against a fresh virtual X display (Xvfb), started without a
# race.
#
#   scripts/with-xvfb.sh [-s "<Xvfb screen args>"] -- command [args...]
#
# Replaces `xvfb-run -a` in CI. xvfb-run picks a display and then guesses
# when the server is up; on a busy runner a test sometimes connected first
# and failed with "Could not reach the X server: Connection reset by peer"
# on code that passed on the next run. Xvfb's own `-displayfd` writes the
# display number only once the server accepts connections, so the command
# never starts before the display is ready.
#
# `-noreset` keeps the server up between clients. Without it Xvfb resets
# itself each time its last client disconnects, and a test that opens one
# connection after another (list the displays, grab one, grab the root,
# read the pointer) could connect during that reset and see "Connection
# reset by peer", or get no pointer back. A desktop always has a client
# connected (the window manager), so it never resets under the app.
set -euo pipefail

screen_args=(-screen 0 1280x720x24)
if [[ "${1:-}" == "-s" ]]; then
  read -r -a screen_args <<< "${2:?-s needs the Xvfb screen arguments}"
  shift 2
fi
[[ "${1:-}" == "--" ]] && shift
(( $# > 0 )) || { echo "usage: $0 [-s \"<Xvfb args>\"] -- command [args...]" >&2; exit 2; }

dir="$(mktemp -d)"
Xvfb -displayfd 3 -nolisten tcp -noreset "${screen_args[@]}" 3> "${dir}/display" 2> "${dir}/xvfb.log" &
xvfb_pid=$!
cleanup() {
  kill "${xvfb_pid}" 2> /dev/null || true
  wait "${xvfb_pid}" 2> /dev/null || true
  rm -rf "${dir}"
}
trap cleanup EXIT

for _ in $(seq 300); do
  [[ -s "${dir}/display" ]] && break
  if ! kill -0 "${xvfb_pid}" 2> /dev/null; then
    echo "Xvfb exited before it was ready:" >&2
    cat "${dir}/xvfb.log" >&2
    exit 1
  fi
  sleep 0.1
done
display="$(tr -dc '0-9' < "${dir}/display")"
if [[ -z "${display}" ]]; then
  echo "Xvfb did not report a display within 30 s:" >&2
  cat "${dir}/xvfb.log" >&2
  exit 1
fi
export DISPLAY=":${display}"
echo "Xvfb ready on ${DISPLAY}" >&2

"$@"
