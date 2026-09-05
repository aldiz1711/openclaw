#!/usr/bin/env bash
set -euo pipefail

# Invoked only inside the secretless CI container. The host Docker socket,
# runner directory, and user home are never mounted into this container.
mkdir -p /tmp/proof-home
export HOME=/tmp/proof-home
export CI=1
export OPENCLAW_VITEST_MAX_WORKERS=1
export OPENCLAW_E2E_VERBOSE=1

test "$(node -p 'require("./package.json").packageManager.split("+")[0]')" = pnpm@11.22.0
npm install --global pnpm@11.22.0
pnpm install --frozen-lockfile 2>&1 | tee /results/install.log

set +e
node scripts/run-vitest.mjs run --config test/vitest/vitest.e2e.config.ts \
  test/e2e/qa-lab/runtime/pr131462-heartbeat-proof.e2e.test.ts \
  2>&1 | tee /results/gateway.log
proof_exit=${PIPESTATUS[0]}
set -e
printf '%s\n' "$proof_exit" > /results/test-exit-code.txt

# The pre-fix process must fail only after observing the reported boundary
# failure. Installation, startup, provider-protocol, and timeout failures fail CI.
node /proof/verify-proof.mjs "$PROOF_VARIANT" "$PROOF_REVISION" "$proof_exit"
