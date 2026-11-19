import { useEffect, useState } from "react";
import { ledgerApi, type MailConfigInput, type MailConfigView } from "./api.ts";

/**
 * **메일에서 엑셀 자동으로 가져오기** 설정 (가져오기 화면 아래).
 *
 * 뱅크샐러드 앱에서 "파일로 받기" 를 누르면 암호 걸린 zip 이 메일로 온다. 그걸 받아 풀고 올려 주는
 * 도구가 어딘가에서 돌아야 하는데, 그 도구가 알아야 할 것을 **여기서 정한다**(예전에는 그 컴퓨터의
 * 키체인과 코드 안 상수에 박혀 있었다).
 *
 * 비밀값은 **한 번 넣으면 다시 안 보인다** — 서버가 봉해서 저장하고 내려보내지 않는다. 바꾸고
 * 싶으면 새로 입력하고, 지우려면 비운 채로 저장한다.
 *
 * 도구에 넘기는 길은 **일회용 연결 코드**다. 가져오기 키로 이 설정을 열면 그 키가 새는 순간
 * 메일 비밀번호까지 새기 때문에 그쪽은 건드리지 않았다 (`server/mail-config.ts` 머리말).
 */
export function MailSync() {
  const [config, setConfig] = useState<MailConfigView | null>(null);
  const [form, setForm] = useState<MailConfigInput | null>(null);
  const [secrets, setSecrets] = useState<{ password?: string; zipPassword?: string; zipPassword2?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ code: string; expiresAt: string } | null>(null);

  useEffect(() => {
    ledgerApi.mailConfig().then(
      (c) => {
        setConfig(c);
        setForm(stripFlags(c));
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  if (error && !config) return <p className="hb-error">{error}</p>;
  if (!config || !form) return null;

  const set = <K extends keyof MailConfigInput>(key: K, value: MailConfigInput[K]) => {
    setForm({ ...form, [key]: value });
    setSaved(false);
  };

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      // 비밀값은 **건드린 것만** 보낸다 — 안 보내면 서버가 그대로 둔다
      const saved = await ledgerApi.saveMailConfig({ ...form, ...secrets });
      setConfig(saved);
      setForm(stripFlags(saved));
      setSecrets({});
      setSaved(true);
      setLink(null); // 설정이 바뀌었으니 전에 뽑은 코드는 헌 것이다
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function makeLink() {
    setBusy(true);
    setError(null);
    try {
      setLink(await ledgerApi.mailLink());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="lg-history ms-box">
      <h2>메일에서 자동으로 가져오기</h2>
      <p className="hb-muted ms-lead">
        뱅크샐러드 앱에서 <b>파일로 받기</b> 를 누르면 암호 걸린 엑셀이 메일로 옵니다. 그 메일을 대신 읽어 올려 주는 도구에게 알려 줄 것들입니다. 도구를 안 쓰면 비워 두세요 — 엑셀을 직접
        올리는 데는 아무 영향이 없습니다.
      </p>

      {!config.canStoreSecrets && (
        <p className="ms-warn">
          비밀번호를 저장하려면 Cloudflare 대시보드 → <b>컴퓨트 → Workers 및 Pages</b> → 이 사이트 → <b>설정</b> → <b>변수 및 시크릿</b> 에 <code className="ns-code">SETTINGS_KEY</code> 를 먼저 넣어야 합니다 (<b>30자 이상 무작위</b>로 하세요 — 그 열쇠로 비밀번호를 잠그므로 짧으면 잠근 의미가 없습니다).
        </p>
      )}
      {config.secretsUnreadable && (
        <p className="ms-warn">
          <code className="ns-code">SETTINGS_KEY</code> 가 전에 넣은 값과 달라서 저장해 둔 비밀번호를 열지 못합니다. 비밀번호를 <b>다시 입력</b>해 주세요. (가계부 기록에는 아무 일도 없습니다)
        </p>
      )}

      <label className="ms-toggle">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        <span>자동 가져오기 켜기</span>
      </label>

      <div className="ms-grid">
        <Field label="메일 서버 (IMAP)" hint="네이버 imap.naver.com · 지메일 imap.gmail.com">
          <input className="ms-input" value={form.host} placeholder="imap.naver.com" onChange={(e) => set("host", e.target.value)} />
        </Field>
        <Field label="포트" hint="보통 993">
          <input className="ms-input" type="number" value={form.port} onChange={(e) => set("port", Number(e.target.value))} />
        </Field>
        <Field label="계정" hint="네이버는 아이디만, 지메일은 메일 주소 전체">
          <input className="ms-input" value={form.user} autoComplete="off" onChange={(e) => set("user", e.target.value)} />
        </Field>
        <Field label="비밀번호" hint={config.hasPassword ? "저장돼 있습니다. 바꿀 때만 입력하세요" : "네이버·지메일은 앱 비밀번호를 따로 받아야 합니다"}>
          <input
            className="ms-input"
            type="password"
            autoComplete="new-password"
            placeholder={config.hasPassword ? "●●●●●●●● (그대로 둠)" : ""}
            value={secrets.password ?? ""}
            onChange={(e) => (setSecrets({ ...secrets, password: e.target.value }), setSaved(false))}
          />
        </Field>
        <Field label="메일함" hint="뱅샐 메일만 모아 둔 폴더. 비우면 받은편지함에서 찾습니다">
          <input className="ms-input" value={form.mailbox} placeholder="INBOX" onChange={(e) => set("mailbox", e.target.value)} />
        </Field>
        <Field label="보낸 사람" hint="이 주소에서 온 메일만 봅니다">
          <input className="ms-input" value={form.sender} onChange={(e) => set("sender", e.target.value)} />
        </Field>
        <Field label="엑셀 암호" hint={config.hasZipPassword ? "저장돼 있습니다. 바꿀 때만 입력하세요" : "뱅샐 앱에서 내보낼 때 직접 거는 암호"}>
          <input
            className="ms-input"
            type="password"
            autoComplete="new-password"
            placeholder={config.hasZipPassword ? "●●●●●●●● (그대로 둠)" : ""}
            value={secrets.zipPassword ?? ""}
            onChange={(e) => (setSecrets({ ...secrets, zipPassword: e.target.value }), setSaved(false))}
          />
        </Field>
        <Field label="엑셀 암호 (예비)" hint="내보낼 때 다른 암호를 걸었을 때를 대비한 두 번째 값. 없어도 됩니다">
          <input
            className="ms-input"
            type="password"
            autoComplete="new-password"
            placeholder={config.hasZipPassword2 ? "●●●●●●●● (그대로 둠)" : ""}
            value={secrets.zipPassword2 ?? ""}
            onChange={(e) => (setSecrets({ ...secrets, zipPassword2: e.target.value }), setSaved(false))}
          />
        </Field>
        <Field label="확인 주기" hint="분. 너무 자주 보면 메일 서버가 막습니다">
          <input className="ms-input" type="number" min={5} max={360} value={form.everyMinutes} onChange={(e) => set("everyMinutes", Number(e.target.value))} />
        </Field>
      </div>

      {error && <p className="hb-error">{error}</p>}

      <div className="ms-actions">
        <button className="hb-button" disabled={busy} onClick={() => void save()}>
          저장
        </button>
        {saved && <span className="ms-saved">저장했어요</span>}
      </div>

      <h3 className="ms-sub">도구에 연결하기</h3>
      <p className="hb-muted ms-lead">
        메일을 실제로 읽어 오는 일은 <b>늘 켜 두는 컴퓨터</b>가 합니다(집에 있는 맥·PC·작은 서버 아무거나). 아래 코드를 받아 그 컴퓨터에서 한 번만 실행하면, 위 설정과 비밀번호를 받아 가
        저장합니다.
      </p>
      <p className="hb-muted ms-lead">
        코드는 <b>10분 동안 한 번만</b> 쓸 수 있습니다. 설정을 고쳤으면 코드를 새로 받아 다시 실행하세요.
      </p>
      <p className="hb-muted ms-lead">
        이 코드는 <b>위에 적은 설정과 비밀번호를 한 번 내주는 값</b>입니다. 남에게 보여 주거나 채팅에 붙여넣지 마세요.
      </p>
      <div className="ms-actions">
        <button className="hb-button ms-ghost" disabled={busy} onClick={() => void makeLink()}>
          연결 코드 받기
        </button>
      </div>
      {link && (
        <div className="ms-link">
          <code>{link.code}</code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(link.code).catch(() => {});
            }}
          >
            복사
          </button>
          <span className="hb-muted">{new Date(link.expiresAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 까지</span>
        </div>
      )}
    </section>
  );
}

function stripFlags(c: MailConfigView): MailConfigInput {
  const { hasPassword, hasZipPassword, hasZipPassword2, canStoreSecrets, secretsUnreadable, ...rest } = c;
  void hasPassword, hasZipPassword, hasZipPassword2, canStoreSecrets, secretsUnreadable;
  return rest;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="ms-field">
      <span className="ms-label">{label}</span>
      {children}
      {hint && <span className="ms-hint">{hint}</span>}
    </label>
  );
}
