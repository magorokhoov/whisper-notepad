#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Нужен Node 20.11 или новее." >&2
  exit 1
fi

if [ ! -d node_modules/sherpa-onnx-node ] || [ ! -d node_modules/ws ]; then
  echo "Не найдены локальные зависимости в node_modules." >&2
  echo "Они уже должны лежать рядом; если папка node_modules удалена, восстановите её." >&2
  exit 1
fi

exec node server.mjs --open "$@"
