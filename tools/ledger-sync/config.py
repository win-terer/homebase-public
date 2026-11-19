"""설치할 때 받아 둔 설정 읽기 (fetch_mail.py 와 sync.sh 가 같이 쓴다).

설정은 homebase 화면에서 고치고, `setup.sh` 가 **연결 코드로 한 번 받아** 여기에 적어 둔다.
그래서 이 폴더의 코드에는 메일 주소도 계정도 박혀 있지 않다 — 누가 쓰든 자기 값으로 돈다.

파일에는 메일 비밀번호가 들어 있으므로 권한을 600 으로 둔다(`setup.sh` 가 그렇게 만든다).
자리를 옮기고 싶으면 환경변수 `HOMEBASE_SYNC_DIR` 로 폴더를 알려 주면 된다.
"""
import json
import os
import pathlib
import sys

DIR = pathlib.Path(os.environ.get("HOMEBASE_SYNC_DIR") or (pathlib.Path.home() / ".homebase-sync"))
CONFIG = DIR / "config.json"


def load() -> dict:
    """설정을 읽는다. 없으면 설치 방법을 알려주고 멈춘다."""
    if not CONFIG.exists():
        sys.exit(
            f"설정이 없어요: {CONFIG}\n"
            "homebase 의 [가져오기] 탭에서 '연결 코드 받기' 를 누른 뒤, 이 컴퓨터에서\n"
            "  ./setup.sh <homebase 주소> <연결 코드>\n"
            "를 한 번 실행하세요."
        )
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001 — 어떤 이유든 사람이 고쳐야 한다
        sys.exit(f"설정을 읽지 못했어요 ({CONFIG}): {e}")


def need(cfg: dict, key: str, what: str) -> str:
    """꼭 있어야 하는 값. 비어 있으면 어디서 채우는지 알려주고 멈춘다."""
    value = str(cfg.get(key) or "").strip()
    if not value:
        sys.exit(f"설정에 {what}가 비어 있어요. homebase [가져오기] 탭에서 채운 뒤 연결 코드를 새로 받아 주세요.")
    return value
