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

mkdir -p "${PROJECT_ROOT}/runtime"

if [[ -n "${BTPLAYER_VENV_DIR:-}" ]]; then
  VENV_DIR="${BTPLAYER_VENV_DIR}"
elif [[ "${PROJECT_ROOT}" == *:* ]]; then
  PROJECT_KEY="$(printf '%s' "${PROJECT_ROOT}" | cksum | awk '{print $1}')"
  CACHE_ROOT="${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}"
  VENV_DIR="${CACHE_ROOT}/bluetooth-player/venv-${PROJECT_KEY}"
else
  VENV_DIR="${PROJECT_ROOT}/.venv"
fi

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
  NEED_APT=false
  command -v python3 >/dev/null 2>&1 || NEED_APT=true
  command -v php >/dev/null 2>&1 || NEED_APT=true
  php -m 2>/dev/null | grep -qi '^curl$' || NEED_APT=true
  php -m 2>/dev/null | grep -qi '^mbstring$' || NEED_APT=true

  if [[ "${NEED_APT}" == "true" ]]; then
    run_as_root apt-get update
    run_as_root apt-get install -y \
      python3 \
      python3-pip \
      python3-venv \
      php-cli \
      php-curl \
      php-mbstring
  fi
fi

VENV_CREATED=false
if [[ ! -d "${VENV_DIR}" ]]; then
  mkdir -p "$(dirname "${VENV_DIR}")"
  python3 -m venv "${VENV_DIR}"
  VENV_CREATED=true
fi

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

REQ_HASH="$(cksum "${PROJECT_ROOT}/requirements.txt" | awk '{print $1 ":" $2}')"
REQ_STAMP="${VENV_DIR}/.requirements.cksum"
INSTALLED_REQ_HASH=""
if [[ -f "${REQ_STAMP}" ]]; then
  INSTALLED_REQ_HASH="$(<"${REQ_STAMP}")"
fi

if [[ "${VENV_CREATED}" == "true" || "${REQ_HASH}" != "${INSTALLED_REQ_HASH}" ]]; then
  pip install --upgrade pip
  pip install -r "${PROJECT_ROOT}/requirements.txt"
  printf '%s\n' "${REQ_HASH}" > "${REQ_STAMP}"
fi

cd "${PROJECT_ROOT}"

php -S "0.0.0.0:${PHP_PORT}" -t "${PROJECT_ROOT}" &
PHP_PID=$!

python3 "${PROJECT_ROOT}/detect.py" &
PY_PID=$!

cleanup() {
  kill "${PHP_PID}" "${PY_PID}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

wait -n "${PHP_PID}" "${PY_PID}"
