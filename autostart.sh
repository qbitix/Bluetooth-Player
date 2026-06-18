#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}"
ENV_FILE="${PROJECT_ROOT}/.env"
ENV_EXAMPLE="${PROJECT_ROOT}/.env.example"

if [[ ! -f "${ENV_FILE}" && -f "${ENV_EXAMPLE}" ]]; then
  cp "${ENV_EXAMPLE}" "${ENV_FILE}"
  echo "Created ${ENV_FILE}. Edit it if you need custom ports or API keys."
fi

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

SERVICE_NAME="mus-app"
USER_NAME="$(id -un)"
PHP_PORT="${PHP_PORT:-8000}"
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      USER_NAME="$2"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --php-port)
      PHP_PORT="$2"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "Root privileges are required for: $*" >&2
    exit 1
  fi
}

if [[ -f "${SERVICE_PATH}" && "${FORCE}" != "true" ]]; then
  echo "Service file ${SERVICE_PATH} already exists. Use --force to overwrite." >&2
  exit 1
fi

SERVICE_CONTENT=$(cat <<EOF
[Unit]
Description=Bluetooth Player Web UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${PROJECT_ROOT}
EnvironmentFile=-${ENV_FILE}
Environment=PHP_PORT=${PHP_PORT}
ExecStart="${PROJECT_ROOT}/start.sh" --skip-install
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
)

printf '%s\n' "${SERVICE_CONTENT}" | run_as_root tee "${SERVICE_PATH}" >/dev/null

run_as_root systemctl daemon-reload
run_as_root systemctl enable "${SERVICE_NAME}.service"
run_as_root systemctl restart "${SERVICE_NAME}.service"

echo "Autostart installed. Service: ${SERVICE_NAME}.service"
