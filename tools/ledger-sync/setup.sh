#!/bin/bash
# 메일 자동 가져오기 도구를 이 컴퓨터에 깔기. **한 번만** 하면 된다.
#
#   ./setup.sh https://내homebase주소 <연결 코드>
#
# 연결 코드는 homebase 의 [가져오기] 탭 맨 아래 "연결 코드 받기" 에서 나온다 (10분·한 번).
# 그 코드로 설정과 비밀번호를 받아 이 컴퓨터에 저장하고, 필요한 파일을 설치 폴더로 옮긴다.
#
#   --install   맥이면 10분마다 저절로 돌도록 launchd 에 등록까지 한다
#   --uninstall 등록을 지운다 (설정과 파일은 남는다)
#
# 설치 폴더는 ~/.homebase-sync (HOMEBASE_SYNC_DIR 로 바꿀 수 있다).
# 설정 파일에는 메일 비밀번호가 들어가므로 권한을 600 으로 둔다.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SYNC_DIR="${HOMEBASE_SYNC_DIR:-$HOME/.homebase-sync}"
LABEL="dev.homebase.ledger-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

die() { echo "✗ $*" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  rm -f "$PLIST"
  echo "✓ 자동 실행 등록을 지웠습니다. (설정과 파일은 $SYNC_DIR 에 그대로 있습니다)"
  exit 0
fi

BASE="${1:-}"
CODE="${2:-}"
INSTALL=""
for a in "$@"; do [ "$a" = "--install" ] && INSTALL=1; done
[ -n "$BASE" ] && [ -n "$CODE" ] || die "사용: ./setup.sh https://내homebase주소 <연결 코드> [--install]"
BASE="${BASE%/}"
case "$BASE" in https://*) ;; http://127.0.0.1*|http://localhost*) ;; *) die "주소는 https:// 로 시작해야 해요 (받은 주소를 그대로 붙여넣으세요)";; esac

command -v python3 >/dev/null || die "python3 가 필요해요."
command -v node >/dev/null || die "node 22 이상이 필요해요."

mkdir -p "$SYNC_DIR" || die "폴더를 못 만들었어요: $SYNC_DIR"
chmod 700 "$SYNC_DIR"

# ── 1. 연결 코드로 설정 받아 오기 ────────────────────────────────
# 코드는 한 번 쓰면 사라진다. 받아 온 값은 이 컴퓨터에만 남는다.
echo "설정을 받는 중…"
TMP="$SYNC_DIR/.config.new"
HTTP=$(curl -sS -m 30 -o "$TMP" -w "%{http_code}" "$BASE/api/ledger/mail-config/claim?code=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$CODE")") || die "서버에 닿지 못했어요. 주소를 확인해 주세요."
if [ "$HTTP" != "200" ]; then
  MSG=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("error",""))' "$TMP" 2>/dev/null)
  rm -f "$TMP"
  die "${MSG:-설정을 받지 못했어요 (HTTP $HTTP)}"
fi

python3 - "$TMP" "$SYNC_DIR/config.json" "$BASE" <<'PY' || { rm -f "$TMP"; die "받은 설정이 이상해요."; }
import json, pathlib, sys
got = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
got["base"] = sys.argv[3]
missing = [k for k in ("host", "user", "password", "zipPassword", "importToken") if not str(got.get(k) or "").strip()]
if missing:
    sys.exit(f"설정이 덜 채워졌어요: {', '.join(missing)} — homebase [가져오기] 탭에서 채우고 코드를 새로 받아 주세요.")
pathlib.Path(sys.argv[2]).write_text(json.dumps(got, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"  메일 서버 {got['host']} · 계정 {got['user']} · 메일함 {got.get('mailbox') or 'INBOX'} · {got.get('everyMinutes', 10)}분마다")
PY
rm -f "$TMP"
chmod 600 "$SYNC_DIR/config.json"

# ── 2. 실행에 필요한 파일을 설치 폴더로 ──────────────────────────
cp "$HERE/fetch_mail.py" "$HERE/config.py" "$HERE/send.ts" "$HERE/sync.sh" "$SYNC_DIR/" || die "파일을 옮기지 못했어요."
chmod +x "$SYNC_DIR/sync.sh" "$SYNC_DIR/fetch_mail.py"

# ── 3. 엑셀 파서 묶기 ────────────────────────────────────────────
# 화면이 쓰는 파서를 **그대로** 불러 쓴다. 새로 짜면 화면으로 올릴 때와 결과가 어긋난다
# (중복 키·건너뛴 행·스냅샷까지 같아야 한다).
#
# 번들로 만들어 설치 폴더에 두는 이유: 맥에서 launchd 가 띄운 프로세스는 `~/Documents` 를
# 읽지 못하는데, 실패가 아니라 **열다가 멈춘다**. 그러면 다음 차례가 통째로 밀린다.
REPO="$(cd "$HERE/../.." && pwd)"
ESBUILD="$REPO/node_modules/.bin/esbuild"
if [ -x "$ESBUILD" ]; then
  echo "엑셀 파서를 묶는 중…"
  # banner: exceljs 가 require("crypto") 를 동적으로 부르는데 ESM 번들에는 require 가 없다
  "$ESBUILD" "$REPO/apps/ledger/src/web/prepare-import.ts" \
    --bundle --platform=node --format=esm --target=node22 \
    --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
    --outfile="$SYNC_DIR/prepare-import.mjs" >/dev/null || die "파서를 묶지 못했어요."
else
  die "저장소에 esbuild 가 없어요. 저장소 폴더에서 'pnpm install' 을 먼저 하세요."
fi

# ── 4. (맥) 10분마다 저절로 돌게 ─────────────────────────────────
if [ -n "$INSTALL" ]; then
  [ "$(uname)" = "Darwin" ] || die "--install 은 맥에서만 됩니다. 다른 OS 는 README 를 보세요."
  EVERY=$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1], encoding="utf-8")).get("everyMinutes") or 10))' "$SYNC_DIR/config.json")
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$SYNC_DIR/sync.sh</string></array>
  <key>StartInterval</key><integer>$((EVERY * 60))</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$SYNC_DIR/launchd.log</string>
  <key>StandardErrorPath</key><string>$SYNC_DIR/launchd.log</string>
</dict>
</plist>
XML
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || die "자동 실행 등록에 실패했어요."
  echo "✓ ${EVERY}분마다 저절로 돕니다. 끄려면: ./setup.sh --uninstall"
fi

echo "✓ 설치했습니다: $SYNC_DIR"
echo
echo "먼저 올리지 않고 확인만 해 보세요:"
echo "  $SYNC_DIR/sync.sh --dry"
[ -n "$INSTALL" ] || echo "자동으로 돌게 하려면 (맥):  ./setup.sh \"$BASE\" <새 연결 코드> --install"
