#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun run --bun vite build --config apps/web/vite.config.ts >/dev/null
UMAMI_WEBSITE_ID=test-site PORT=32819 bun run apps/web/server.ts &
pid=$!
cleanup() { kill "$pid" 2>/dev/null || true; }
trap cleanup EXIT
for _ in {1..30}; do
  html=$(curl -fsS http://127.0.0.1:32819/ 2>/dev/null) && break
  sleep 1
done
[[ "$html" == *'src="/t.js"'* && "$html" == *'data-website-id="test-site"'* && "$html" != *'analytics.dangus-box.com'* ]]
echo 'HTML do Produto usa /t.js e não aponta ao domínio analytics OK'
