"""뱅크샐러드 내보내기 메일에서 엑셀을 꺼낸다. (1단계 — 2단계는 send.ts 가 맡는다)

메일함에서 **뱅샐이 보낸 것만** 서버 검색으로 골라 받는다(다른 메일은 제목조차 받지 않는다).
첨부는 암호 걸린 zip 이고, 그 안에 xlsx 한 장이 들어 있다. 암호는 사용자가 뱅샐 앱에서 직접
거는 값이라 매번 같다.

메일 서버·계정·비밀번호·메일함은 **homebase 화면에서 정하고** `setup.sh` 가 받아 둔 설정
(`~/.homebase-sync/config.json`)에서 읽는다 — 이 파일에는 아무것도 박혀 있지 않다.

내보낸 xlsx 경로를 마지막 줄에 찍는다. 받을 메일이 없으면 아무것도 안 찍고 2번으로 끝낸다.
"""
import argparse
import base64
import email
import imaplib
import pathlib
import sys
import zipfile
from email.header import decode_header, make_header

from config import DIR, load, need

CFG = load()
IMAP_HOST = need(CFG, "host", "메일 서버 주소")
IMAP_PORT = int(CFG.get("port") or 993)
IMAP_USER = need(CFG, "user", "메일 계정")
SENDER = str(CFG.get("sender") or "export-noreply@banksalad.com")
# 뱅샐 메일만 모아 둔 폴더를 쓰면 좋다 — 받은편지함을 아예 열지 않으므로
#  ① 다른 메일은 건드릴 일이 없고
#  ② 메일 서버가 동기화하는 최근 N 통 범위 밖으로 밀려날 걱정도 없다
# 비워 두면 받은편지함에서 보낸이로 찾는다.
DEFAULT_MAILBOX = str(CFG.get("mailbox") or "INBOX")


def imap_utf7(name):
    """한글 폴더명 → IMAP 수정 UTF-7 (네이버가 쓰는 표기). ASCII 면 그대로 둔다."""
    out, buf = [], []

    def flush():
        if buf:
            b = base64.b64encode("".join(buf).encode("utf-16-be")).decode()
            out.append("&" + b.rstrip("=").replace("/", ",") + "-")
            buf.clear()

    for ch in name:
        if ch == "&":
            flush(); out.append("&-")
        elif "\x20" <= ch <= "\x7e":
            flush(); out.append(ch)
        else:
            buf.append(ch)
    flush()
    return "".join(out)


def zip_passwords():
    """시도할 zip 암호 목록. 기본 하나 + 예비(있으면). 값은 로그에 절대 찍지 않는다."""
    pws = [("기본", need(CFG, "zipPassword", "엑셀 암호"))]
    alt = str(CFG.get("zipPassword2") or "").strip()
    if alt and alt != pws[0][1]:
        pws.append(("예비", alt))
    return pws


def decoded(value):   # 맥 기본 파이썬이 3.9 라 `str | None` 표기를 못 쓴다
    # type: (object) -> str
    return str(make_header(decode_header(value))) if value else ""


def imap_utf7_decode(name):
    """서버가 준 폴더 이름(모디파이드 UTF-7)을 사람이 읽는 글자로."""
    try:
        return name.replace("&-", "\x00").replace("&", "+").replace(",", "/").encode().decode("utf-7").replace("\x00", "&")
    except Exception:
        return name


def find_mailbox(M, wanted):
    """폴더 목록에서 `wanted` 라는 이름을 가진 것을 찾는다 (어느 폴더 아래 있든).

    돌려주는 값은 **사람이 읽는 전체 경로**다(예: "보관/가계부/뱅샐"). 여러 개면 경로가
    가장 짧은 것 — 깊이 묻힌 동명 폴더보다 바깥쪽이 맞을 가능성이 높다.
    """
    ok, boxes = M.list()
    if ok != "OK" or not boxes:
        return None
    hits = []
    for raw in boxes:
        line = raw.decode(errors="replace")
        # `(\플래그) "/" 이름` 꼴. 이름에 따옴표가 있을 수 있어 뒤에서부터 자른다
        if '"/"' not in line:
            continue
        name = line.rsplit('"/"', 1)[1].strip().strip('"')
        human = imap_utf7_decode(name)
        if human == wanted or human.rsplit("/", 1)[-1] == wanted:
            hits.append(human)
    return min(hits, key=len) if hits else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/ledger-sync", help="xlsx 를 둘 폴더")
    ap.add_argument("--mailbox", default=DEFAULT_MAILBOX, help="볼 메일함 (한글 이름 그대로 쓰면 된다)")
    ap.add_argument("--unseen", action="store_true",
                    help="안 읽은 메일만 본다 (전용 폴더를 안 쓸 때. 기본은 읽음 여부를 보지 않는다)")
    ap.add_argument("--again", action="store_true", help="이미 처리한 메일이라도 다시 가져온다")
    ap.add_argument("--state", default=str(DIR / "last-uid"),
                    help="마지막으로 처리한 메일 UID 를 적어 두는 곳")
    a = ap.parse_args()

    out_dir = pathlib.Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 응답이 없을 때 영영 매달리지 않게. 자동 실행이라 멈추면 다음 차례가 통째로 밀린다
    M = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, timeout=60)
    try:
        M.login(IMAP_USER, need(CFG, "password", "메일 비밀번호"))
        # readonly — 메일을 읽음 처리하거나 지우지 않는다. 사람이 보는 메일함을 건드리지 않기 위해.
        #
        # **결과를 반드시 확인한다.** 그냥 넘어가면 폴더를 못 열었는데도 다음 줄로 가서
        # "command SEARCH illegal in state AUTH" 라는 엉뚱한 오류로 터진다 — 진짜 원인
        # (폴더 이름이 바뀌었다/동시 접속 제한에 걸렸다)이 가려진다.
        ok, info = M.select(imap_utf7(a.mailbox), readonly=True)
        if ok != "OK":
            # 폴더를 다른 폴더 **아래로 옮기면** 경로가 바뀐다("뱅샐" → "보관/가계부/뱅샐").
            # 메일함 정리하다 흔히 생기는 일이라, 적힌 이름 그대로 못 찾으면 **이름으로 찾아본다.**
            found = find_mailbox(M, a.mailbox)
            if found:
                print(f"폴더를 '{found}' 에서 찾았어요 (적힌 이름: {a.mailbox}).", file=sys.stderr)
                ok, info = M.select(imap_utf7(found), readonly=True)
            if ok != "OK":
                detail = info[0].decode(errors="replace") if info and info[0] else ""
                print(f"메일 폴더 '{a.mailbox}' 를 열지 못했어요: {detail}", file=sys.stderr)
                print("폴더가 지워졌거나, 네이버 동시 접속 제한에 걸렸을 수 있어요.", file=sys.stderr)
                raise SystemExit(1)
        # **읽음 여부를 기본으로 보지 않는다.** 전용 폴더에는 뱅샐 메일만 있고, 같은 메일을
        # 두 번 올리는 건 아래 uid 상태로 막는다. 'UNSEEN' 을 기준으로 삼으면 휴대폰에서
        # 메일을 먼저 열어본 순간 읽음이 되어 그 메일을 **영영 못 집는다** — 내보내기를
        # 요청하고 왔는지 확인하는 건 자연스러운 행동이라 충분히 일어난다.
        query = f'(UNSEEN FROM "{SENDER}")' if a.unseen else f'(FROM "{SENDER}")'
        # UID 로 받는다 — 번호(seq)는 메일을 지우면 밀려서 '같은 메일' 판정에 못 쓴다
        ok, data = M.uid("SEARCH", None, query)
        if ok != "OK":
            print(f"메일 검색에 실패했어요: {data}", file=sys.stderr)
            raise SystemExit(1)
        uids = data[0].split()
        if not uids:
            print("새 뱅샐 메일이 없어요.", file=sys.stderr)
            raise SystemExit(2)

        # 여러 통이면 가장 최근 것 하나만. 과거분까지 올릴 일은 없다(어차피 기간이 겹친다).
        uid = uids[-1].decode()

        # **이미 올린 메일이면 여기서 끝낸다.**
        # 메일을 readonly 로 보기 때문에 읽음 처리가 안 되고, 그래서 UNSEEN 조건만으로는
        # 같은 메일을 영원히 다시 집는다. 10분마다 도는 자동 실행이라면 같은 2,244건을
        # 하루 144번 다시 올려 D1 하루 한도의 절반을 태운다 — 상태를 따로 적어 둬야 한다.
        state = pathlib.Path(a.state)
        if not a.again and state.exists() and state.read_text().strip() == uid:
            print(f"이미 처리한 메일이에요 (uid {uid}).", file=sys.stderr)
            raise SystemExit(2)

        ok, raw = M.uid("FETCH", uid, "(RFC822)")
        msg = email.message_from_bytes(raw[0][1])
        print(f"메일: {decoded(msg['Subject'])}", file=sys.stderr)

        blob = name = None
        for part in msg.walk():
            fn = decoded(part.get_filename())
            if fn.lower().endswith(".zip"):
                blob, name = part.get_payload(decode=True), fn
                break
        if blob is None:
            sys.exit("그 메일에 zip 첨부가 없어요.")
    finally:
        try:
            M.logout()
        except Exception:
            pass

    zip_path = out_dir / "attach.zip"
    zip_path.write_bytes(blob)
    try:
        with zipfile.ZipFile(zip_path) as z:
            inner = next((n for n in z.namelist() if n.lower().endswith(".xlsx")), None)
            if inner is None:
                sys.exit("zip 안에 xlsx 가 없어요.")
            # 암호를 둘 둔다 — 내보낼 때 헷갈려서 다른 걸 걸어도 그냥 풀리게.
            # 틀리면 RuntimeError('Bad password'), 운 나쁘게 머리글만 통과하면 CRC 에서
            # BadZipFile 이 난다. 둘 다 '다음 암호' 로 넘긴다.
            payload = last = None
            for label, pw in zip_passwords():
                try:
                    payload = z.read(inner, pwd=pw.encode())
                except (RuntimeError, zipfile.BadZipFile) as e:
                    last = e
                    continue
                if label != "기본":
                    print(f"압축: {label} 암호로 풀었어요", file=sys.stderr)
                break
            if payload is None:
                sys.exit(f"압축을 못 풀었어요 — 설정에 적어 둔 엑셀 암호가 하나도 안 맞습니다: {last}")
    finally:
        zip_path.unlink(missing_ok=True)  # 암호 걸린 원본도 남겨 두지 않는다

    xlsx = out_dir / "ledger.xlsx"
    xlsx.write_bytes(payload)
    # 올리기 전에는 적지 않는다 — 전송이 실패했는데 '처리함' 으로 남으면 그 메일을 영영 놓친다.
    # 적는 일은 sync.sh 가 전송 성공 뒤에 한다.
    (out_dir / "uid").write_text(uid)
    print(f"받음: {name} → {xlsx.name} ({len(payload):,}B, uid {uid})", file=sys.stderr)
    print(xlsx)  # 마지막 줄 = 다음 단계가 읽을 경로


if __name__ == "__main__":
    main()
