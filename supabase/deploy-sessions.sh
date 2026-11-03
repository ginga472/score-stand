#!/usr/bin/env bash
# One-time setup for Woodshed session sync, run on the Mac.
#   ./supabase/deploy-sessions.sh sql      copies sessions.sql and opens the Supabase SQL editor: paste, Run
#   ./supabase/deploy-sessions.sh deploy   deploys the claude-sessions function with a fresh key,
#                                          and puts the key on the clipboard (it is never printed)
# Re-running `deploy` rotates the key, which locks out the old one.
set -euo pipefail
cd "$(dirname "$0")/.."
REF=wmaofvonemfhqsyfesof

case "${1:-}" in
  sql)
    pbcopy < supabase/sessions.sql
    open "https://supabase.com/dashboard/project/$REF/sql/new"
    echo "sessions.sql is on the clipboard. In the SQL editor that just opened: paste, then Run."
    ;;
  deploy)
    command -v supabase >/dev/null || { echo "Install the Supabase CLI first: brew install supabase/tap/supabase"; exit 1; }
    supabase projects list >/dev/null 2>&1 || supabase login
    supabase functions deploy claude-sessions --project-ref "$REF" --no-verify-jwt
    KEY=$(openssl rand -hex 32)
    supabase secrets set --project-ref "$REF" "CLAUDE_SESSIONS_KEY=$KEY" >/dev/null
    printf %s "$KEY" | pbcopy
    unset KEY
    echo "Deployed. Claude's key is on the clipboard: save it as the CLAUDE_SESSIONS_KEY secret in Claude's environment settings."
    ;;
  *)
    sed -n 2,6p "$0"; exit 1 ;;
esac
