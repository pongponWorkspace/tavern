#!/usr/bin/env bash
# Keep asking Oracle Cloud for an Always Free ARM server until capacity frees up.
#
#   ./scripts/oracle-create-server.sh            # 2 OCPU / 12 GB / 100 GB disk
#   OCPUS=1 MEMORY=6 ./scripts/oracle-create-server.sh
#
# Needs: OCI CLI configured (`oci setup config`) and ~/.ssh/tavern-oracle.pub.
# Stays inside Always Free limits and refuses anything bigger, so a Free Tier
# account can't be charged. Only "out of capacity" (and rate limits) are retried;
# any other error stops the script so it never loops on a real problem.

set -euo pipefail

NAME="${NAME:-tavern}"
OCPUS="${OCPUS:-2}"
MEMORY="${MEMORY:-12}"
BOOT_GB="${BOOT_GB:-100}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/tavern-oracle.pub}"
INTERVAL="${INTERVAL:-60}"
SHAPE="VM.Standard.A1.Flex"

say() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
notify() { command -v osascript >/dev/null && osascript -e "display notification \"$1\" with title \"Oracle server\"" || true; }

# ── Guard rails: Always Free allows up to 2 OCPU / 12 GB on A1 (since June 2026) and 200 GB of block storage.
command -v oci >/dev/null || die "OCI CLI not found. Install it with: brew install oci-cli"
[ -f "$SSH_KEY" ] || die "SSH public key not found at $SSH_KEY (create it with: ssh-keygen -t ed25519 -f ~/.ssh/tavern-oracle)"
awk "BEGIN{exit !($OCPUS >= 1 && $OCPUS <= 2)}" || die "OCPUS must be 1 or 2 to stay free"
awk "BEGIN{exit !($MEMORY >= 1 && $MEMORY <= 12)}" || die "MEMORY must be 12 GB or less to stay free"
awk "BEGIN{exit !($BOOT_GB >= 50 && $BOOT_GB <= 200)}" || die "BOOT_GB must be between 50 and 200 to stay free"

# ── Look up everything from your OCI config, so nothing is hard-coded.
TENANCY="$(awk -F= '/^tenancy=/{print $2; exit}' "${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}")"
[ -n "$TENANCY" ] || die "No tenancy in ~/.oci/config. Run: oci setup config"
COMPARTMENT="${COMPARTMENT:-$TENANCY}"

say "Checking your Oracle account…"
AD="$(oci iam availability-domain list --compartment-id "$TENANCY" --query 'data[0].name' --raw-output)" \
  || die "Couldn't reach Oracle. Check that your API key is uploaded (Profile → API keys)."
IMAGE="$(oci compute image list --compartment-id "$COMPARTMENT" \
  --operating-system "Canonical Ubuntu" --operating-system-version "24.04" --shape "$SHAPE" \
  --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' --raw-output)"
[ -n "$IMAGE" ] && [ "$IMAGE" != "null" ] || die "No Ubuntu 24.04 ARM image found in this region"
SUBNET="${SUBNET:-$(oci network subnet list --compartment-id "$COMPARTMENT" \
  --query 'data[?"prohibit-public-ip-on-vnic"==`false`] | [0].id' --raw-output)}"
[ -n "$SUBNET" ] && [ "$SUBNET" != "null" ] || die "No public subnet yet. In the console: Networking → Virtual cloud networks → Start VCN Wizard → \"Create VCN with Internet Connectivity\", then run this again."

EXISTING="$(oci compute instance list --compartment-id "$COMPARTMENT" --display-name "$NAME" \
  --query 'data[?"lifecycle-state"!=`TERMINATED`] | [0].id' --raw-output 2>/dev/null || true)"
[ -z "$EXISTING" ] || [ "$EXISTING" = "null" ] || die "A server named \"$NAME\" already exists ($EXISTING). Nothing to do."

say "Region AD: $AD"
say "Asking for $SHAPE with $OCPUS OCPU / ${MEMORY} GB RAM / ${BOOT_GB} GB disk, Ubuntu 24.04. Trying every ${INTERVAL}s — press Ctrl+C to stop."

attempt=0
while :; do
  attempt=$((attempt + 1))
  set +e
  OUT="$(oci compute instance launch \
    --availability-domain "$AD" \
    --compartment-id "$COMPARTMENT" \
    --shape "$SHAPE" \
    --shape-config "{\"ocpus\": $OCPUS, \"memoryInGBs\": $MEMORY}" \
    --image-id "$IMAGE" \
    --subnet-id "$SUBNET" \
    --assign-public-ip true \
    --display-name "$NAME" \
    --boot-volume-size-in-gbs "$BOOT_GB" \
    --ssh-authorized-keys-file "$SSH_KEY" \
    --query 'data.id' --raw-output 2>&1)"
  STATUS=$?
  set -e

  if [ $STATUS -eq 0 ] && [[ "$OUT" == ocid1.instance.* ]]; then
    INSTANCE="$OUT"
    say "Got one (attempt $attempt). Waiting for it to start…"
    oci compute instance get --instance-id "$INSTANCE" --wait-for-state RUNNING --max-wait-seconds 900 >/dev/null
    IP="$(oci compute instance list-vnics --instance-id "$INSTANCE" --query 'data[0]."public-ip"' --raw-output)"
    say "Server is running. Public IP: $IP"
    cat <<EOF

Add this to ~/.ssh/config, then run:  ssh tavern 'uname -m'

Host tavern
  HostName $IP
  User ubuntu
  IdentityFile ${SSH_KEY%.pub}

EOF
    notify "Server ready: $IP"
    exit 0
  fi

  if grep -qiE "out of (host )?capacity|OutOfCapacity|InternalError" <<<"$OUT"; then
    say "Attempt $attempt: no capacity yet. Next try in ${INTERVAL}s."
    sleep "$INTERVAL"
  elif grep -qiE "TooManyRequests|429" <<<"$OUT"; then
    say "Attempt $attempt: Oracle asked us to slow down. Waiting $((INTERVAL * 3))s."
    sleep $((INTERVAL * 3))
  else
    die "Oracle refused for another reason (not capacity) — stopping:
$OUT"
  fi
done
