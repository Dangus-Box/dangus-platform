#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/infra/backup" "$tmp/infra/tofu" "$tmp/bin"
cp "$root"/infra/backup/*.sh "$tmp/infra/backup/"
export PATH="$tmp/bin:$PATH" OPS_PROJECT_ID=ops FAKE_STORE="$tmp/store.json"
printf '{}\n' > "$FAKE_STORE"
cat > "$tmp/bin/bws" <<'BWS'
#!/usr/bin/env python3
import json, os, sys
path = os.environ['FAKE_STORE']
a = sys.argv[1:]
with open(path) as f: data = json.load(f)
if os.environ.get('FAKE_BWS_FAIL') == a[1]: sys.exit(1)
if a[:2] == ['secret', 'list']:
 print(json.dumps([{'key': k, 'id': k} for k in data]))
elif a[:2] == ['secret', 'get']:
 print(json.dumps({'value': data[a[2]]}))
elif a[:2] == ['secret', 'create']:
 assert a[2] not in data
 data[a[2]] = a[3]
 with open(path, 'w') as f: json.dump(data, f)
else: sys.exit(1)
BWS
cat > "$tmp/bin/tofu" <<'TOFU'
#!/usr/bin/env bash
case "$3" in
  r2_backup_access_key_id) printf 'test-id' ;;
  r2_backup_secret_access_key) printf 'test-secret' ;;
  *) exit 1 ;;
esac
TOFU
cat > "$tmp/bin/age-keygen" <<'AGE'
#!/usr/bin/env bash
printf '%s\n' '# public key: age1example' 'AGE-SECRET-KEY-EXAMPLE'
AGE
chmod +x "$tmp/bin/"*
"$tmp/infra/backup/copy-r2-credentials.sh"
"$tmp/infra/backup/copy-r2-credentials.sh"
jq -e '.ops__R2_BACKUP_ACCESS_KEY_ID == "test-id" and .ops__R2_BACKUP_SECRET_ACCESS_KEY == "test-secret"' "$FAKE_STORE" >/dev/null
jq '.ops__R2_BACKUP_SECRET_ACCESS_KEY = "different"' "$FAKE_STORE" > "$tmp/new" && mv "$tmp/new" "$FAKE_STORE"
if "$tmp/infra/backup/copy-r2-credentials.sh" 2>/dev/null; then exit 1; fi
"$tmp/infra/backup/generate-age-key.sh"
[[ $(cat "$tmp/infra/backup/age.pub") == age1example ]]
jq -e '.ops__BACKUP_AGE_PRIVATE_KEY | contains("AGE-SECRET-KEY-EXAMPLE")' "$FAKE_STORE" >/dev/null
# The public key also goes to BWS for Products that deploy from their own repositories.
jq -e '.ops__BACKUP_AGE_PUBLIC_KEY == "age1example"' "$FAKE_STORE" >/dev/null
if "$tmp/infra/backup/generate-age-key.sh" 2>/dev/null; then exit 1; fi
rm "$tmp/infra/backup/age.pub"
if "$tmp/infra/backup/generate-age-key.sh" 2>/dev/null; then exit 1; fi
# Failure to list BWS secrets must not create a second private key.
printf '{}\n' > "$FAKE_STORE"
if FAKE_BWS_FAIL=list "$tmp/infra/backup/generate-age-key.sh" 2>/dev/null; then exit 1; fi
[[ ! -e "$tmp/infra/backup/age.pub" ]] && jq -e '. == {}' "$FAKE_STORE" >/dev/null
# An existing public key in BWS prevents generating another pair.
printf '{"ops__BACKUP_AGE_PUBLIC_KEY":"age1old"}\n' > "$FAKE_STORE"
if "$tmp/infra/backup/generate-age-key.sh" 2>/dev/null; then exit 1; fi
[[ ! -e "$tmp/infra/backup/age.pub" ]] && jq -e 'has("ops__BACKUP_AGE_PRIVATE_KEY") | not' "$FAKE_STORE" >/dev/null
# A conflict in one secret prevents creating the other.
printf '{"ops__R2_BACKUP_SECRET_ACCESS_KEY":"different"}\n' > "$FAKE_STORE"
if "$tmp/infra/backup/copy-r2-credentials.sh" 2>/dev/null; then exit 1; fi
jq -e 'has("ops__R2_BACKUP_ACCESS_KEY_ID") | not' "$FAKE_STORE" >/dev/null
# No secret value appears in the output.
printf '{}\n' > "$FAKE_STORE"
out=$("$tmp/infra/backup/copy-r2-credentials.sh" 2>&1; "$tmp/infra/backup/generate-age-key.sh" 2>&1)
[[ $out != *test-secret* && $out != *AGE-SECRET-KEY* ]]
echo 'Scripts: creation, repetition, conflicts and overwrite protection passed.'
