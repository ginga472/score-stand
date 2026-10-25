#!/usr/bin/env bash
# Probes the Supabase project the way a stranger would: with only the public
# URL and publishable key, and no sign-in. Every check should PASS.
# Usage: ./supabase/check-security.sh
set -u
URL=$(sed -n "s/^export const SUPABASE_URL = '\(.*\)';/\1/p" "$(dirname "$0")/../js/config.js")
KEY=$(sed -n "s/^export const SUPABASE_KEY = '\(.*\)';/\1/p" "$(dirname "$0")/../js/config.js")
fail=0
check() { # name, expectation, actual
  if [[ "$3" =~ $2 ]]; then echo "PASS  $1"; else echo "FAIL  $1 -> $3"; fail=1; fi
}
for t in scores ink setlists spots; do
  out=$(curl -s -w ' %{http_code}' "$URL/rest/v1/$t?select=*" -H "apikey: $KEY")
  check "anonymous read of $t returns nothing" '^(\[\] 200|.* 40[0-9])$' "$out"
done
out=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/rest/v1/scores" -H "apikey: $KEY" -H 'Content-Type: application/json' \
  -d '{"id":"00000000-0000-0000-0000-000000000001","title":"probe","page_count":1,"updated_ms":1}')
check "anonymous insert is refused" '^40[0-9]$' "$out"
out=$(curl -s -w ' %{http_code}' -X POST "$URL/storage/v1/object/list/scores" -H "apikey: $KEY" -H 'Content-Type: application/json' -d '{"prefix":""}')
check "anonymous bucket listing returns nothing" '^(\[\] 200|.* 40[0-9])$' "$out"
out=$(curl -s -o /dev/null -w '%{http_code}' "$URL/storage/v1/object/public/scores/anything.pdf")
check "bucket is not public" '^40[0-9]$' "$out"
out=$(curl -s -w ' %{http_code}' -X POST "$URL/auth/v1/signup" -H "apikey: $KEY" -H 'Content-Type: application/json' \
  -d "{\"email\":\"probe-$RANDOM@example.com\",\"password\":\"Probe-$RANDOM-$RANDOM-long-password\"}")
check "sign-ups are disabled" '(signup_disabled|Signups not allowed|not allowed).* 4[0-9][0-9]$' "$out"
[ $fail = 0 ] && echo "All checks passed." || { echo "Some checks FAILED. Don't sync real data until fixed."; exit 1; }
