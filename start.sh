#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}"
VENV_DIR="${PROJECT_ROOT}/.venv"

INSTALL_DEPS=true
PHP_PORT="${PHP_PORT:-8000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install)
      INSTALL_DEPS=false
      shift
      ;;
    --php-port)
      PHP_PORT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

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

if $INSTALL_DEPS; then
  run_as_root apt-get update
  run_as_root apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    php-cli \
    php-curl \
    php-mbstring
fi

if [[ ! -d "${VENV_DIR}" ]]; then
  python3 -m venv "${VENV_DIR}"
fi

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"
pip install --upgrade pip
pip install -r "${PROJECT_ROOT}/requirements.txt"

cd "${PROJECT_ROOT}"

php -S "0.0.0.0:${PHP_PORT}" -t "${PROJECT_ROOT}" &
PHP_PID=$!

python3 "${PROJECT_ROOT}/1.py" &
PY_PID=$!

cleanup() {
  kill "${PHP_PID}" "${PY_PID}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

wait "${PHP_PID}"
wait "${PY_PID}"
