#!/usr/bin/env bash
set -u

event="${1:-unknown}"
out="${QODER_OTEL_PROBE_OUT:-$HOME/.qoder-cn/qoder-otel-native-hook-events.jsonl}"
tmp="$(mktemp)"
cat > "$tmp"

python3 - "$event" "$tmp" "$out" <<'PY'
import json
import os
import sys
import time

event, input_path, out_path = sys.argv[1:4]
with open(input_path, "rb") as f:
    raw = f.read()

try:
    payload = json.loads(raw.decode("utf-8"))
except Exception:
    payload = {"raw": raw.decode("utf-8", errors="replace")}

record = {
    "ts": time.time(),
    "event_arg": event,
    "cwd": os.getcwd(),
    "env": {
        k: v for k, v in os.environ.items()
        if k.startswith("QODER_") or k.startswith("COSY_")
    },
    "payload": payload,
}

os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "a", encoding="utf-8") as f:
    f.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
PY

rm -f "$tmp"
exit 0
