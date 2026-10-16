#!/usr/bin/env bash
# Shared helpers for SeatRelay operational scripts (bash; the team's Windows machines can run these
# from Git Bash or WSL). Requires: aws CLI v2 (or v1), jq, node, pnpm.
set -euo pipefail
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-southeast-1}"
export AWS_PAGER=""
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STAGE="${STAGE:-dev}"

stack_output() { # stack_output <stack-name> <OutputKey>
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}
require() { command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1" >&2; exit 1; }; }
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
