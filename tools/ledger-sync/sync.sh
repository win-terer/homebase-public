#!/bin/bash
# 뱅크샐러드 내보내기 메일 → homebase 가계부. 이 한 줄이 전부다.
#
#   ./sync.sh          안 읽은 뱅샐 메일이 있으면 가져와 올린다 (없으면 조용히 끝)
#   ./sync.sh --dry    올리지 않고 결과만 본다
#   ./sync.sh --unseen 안 읽은 메일만 본다 (전용 폴더를 안 쓸 때)
#   ./sync.sh --again  이미 올린 메일이라도 다시 올린다
#
# 새 메일이 없으면(이미 올린 메일이면) **아무것도 안 하고 0 으로 끝난다** — launchd 가 10분마다 불러도
# 조용하다. 메일은 readonly 로 보므로 읽음 처리되지 않는다(사람이 보는 메일함을 안 건드린다).
#
# 설정(메일 서버·계정·비밀번호·엑셀 암호·주소·열쇠)은 homebase 화면에서 정하고,
# ./setup.sh 가 연결 코드로 한 번 받아 ~/.homebase-sync/config.json 에 적어 둔다 (권한 600).
# 이 스크립트에는 아무 값도 박혀 있지 않다.
#
# 끝날 때마다 homebase 에 "살아 있다" 고 보고한다 (POST /api/ledger/sync-status, 같은 가져오기 키).
# 성공이면 {ok:true}, 실패면 어느 단계에서 무슨 말을 남기고 죽었는지 함께 보낸다 — 알림 탭의
# '자동 가져오기' 칸이 이 보고로 켜진다. 3시간 보고가 없거나 3번 연속 실패면 거기서 경고가 뜬다.
# --dry 는 사람이 손으로 돌리는 것이니 보고하지 않는다. 보고 자체가 실패해도 동기화 결과는 바꾸지 않는다.
set -uo pipefail
cd "$(dirname "$0")"   # 스크립트들은 한 폴더에 같이 있다

DRY=""; ALL=""; AGAIN=""; FULL=""   # ALL 은 --unseen 전달용, FULL 은 --all(기간 안 자르기)
for a in "$@"; do
  case "$a" in
    --dry) DRY="--dry" ;;
    --unseen) ALL="--unseen" ;;
    --again) AGAIN="--again" ;;
    --all) FULL="--all" ;;
    *) echo "모르는 옵션: $a" >&2; exit 1 ;;
  esac
done

# 설치 폴더 (옮기고 싶으면 HOMEBASE_SYNC_DIR 로 알려 준다)
SYNC_DIR="${HOMEBASE_SYNC_DIR:-$HOME/.homebase-sync}"
CONFIG="$SYNC_DIR/config.json"
if [ ! -f "$CONFIG" ]; then
  echo "설정이 없어요: $CONFIG" >&2
  echo "homebase [가져오기] 탭에서 '연결 코드 받기' 를 누른 뒤 ./setup.sh <주소> <코드> 를 실행하세요." >&2
  exit 1
fi
# 설정에서 주소와 열쇠만 꺼낸다 (메일 비밀번호는 각 단계가 알아서 읽는다)
read_cfg() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2]) or "")' "$CONFIG" "$1"; }

# 로그 다듬기 — launchd 가 StandardOutPath 에 **영원히 덧붙이므로** 스스로 잘라야 한다.
# 10분마다 한 줄씩이라 하루 144줄. 64KB 를 넘으면 뒤쪽 200줄만 남긴다.
LOG="$SYNC_DIR/sync.log"
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 65536 ]; then
  tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
# 한 줄 앞에 날짜를 붙여 둔다 — 언제 돌았는지 모르면 로그가 쓸모없다
echo "── $(date '+%F %H:%M')"

# 시간 제한을 걸어 돌린다 (macOS 에는 timeout 명령이 없다).
#
# **왜 필요한가** — 2026-10-03, send.ts 가 `~/Documents` 안의 저장소를 읽으려다 TCC 때문에
# `open()` 에서 멈췄다. 실패가 아니라 **정지**라 프로세스가 영영 안 끝났고, launchd 는 이미
# 도는 작업이 있으면 다음 차례를 건너뛰므로 **동기화가 통째로 멎었다.** 20분 넘게 아무도 몰랐다.
# 어떤 이유로 멈추든 여기서 끊는다 — 다음 10분 뒤 차례가 정상적으로 돌아온다.
run_limited() {
  local secs=$1; shift
  "$@" &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      echo "⏱ ${secs}초를 넘겨 멈춘 것으로 보고 끊었습니다: $*" >&2
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 5
    waited=$((waited + 5))
  done
  wait "$pid"
}

WORK=$(mktemp -d /tmp/ledger-sync.XXXXXX)

# 생존 보고. STEP/ERR 는 각 단계가 실패하기 전에 채워 둔다.
BASE=$(read_cfg base); BASE="${BASE%/}"
TOKEN=$(read_cfg importToken)
STEP="메일 받기"; ERR=""
report() {
  local rc=$1
  [ -n "$DRY" ] && return 0
  [ -z "$TOKEN" ] && return 0
  local body
  if [ "$rc" = "0" ]; then
    body='{"ok":true}'
  else
    body=$(python3 -c 'import json,sys; print(json.dumps({"ok":False,"step":sys.argv[1],"error":sys.argv[2]}, ensure_ascii=False))' "$STEP" "${ERR:-종료 코드 $rc}")
  fi
  # 키는 명령줄 인자(ps 로 보인다)가 아니라 curl 설정으로 stdin 에 넘긴다. Origin 은 sameOrigin(CSRF 방어)이 요구한다
  if ! curl -sS --fail -m 20 -o /dev/null -K - --data-binary "$body" "$BASE/api/ledger/sync-status" <<CFG
header = "Content-Type: application/json"
header = "Origin: $BASE"
header = "X-Import-Token: $TOKEN"
request = "POST"
CFG
  then echo "생존 보고를 못 보냈어요 (동기화 결과와는 무관)" >&2; fi
}

# 받은 엑셀에는 실제 거래 내역이 들어 있다 — 끝나면 어떤 경로로 끝나든 지운다. 지운 뒤 보고한다.
trap 'rc=$?; rm -rf "$WORK"; report "$rc"' EXIT

# stdout(마지막 줄 = xlsx 경로)만 받고, 진행 상황(stderr)은 그대로 흘려보낸다
# 메일 받기 3분 (IMAP 이 응답 없이 물릴 수 있다)
# stderr 는 파일에 받았다가 그대로 흘려보낸다 — 실패하면 그 끝 몇 줄을 보고에 싣는다
XLSX=$(run_limited 180 python3 fetch_mail.py --out "$WORK" $ALL $AGAIN 2>"$WORK/err")
rc=$?
cat "$WORK/err" >&2
last_err() { tail -n 3 "$WORK/err" 2>/dev/null | tr '\n' ' ' | cut -c1-200; }
if [ "$rc" = "124" ]; then ERR="180초 넘겨 끊음"; exit 1; fi
# 2 = 받을 메일 없음(정상). 그 밖의 0 아닌 값은 진짜 실패.
if [ -z "$XLSX" ]; then
  [ "$rc" = "2" ] && exit 0
  echo "메일에서 엑셀을 못 가져왔어요." >&2
  ERR=$(last_err); ERR="메일에서 엑셀을 못 가져왔어요. ${ERR}"
  exit 1
fi

# 올리기 10분 (1년치 전체여도 충분하다. 조각마다 2분 제한이 따로 걸려 있다)
STEP="올리기"
run_limited 600 node --experimental-strip-types send.ts "$XLSX" $DRY $FULL 2>"$WORK/err"
rc=$?
cat "$WORK/err" >&2
if [ "$rc" != "0" ]; then
  if [ "$rc" = "124" ]; then ERR="600초 넘겨 끊음"; else ERR=$(last_err); fi
  exit 1
fi

# 전송이 성공했을 때만 '이 메일은 처리했다' 고 적는다. 미리보기는 올린 게 아니니 안 적는다.
# (이게 없으면 메일을 readonly 로 보는 탓에 같은 메일을 10분마다 영원히 다시 올린다)
if [ -z "$DRY" ] && [ -f "$WORK/uid" ]; then
  cp "$WORK/uid" "$SYNC_DIR/last-uid"
fi
