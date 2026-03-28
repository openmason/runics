#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# Provision Production Resources — Runics Registry
# ══════════════════════════════════════════════════════════════════════════════
#
# Creates all Cloudflare resources needed for the production deployment
# on the cognium account, then prints the IDs to paste into
# wrangler.production.toml.
#
# Prerequisites:
#   - wrangler CLI authenticated to the cognium account
#   - A Neon production database already created (with migrations applied)
#
# Usage:
#   bash scripts/provision-production.sh
#
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

CONFIG="-c wrangler.production.toml"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo " Runics Production Provisioning"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""

# ── Pre-flight checks ────────────────────────────────────────────────────────

echo "Checking wrangler authentication..."
WHOAMI=$(wrangler whoami 2>&1) || { echo -e "${RED}ERROR: wrangler not authenticated. Run 'wrangler login' first.${NC}"; exit 1; }
echo "$WHOAMI"
echo ""

if ! echo "$WHOAMI" | grep -qi "cognium"; then
  echo -e "${YELLOW}WARNING: Account does not appear to be 'cognium'.${NC}"
  echo "Make sure you're authenticated to the correct account."
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo ""
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

echo ""
echo "── Step 1: KV Namespaces ─────────────────────────────────────────────────"
echo ""

echo "Creating SEARCH_CACHE..."
wrangler kv namespace create SEARCH_CACHE 2>&1 | tee /tmp/runics-kv-cache.txt
CACHE_ID=$(grep -oP 'id = "\K[^"]+' /tmp/runics-kv-cache.txt || echo "PARSE_FAILED")
echo ""

echo "Creating COGNIUM_JOBS..."
wrangler kv namespace create COGNIUM_JOBS 2>&1 | tee /tmp/runics-kv-jobs.txt
JOBS_ID=$(grep -oP 'id = "\K[^"]+' /tmp/runics-kv-jobs.txt || echo "PARSE_FAILED")
echo ""

echo ""
echo "── Step 2: R2 Bucket ─────────────────────────────────────────────────────"
echo ""

echo "Creating runics-skills bucket..."
wrangler r2 bucket create runics-skills 2>&1 || echo "(may already exist)"
echo ""

echo ""
echo "── Step 3: Queues ────────────────────────────────────────────────────────"
echo ""

for Q in runics-embed runics-cognium-v2 runics-cognium-poll-v2 cognium-dlq cognium-poll-dlq; do
  echo "Creating queue: $Q"
  wrangler queues create "$Q" 2>&1 || echo "  (may already exist)"
done
echo ""

echo ""
echo "── Step 4: Hyperdrive ────────────────────────────────────────────────────"
echo ""

echo -e "${YELLOW}Hyperdrive requires a Neon connection string.${NC}"
echo "If you haven't created the production Neon DB yet, do that first:"
echo "  → https://console.neon.tech → New Project"
echo "  → Run migrations: psql <connection-string> -f src/db/migrations/0001_*.sql ..."
echo ""
read -p "Enter production Neon POOLER connection string (or 'skip'): " NEON_CONN

if [ "$NEON_CONN" != "skip" ] && [ -n "$NEON_CONN" ]; then
  echo "Creating Hyperdrive..."
  wrangler hyperdrive create runics-production --connection-string "$NEON_CONN" 2>&1 | tee /tmp/runics-hyperdrive.txt
  HD_ID=$(grep -oP 'id = "\K[^"]+' /tmp/runics-hyperdrive.txt || echo "PARSE_FAILED")
else
  echo "Skipping Hyperdrive — create manually later:"
  echo '  wrangler hyperdrive create runics-production --connection-string "postgresql://..."'
  HD_ID="TODO"
fi
echo ""

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo " Resource IDs — paste these into wrangler.production.toml"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""
echo "  SEARCH_CACHE KV:    ${CACHE_ID}"
echo "  COGNIUM_JOBS KV:    ${JOBS_ID}"
echo "  HYPERDRIVE:         ${HD_ID}"
echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo ""
echo "  1. Paste the IDs above into wrangler.production.toml (replace the TODOs)"
echo "  2. Set NEON_CONNECTION_STRING in wrangler.production.toml (direct, non-pooler URL)"
echo "  3. Deploy:  npm run deploy:production"
echo "  4. Set secrets:"
echo "       wrangler secret put ADMIN_API_KEY $CONFIG"
echo "       wrangler secret put COGNIUM_API_KEY $CONFIG"
echo "       wrangler secret put ACTIVEPIECES_WEBHOOK_URL $CONFIG"
echo "  5. Add DNS record for api.runics.net:"
echo "       CNAME  api  →  runics.cognium.workers.dev  (proxied)"
echo "  6. Verify:  curl https://api.runics.net/health"
echo ""
