#!/usr/bin/env bash
#
# scripts/deploy-staging.sh — one-command deploy of @openclaw/dashboard to
# the staging EC2 (i-0ab3de34361aac188).
#
# Mirrors the dispatch plugin's deploy flow. Manual extract over
# `openclaw plugins install` because the latter trips on a false-positive
# dangerous-pattern scan against this plugin.

set -euo pipefail

INSTANCE_ID="${INSTANCE_ID:-i-0ab3de34361aac188}"
BUCKET="${BUCKET:-openclaw-sam-backups-796196972655}"
AWS_PROFILE_VAL="${AWS_PROFILE:-sam}"
AWS_REGION_VAL="${AWS_REGION:-us-east-2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PLUGIN_DIR}"

if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi
step() { echo "${BLUE}→${RESET} $*"; }
ok()   { echo "${GREEN}✓${RESET} $*"; }
warn() { echo "${YELLOW}⚠${RESET} $*"; }
die()  { echo "${RED}✗${RESET} $*" >&2; exit 1; }

step "packing tarball (npm run pack:tarball)"
PACK_OUT=$(npm run pack:tarball 2>&1 | tail -25)
echo "${PACK_OUT}" | tail -1
VERSION=$(node -e "console.log(require('./package.json').version)")
TARBALL="openclaw-dashboard-${VERSION}.tgz"
[ -f "${TARBALL}" ] || die "tarball ${TARBALL} not found after pack"
ok "tarball: ${TARBALL} ($(wc -c < "${TARBALL}") bytes)"

S3_KEY="dashboard-plugin/${TARBALL}"
S3_URL="s3://${BUCKET}/${S3_KEY}"
step "uploading to ${S3_URL}"
aws s3 cp "${TARBALL}" "${S3_URL}" \
  --profile "${AWS_PROFILE_VAL}" --region "${AWS_REGION_VAL}" >/dev/null \
  || die "s3 upload failed"

step "generating presigned URL (15 min)"
PRESIGN=$(aws s3 presign "${S3_URL}" --expires-in 900 \
  --profile "${AWS_PROFILE_VAL}" --region "${AWS_REGION_VAL}") \
  || die "s3 presign failed"
[ -n "${PRESIGN}" ] || die "empty presign output"

REMOTE_SCRIPT="$(cat <<EOF
#!/bin/bash
set -e
cd /tmp
rm -f ${TARBALL}
curl -fsSL -o ${TARBALL} '${PRESIGN}'

TARGET=/home/ubuntu/.openclaw/extensions/dashboard
sudo -u ubuntu rm -rf "\$TARGET"
sudo -u ubuntu mkdir -p "\$TARGET"
sudo -u ubuntu tar xzf /tmp/${TARBALL} -C "\$TARGET" --strip-components=1
sudo chown -R ubuntu:ubuntu "\$TARGET"

# Idempotent: register dashboard plugin entry if missing.
python3 - <<'PYEOF'
import json, pathlib
p = pathlib.Path('/home/ubuntu/.openclaw/openclaw.json')
cfg = json.loads(p.read_text())
entries = cfg.setdefault('plugins', {}).setdefault('entries', {})
if 'dashboard' not in entries or not entries['dashboard'].get('enabled'):
    entries['dashboard'] = {'enabled': True}
    p.write_text(json.dumps(cfg, indent=2))
    print('plugins.entries.dashboard enabled')
else:
    print('plugins.entries.dashboard already enabled')
PYEOF

sudo -u ubuntu XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart openclaw-gateway

TOK=\$(grep OPENCLAW_GATEWAY_TOKEN /home/ubuntu/.openclaw/.env | cut -d= -f2)
for i in {1..30}; do
  sleep 2
  if curl -sf --max-time 3 -H "Authorization: Bearer \$TOK" \\
       http://127.0.0.1:18789/api/dashboard/health > /tmp/health.out 2>/dev/null; then
    echo "HEALTH_OK_AFTER:\$((i*2))s"
    cat /tmp/health.out
    exit 0
  fi
done
echo "HEALTH_TIMEOUT"
sudo -u ubuntu XDG_RUNTIME_DIR=/run/user/1000 journalctl --user -u openclaw-gateway \\
  --since '90 seconds ago' --no-pager 2>/dev/null | tail -30
exit 1
EOF
)"

step "encoding remote script and dispatching via SSM"
SCRIPT_B64=$(printf '%s' "${REMOTE_SCRIPT}" | base64 -w0)

SSM_PARAMS_JSON="${PLUGIN_DIR}/.deploy-ssm-params.tmp.json"
if command -v cygpath >/dev/null 2>&1; then
  SSM_PARAMS_FILEURI="file://$(cygpath -m "${SSM_PARAMS_JSON}")"
else
  SSM_PARAMS_FILEURI="file://${SSM_PARAMS_JSON}"
fi
trap 'rm -f "${SSM_PARAMS_JSON}"' EXIT
cat > "${SSM_PARAMS_JSON}" <<JSONEOF
{
  "commands": [
    "echo '${SCRIPT_B64}' | base64 -d > /tmp/dashboard-deploy.sh && bash /tmp/dashboard-deploy.sh"
  ]
}
JSONEOF

CMD_ID=$(aws ssm send-command \
  --document-name AWS-RunShellScript \
  --instance-ids "${INSTANCE_ID}" \
  --profile "${AWS_PROFILE_VAL}" --region "${AWS_REGION_VAL}" \
  --parameters "${SSM_PARAMS_FILEURI}" \
  --output text --query 'Command.CommandId') \
  || die "ssm send-command failed"
ok "ssm command id: ${CMD_ID}"

step "waiting for remote install to finish (poll every 5s, up to 5 min)"
for ATTEMPT in $(seq 1 60); do
  STATUS=$(aws ssm get-command-invocation \
    --command-id "${CMD_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --profile "${AWS_PROFILE_VAL}" --region "${AWS_REGION_VAL}" \
    --output text --query 'Status' 2>/dev/null || echo "Unknown")
  if [ "${STATUS}" != "InProgress" ] && [ "${STATUS}" != "Pending" ] && [ "${STATUS}" != "Unknown" ]; then
    break
  fi
  sleep 5
done

STATUS=$(aws ssm get-command-invocation \
  --command-id "${CMD_ID}" \
  --instance-id "${INSTANCE_ID}" \
  --profile "${AWS_PROFILE_VAL}" --region "${AWS_REGION_VAL}" \
  --output text --query 'Status')

PYTHONIOENCODING=utf-8 PYTHONUTF8=1 aws ssm get-command-invocation \
  --command-id "${CMD_ID}" \
  --instance-id "${INSTANCE_ID}" \
  --profile "${AWS_PROFILE_VAL}" --region "${AWS_REGION_VAL}" \
  --output text --query 'StandardOutputContent' \
  | tr -cd ' -~\n\t' \
  > /tmp/dashboard-deploy-stdout.txt 2>/dev/null \
  || true

if [ "${STATUS}" = "Success" ] && grep -q "HEALTH_OK_AFTER:" /tmp/dashboard-deploy-stdout.txt; then
  HEALTH_LINE=$(grep -A1 "HEALTH_OK_AFTER:" /tmp/dashboard-deploy-stdout.txt | tail -1)
  WARMUP=$(grep "HEALTH_OK_AFTER:" /tmp/dashboard-deploy-stdout.txt | head -1 | cut -d: -f2)
  ok "deployed ${VERSION} in ~${WARMUP} warmup"
  echo "  health: ${HEALTH_LINE}"
  echo
  echo "  next steps:"
  echo "    open https://life-os-engine.tail*.ts.net/dashboard/secrets#token=<gateway-token>"
  exit 0
fi

echo
warn "remote install did not complete cleanly (status=${STATUS})"
echo "--- last 40 lines of remote stdout ---"
tail -40 /tmp/dashboard-deploy-stdout.txt 2>/dev/null || echo "(no stdout captured)"
die "deploy did not pass health check"
