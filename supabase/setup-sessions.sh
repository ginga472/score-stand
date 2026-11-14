#!/usr/bin/env bash
# One-time setup for Woodshed session sync and the reviewer (Claude) account, run on the Mac.
#   ./supabase/setup-sessions.sh reviewer EMAIL   puts a new random password on the clipboard (never printed)
#                                                 and opens Supabase > Authentication > Users:
#                                                 Add user > Create new user, EMAIL + paste, Auto Confirm on
#   ./supabase/setup-sessions.sh sql EMAIL        copies sessions.sql (with EMAIL filled in) and opens the
#                                                 SQL editor: paste, Run. It links the reviewer to your account.
#   ./supabase/setup-sessions.sh inbox            copies score-inbox.sql and opens the SQL editor: paste, Run.
#                                                 Lets the reviewer add new scores (add-only).
# To revoke the reviewer, delete that user in Supabase (its link goes with it).
# To rotate its password, run `reviewer` again and reset the password on that user.
set -euo pipefail
cd "$(dirname "$0")/.."
REF=wmaofvonemfhqsyfesof
EMAIL="${2:-}"
if [ "${1:-}" = inbox ]; then
  pbcopy < supabase/score-inbox.sql
  open "https://supabase.com/dashboard/project/$REF/sql/new"
  echo "score-inbox.sql is on the clipboard. In the SQL editor that just opened: paste, then Run."
  exit 0
fi
[[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { sed -n 2,11p "$0"; exit 1; }

case "${1:-}" in
  reviewer)
    openssl rand -base64 36 | tr -d '\n/+=' | pbcopy
    open "https://supabase.com/dashboard/project/$REF/auth/users"
    echo "A new password is on the clipboard. Add user > Create new user: $EMAIL, paste the password, Auto Confirm on."
    ;;
  sql)
    sed "s/{{REVIEWER_EMAIL}}/$EMAIL/" supabase/sessions.sql | pbcopy
    open "https://supabase.com/dashboard/project/$REF/sql/new"
    echo "sessions.sql is on the clipboard. In the SQL editor that just opened: paste, then Run."
    ;;
  *)
    sed -n 2,11p "$0"; exit 1 ;;
esac
