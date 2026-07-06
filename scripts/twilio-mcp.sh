#!/bin/sh
# Launches the official Twilio MCP server (@twilio-alpha/mcp), authenticated
# against this project's Twilio account. Credentials are read from
# .env.local at runtime so they never appear in Claude Code's MCP config.
#
# We vendor-install the server into ./twilio-mcp instead of `npx -y` so we
# can patch its bundled OpenAPI spec before every launch: several of Twilio's
# list-filter params are literally named e.g. "DateCreated<" / "StartTime>",
# which Anthropic's tool-schema validation rejects outright — and rejects the
# WHOLE tool list for, not just that one tool. See patch-spec.mjs.
set -eu

DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$DIR/.env.local"
VENDOR_DIR="$DIR/scripts/twilio-mcp"

if [ ! -f "$ENV_FILE" ]; then
  echo "twilio-mcp: missing $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${TWILIO_ACCOUNT_SID:?TWILIO_ACCOUNT_SID not set in .env.local}"
: "${TWILIO_API_KEY_SID:?TWILIO_API_KEY_SID not set in .env.local}"
: "${TWILIO_API_KEY_SECRET:?TWILIO_API_KEY_SECRET not set in .env.local}"

if [ ! -d "$VENDOR_DIR/node_modules/@twilio-alpha/mcp" ]; then
  npm install --prefix "$VENDOR_DIR" --no-audit --no-fund --silent
fi
node "$VENDOR_DIR/patch-spec.mjs" >&2

exec node "$VENDOR_DIR/node_modules/@twilio-alpha/mcp/build/index.js" \
  "$TWILIO_ACCOUNT_SID/$TWILIO_API_KEY_SID:$TWILIO_API_KEY_SECRET"
