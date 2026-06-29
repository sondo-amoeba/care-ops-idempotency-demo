#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
PATIENT_ID="${PATIENT_ID:-storm-patient-001}"
PROGRAM_ID="${PROGRAM_ID:-behavioral-health-outreach}"
WINDOW_START="${WINDOW_START:-2026-06-23T17:00:00.000Z}"

echo "Creating interaction..."
INTERACTION_ID=$(curl -sf "$API_URL/care-ops/interactions" \
  -H 'Content-Type: application/json' \
  -d "{\"patientId\":\"$PATIENT_ID\",\"programId\":\"$PROGRAM_ID\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

echo "Interaction: $INTERACTION_ID"
echo "Firing 50 identical agent-workflow sends..."

DUPLICATES=0
for i in $(seq 1 50); do
  DUPLICATE=$(curl -sf "$API_URL/care-ops/agent-workflow/trigger-sms" \
    -H 'Content-Type: application/json' \
    -d "{\"interactionId\":\"$INTERACTION_ID\",\"patientId\":\"$PATIENT_ID\",\"programId\":\"$PROGRAM_ID\",\"templateId\":\"storm-script\",\"body\":\"Storm from shell\",\"windowStart\":\"$WINDOW_START\"}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("duplicate", False))')
  if [[ "$DUPLICATE" == "True" ]]; then
    DUPLICATES=$((DUPLICATES + 1))
  fi
done

MESSAGE_COUNT=$(curl -sf "$API_URL/care-ops/interactions/$INTERACTION_ID" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len([m for m in d.get("messages",[]) if m.get("direction")=="outbound"]))')

echo "Duplicates blocked: $DUPLICATES / 50"
echo "Outbound messages persisted: $MESSAGE_COUNT"

if [[ "$MESSAGE_COUNT" -ne 1 ]]; then
  echo "FAIL: expected exactly 1 outbound message" >&2
  exit 1
fi

echo "PASS: write path collapsed 50 replays to a single outbound row (status: pending)"

# --- ADR-0006: prove DELIVERY safety, not just write safety ---
# The single pending row is drained out-of-band by the relay (the sole carrier
# caller). The request path never submitted inline.
echo
echo "Draining the outbox relay (interaction-scoped)..."
SUBMITTED=$(curl -sf "$API_URL/care-ops/relay/drain" \
  -H 'Content-Type: application/json' \
  -d "{\"interactionIds\":[\"$INTERACTION_ID\"]}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("submitted", 0))')

STATUS=$(curl -sf "$API_URL/care-ops/interactions/$INTERACTION_ID" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((m["status"] for m in d.get("messages",[]) if m.get("direction")=="outbound"), "none"))')

echo "Relay submitted: $SUBMITTED"
echo "Outbound row status after drain: $STATUS"

if [[ "$SUBMITTED" -ne 1 || "$STATUS" != "queued" ]]; then
  echo "FAIL: expected the relay to submit exactly 1 row (pending -> queued)" >&2
  exit 1
fi

echo "PASS: relay drained the one row to the carrier (pending -> submitting -> queued)"
