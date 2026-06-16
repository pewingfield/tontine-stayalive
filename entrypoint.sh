#!/bin/sh
# Runs inside the published Playwright image (browsers already baked in).
# Installs the one JS dependency into the bind-mounted /app, then starts.
set -e
cd /app
# Browsers are preinstalled in the image, so don't re-download them.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
if [ ! -d node_modules/playwright ]; then
  echo "[entrypoint] installing node deps..."
  npm install --omit=dev --no-audit --no-fund
fi
exec node stay-alive.js
