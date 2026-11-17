#!/usr/bin/env bash
# Use the real provider and a local fake API to verify that importing the existing Host
# does not change, recreate or reinstall it.
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'kill "${API_PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=fake-ca \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign \
  -keyout "$WORK/ca.key" -out "$WORK/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj /CN=developers.hostinger.com \
  -keyout "$WORK/srv.key" -out "$WORK/srv.csr" 2>/dev/null
openssl x509 -req -days 1 -in "$WORK/srv.csr" -CA "$WORK/ca.pem" -CAkey "$WORK/ca.key" -CAcreateserial \
  -extfile <(printf 'subjectAltName=DNS:developers.hostinger.com\nextendedKeyUsage=serverAuth\n') \
  -out "$WORK/srv.pem" 2>/dev/null

python3 -I "$TESTS/fake_hostinger_api.py" "$WORK" "$WORK/port" "$WORK/api.log" &
API_PID=$!
for _ in $(seq 50); do [ -s "$WORK/port" ] && break; sleep 0.1; done

# Same configuration, with local state instead of the R2 backend.
mkdir "$WORK/tofu"
cp "$TESTS"/../{main.tf,variables.tf,.terraform.lock.hcl} "$WORK/tofu/"
python3 -I -c 'import re,sys; p=sys.argv[1]; s=open(p).read(); open(p,"w").write(re.sub(r"  backend \"s3\" \{.*?\n  \}\n", "", s, flags=re.S))' "$WORK/tofu/main.tf"
cd "$WORK/tofu"
export TF_IN_AUTOMATION=1 TF_INPUT=0 TF_VAR_state_passphrase=test-passphrase-not-secret
tofu init >/dev/null

# From here onward, all Hostinger calls go to the fake API.
export HTTPS_PROXY="http://127.0.0.1:$(cat "$WORK/port")" NO_PROXY= no_proxy=
export SSL_CERT_FILE="$WORK/ca.pem" HOSTINGER_API_TOKEN=fake
export TF_VAR_data_center_id=17
# Template differs from the installed one: without ignore_changes, it would reinstall the system.
export TF_VAR_template_id=9999

tofu import hostinger_vps.host 777 >/dev/null
# The previous partial apply left the SSH key and Host ssh_key_ids in state: the
# update failed after the provider had written the planned value. Without
# ignore_changes, the plan would remove it; without the removed block, it would destroy the key.
tofu state pull | python3 -I -c '
import json, sys
s = json.load(sys.stdin); s["serial"] += 1
for r in s["resources"]:
    if r["type"] == "hostinger_vps":
        r["instances"][0]["attributes"]["ssh_key_ids"] = [123]
s["resources"].append({"mode": "managed", "type": "hostinger_vps_ssh_key", "name": "host",
    "provider": "provider[\"registry.opentofu.org/hostinger/hostinger\"]",
    "instances": [{"schema_version": 0, "attributes": {"id": "123", "name": "dangus-host", "key": "ssh-ed25519 AAAA test"}}]})
json.dump(s, sys.stdout)' > "$WORK/state.json"
tofu state push "$WORK/state.json" >/dev/null
tofu plan -out=plan.tfplan >/dev/null
tofu show -json plan.tfplan > "$WORK/plan.json"
key_actions=$(python3 -I -c '
import json, sys
for c in json.load(open(sys.argv[1]))["resource_changes"]:
    if c["address"] == "hostinger_vps_ssh_key.host":
        print(",".join(c["change"]["actions"]))' "$WORK/plan.json")
changes=$(python3 -I -c '
import json, sys
for c in json.load(open(sys.argv[1]))["resource_changes"]:
    if c["address"] == "hostinger_vps.host":
        ch = c["change"]
        before, after, unknown = ch["before"], ch["after"], ch["after_unknown"]
        changed = sorted(k for k in after.keys() | unknown.keys() if before.get(k) != after.get(k) or unknown.get(k))
        print(",".join(ch["actions"]) + ":" + ",".join(changed))' "$WORK/plan.json")

fail=0
# No Host changes are acceptable.
[ "$changes" = "no-op:" ] || { echo "FAIL: planned Host changes: '$changes' (expected: no-op:)"; fail=1; }
# The key leaves only the state; the deletion API is not called.
[ "$key_actions" = "forget" ] || { echo "FAIL: old SSH key has actions '$key_actions' (expected: forget)"; fail=1; }
if grep -v '^GET ' "$WORK/api.log"; then echo "FAIL: calls above are not read-only"; fail=1; fi
[ "$fail" = 0 ] && echo "ok: imported existing Host without recreating or reinstalling"
exit "$fail"
