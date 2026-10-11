#!/usr/bin/env bash
# End-to-end test of the deployed resume pipeline:
#   GET /upload-url -> PUT to S3 -> poll GET /resume/{id}
#
# Usage: TOKEN='<Clerk session JWT>' bash scripts/e2e.sh
# Clerk session tokens expire in ~60s; get a fresh one right before running
# (browser console on applyfy.net: await window.Clerk.session.getToken()).
# Requires: curl, jq, python3. The token is never printed.

set -u

API="${API:-https://bz3c5dnkce.execute-api.us-east-1.amazonaws.com/prod}"
PDF=/tmp/applyfy-e2e-resume.pdf

# 1. Require TOKEN
if [ -z "${TOKEN:-}" ]; then
  echo "Error: TOKEN env var is required (Clerk session JWT)." >&2
  echo "Usage: TOKEN='<token>' bash scripts/e2e.sh" >&2
  exit 1
fi
AUTH_HEADER="Authorization: Bearer $TOKEN"

for bin in curl jq python3; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Error: $bin is required but not installed." >&2
    exit 1
  fi
done

# 2. Minimal valid PDF with 3 lines of selectable text (correct xref offsets)
python3 - "$PDF" <<'PY'
import sys
lines = ["Jane Doe - Software Engineer",
         "Skills: TypeScript, AWS Lambda, DynamoDB, S3",
         "Built a serverless resume parsing pipeline with AWS CDK"]
ops = ["BT", "/F1 12 Tf", "72 720 Td", "16 TL"]
for l in lines:
    ops.append("(" + l.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ") Tj T*")
ops.append("ET")
stream = "\n".join(ops).encode()
objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
out = bytearray(b"%PDF-1.4\n")
offs = []
for i, o in enumerate(objs, 1):
    offs.append(len(out))
    out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for off in offs:
    out += b"%010d 00000 n \n" % off
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
open(sys.argv[1], "wb").write(out)
PY
echo "Created $PDF ($(wc -c < "$PDF" | tr -d ' ') bytes)"

# 3. Get a pre-signed upload URL
RES=$(curl -s -w '\n%{http_code}' -H "$AUTH_HEADER" "$API/upload-url?filename=test.pdf")
URL_STATUS=$(printf '%s\n' "$RES" | tail -n1)
URL_BODY=$(printf '%s\n' "$RES" | sed '$d')
echo "GET /upload-url status: $URL_STATUS"
UPLOAD_URL=$(printf '%s' "$URL_BODY" | jq -r '.uploadUrl // empty' 2>/dev/null)
KEY=$(printf '%s' "$URL_BODY" | jq -r '.key // empty' 2>/dev/null)
if [ "$URL_STATUS" != "200" ] || [ -z "$UPLOAD_URL" ] || [ -z "$KEY" ]; then
  echo "upload-url failed. Response body:"
  echo "$URL_BODY"
  exit 1
fi
echo "key: $KEY"

# 4. PUT the PDF directly to S3 (the pre-signed URL is the auth; no Bearer header)
PUT_OUT=$(mktemp)
PUT_STATUS=$(curl -s -o "$PUT_OUT" -w '%{http_code}' -X PUT \
  -H 'Content-Type: application/pdf' --upload-file "$PDF" "$UPLOAD_URL")
echo "PUT status: $PUT_STATUS"
if [ "$PUT_STATUS" != "200" ]; then
  echo "PUT error body:"
  cat "$PUT_OUT"; echo
  rm -f "$PUT_OUT"
  exit 2
fi
rm -f "$PUT_OUT"

# 5. Wait, then poll GET /resume/{id} (404 = not parsed yet)
sleep 3
ENC_KEY=$(jq -rn --arg k "$KEY" '$k|@uri')
GET_STATUS=""
GET_BODY=""
for i in $(seq 0 15); do
  R=$(curl -s -w '\n%{http_code}' -H "$AUTH_HEADER" "$API/resume/$ENC_KEY")
  GET_STATUS=$(printf '%s\n' "$R" | tail -n1)
  GET_BODY=$(printf '%s\n' "$R" | sed '$d')
  [ "$GET_STATUS" != "404" ] && break
  [ "$i" -lt 15 ] || break
  echo "  GET /resume attempt $((i + 1)): 404, retrying in 1s..."
  sleep 1
done

# 6. Summary
echo
echo "=== Summary ==="
echo "PUT status:       $PUT_STATUS"
echo "Final GET status: $GET_STATUS"
echo "JSON response:"
printf '%s\n' "$GET_BODY" | jq . 2>/dev/null || printf '%s\n' "$GET_BODY"
[ "$GET_STATUS" = "200" ] || exit 3
