import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ImportPayload } from "../importers/types.ts";
import { ledgerApi, won, type CashReceiptPreview, type DupePair, type ImportBatch, type ImportSummary } from "./api.ts";
import { ago, seoulStamp } from "./notify-status.ts";
import { MailSync } from "./MailSync.tsx";

const loadPreparer = () => import("./prepare-import.ts");

type State =
  | { step: "idle" }
  | { step: "loading" }
  | { step: "preview"; payload: ImportPayload; summary: ImportSummary }
  | { step: "done"; summary: ImportSummary }
  | { step: "error"; message: string };

export function ImportPage() {
  const [state, setState] = useState<State>({ step: "idle" });

  async function run(input: File | ImportPayload, commit: boolean) {
    setState({ step: "loading" });
    try {
      const payload = input instanceof File ? await (await loadPreparer()).prepareImport(input) : input;
      const summary = await ledgerApi.importPayload(payload, commit);
      setState(commit ? { step: "done", summary } : { step: "preview", payload, summary });
    } catch (e) {
      setState({ step: "error", message: (e as Error).message });
    }
  }

  return (
    <section className="hb-narrow">
      <h1>엑셀 가져오기</h1>
      <p className="hb-muted">
        뱅크샐러드 "데이터 내보내기"로 받은 엑셀을 골라주세요. 엑셀은 이 브라우저에서 읽고 거래 목록만 서버로 보내요
        (파일 자체는 올라가지 않아요). 같은 기간을 다시 올려도 중복되지 않아요.
      </p>

      <label className={`hb-button lg-file ${state.step === "loading" ? "is-disabled" : ""}`}>
        엑셀 파일 선택
        <input
          type="file"
          accept=".xlsx"
          disabled={state.step === "loading"}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void run(file, false);
            e.target.value = "";
          }}
        />
      </label>

      {state.step === "loading" && <p className="hb-muted">읽는 중…</p>}
      {state.step === "error" && <p className="hb-error">{state.message}</p>}

      {state.step === "preview" && (
        <>
          <Summary summary={state.summary} />
          <button
            className="hb-button"
            disabled={state.summary.new === 0}
            onClick={() => void run(state.payload, true)}
          >
            {state.summary.new === 0 ? "새로 추가할 기록이 없어요" : `${won(state.summary.new)}건 저장`}
          </button>
        </>
      )}

      {state.step === "done" && (
        <div className="hb-card">
          <strong>{won(state.summary.inserted ?? 0)}건을 저장했어요.</strong>{" "}
          <Link to="..">달력에서 보기</Link>
          {state.summary.review > 0 && (
            <p className="hb-muted">확인이 필요한 이체 {won(state.summary.review)}건은 확인 화면에서 정리할 수 있어요.</p>
          )}
          {(state.summary.lostMemos ?? 0) > 0 && (
            <p className="hb-muted">
              앱알림에 적어 둔 메모 {won(state.summary.lostMemos!)}건은 어느 결제인지 못 정해서 그대로 남겨 뒀어요. 달력 위 <strong>옮기지 못한 메모</strong>를 누르면 그날로 가요.
            </p>
          )}
        </div>
      )}

      <Duplicates />
      <ImportHistory />
      <CashReceiptImport />
      <MailSync />
    </section>
  );
}

/**
 * **간편결제 중복** — 네이버페이로 카드를 긁으면 뱅크샐러드에 네이버페이 쪽과 카드사 쪽이
 * 둘 다 들어와 지출이 두 배로 잡힌다. 앞으로 들어올 것은 가져올 때 알아서 빠지지만
 * (`prepare-import.ts`), 그 규칙이 생기기 전에 쌓인 줄은 여기서 한 번 치운다.
 *
 * **지우는 건 간편결제 쪽**이다 — 연말정산 추정이 카드 줄을 보고 계산하기 때문
 * (`importers/simple-pay.ts` 머리말). 대신 카드 줄 날짜는 매입일이라 하루 이틀 늦을 수 있어서,
 * 지우기 전에 양쪽을 나란히 보여 준다.
 */
function Duplicates() {
  const [pairs, setPairs] = useState<DupePair[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ledgerApi.duplicates().then((r) => setPairs(r.pairs), (e: Error) => setError(e.message));
  }, []);

  async function remove() {
    if (!pairs?.length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await ledgerApi.removeDuplicates(pairs.map((p) => p.pay.id));
      setDone(r.removed);
      setPairs([]);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  if (error) return <p className="hb-error">{error}</p>;
  if (!pairs) return null;
  if (!pairs.length)
    return done === null ? null : (
      <section className="lg-history">
        <h2>간편결제 중복</h2>
        <p className="hb-muted">{won(done)}건을 지웠어요.</p>
      </section>
    );

  return (
    <section className="lg-history">
      <h2>간편결제 중복 {won(pairs.length)}건</h2>
      <p className="hb-muted">
        네이버페이 같은 간편결제로 카드를 긁으면 간편결제 쪽과 카드사 쪽이 <strong>둘 다</strong> 들어와요. 아래 왼쪽(간편결제)을 지우고 오른쪽(카드)을 남겨요 —
        연말정산은 카드 줄로 계산되거든요. 카드 줄 날짜는 매입일이라 하루 이틀 늦을 수 있어요.
      </p>
      <table className="hb-table lg-history-table">
        <thead>
          <tr>
            <th>지울 줄 (간편결제)</th>
            <th>남길 줄 (카드)</th>
            <th className="num">금액</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map(({ pay, card }) => (
            <tr key={pay.id}>
              <td>
                {pay.date} {pay.time?.slice(0, 5) ?? ""} <span className="hb-muted">{pay.merchant}</span>
              </td>
              <td>
                {card.date} {card.time?.slice(0, 5) ?? ""} <span className="hb-muted">{card.merchant}</span>
              </td>
              <td className="num">{won(Math.abs(pay.amount))}원</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="hb-button lg-dupe-go" disabled={busy} onClick={() => void remove()}>
        {busy ? "지우는 중…" : `간편결제 쪽 ${won(pairs.length)}건 지우기`}
      </button>
    </section>
  );
}

/**
 * 가져온 기록 — **언제 무엇이 들어왔나.**
 *
 * 평소 가계부를 채우는 건 사람이 아니라 집 맥북의 자동 가져오기다(10분마다 메일을 보고, 새
 * 내보내기가 와 있으면 올린다). 그래서 화면에는 아무 흔적이 없고, 며칠 비어 보일 때 "안 쓴
 * 날" 인지 "안 들어온 것" 인지 가릴 길이 없었다. 기록 자체는 처음부터 쌓여 있었으므로
 * (`ledger_import_batches`) 보여 주기만 한다.
 *
 * **"새로 추가 0건" 은 고장이 아니다** — 내보내기는 늘 1년치라, 이미 들어온 것과 겹치는 게
 * 정상이다. 그 줄은 "확인은 했고 새 건 없었다" 는 뜻이다.
 */
function ImportHistory() {
  const [rows, setRows] = useState<ImportBatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    ledgerApi.importHistory().then(
      (r) => {
        setRows(r);
        setNow(Date.now());
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  if (error) return <p className="hb-error">{error}</p>;
  if (!rows) return null;

  const last = rows[0];
  return (
    <section className="lg-history">
      <h2>가져온 기록</h2>
      <p className="hb-muted">
        화면에서 올린 것과 집 맥북이 메일을 보고 올린 것이 함께 남아요. <Link to="../notify">알림</Link> 화면에서 자동 가져오기가 돌고 있는지 볼 수 있어요.
      </p>
      {!last ? (
        <p className="hb-muted">아직 가져온 기록이 없어요.</p>
      ) : (
        <>
          <p className="lg-history-last">
            마지막 가져오기 <strong>{ago(last.importedAt, now)}</strong>
            <span className="hb-muted">
              {" "}
              · {seoulStamp(last.importedAt)} · 새로 {won(last.inserted)}건
            </span>
          </p>
          <table className="hb-table lg-history-table">
            <thead>
              <tr>
                <th>시각</th>
                <th className="num">새로 추가</th>
                <th className="num">이미 있음</th>
                <th>엑셀 기간</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td>
                    {seoulStamp(b.importedAt)} <span className="hb-muted">{ago(b.importedAt, now)}</span>
                  </td>
                  <td className="num">{b.inserted ? `${won(b.inserted)}건` : <span className="hb-muted">—</span>}</td>
                  <td className="num hb-muted">{won(b.duplicates)}건</td>
                  <td className="hb-muted">{span(b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/** `2025-10-06 ~ 2026-10-05` → `25.10.06 ~ 26.10.05` (표 한 칸에 들어가게) */
function span(b: ImportBatch): string {
  const short = (d: string) => d.slice(2).replace(/-/g, ".");
  if (!b.periodFrom || !b.periodTo) return "—";
  return `${short(b.periodFrom)} ~ ${short(b.periodTo)}`;
}

function Summary({ summary: s }: { summary: ImportSummary }) {
  const excluded = Object.entries(s.excluded).sort((a, b) => b[1] - a[1]);
  const excludedTotal = excluded.reduce((sum, [, n]) => sum + n, 0);
  return (
    <div className="hb-card">
      <p className="hb-muted">
        {s.source.label}
        {s.period && ` · ${s.period.from} ~ ${s.period.to}`} · 전체 {won(s.total)}건
      </p>
      <table className="hb-table">
        <tbody>
          <tr>
            <th>새로 추가</th>
            <td>
              {won(s.new)}건
              <span className="hb-muted">
                {" "}
                (지출 {won(s.newByKind.expense)} · 수입 {won(s.newByKind.income)} · 이체 {won(s.newByKind.transfer)})
              </span>
            </td>
          </tr>
          {s.review > 0 && (
            <tr>
              <th>확인 필요</th>
              <td>
                {won(s.review)}건 <span className="hb-muted">(분류 안 된 이체, 저장 후 정리)</span>
              </td>
            </tr>
          )}
          <tr>
            <th>이미 있음</th>
            <td>{won(s.duplicates)}건</td>
          </tr>
          <tr>
            <th>제외</th>
            <td>
              {won(excludedTotal)}건
              {excluded.length > 0 && (
                <span className="hb-muted"> ({excluded.map(([k, n]) => `${k} ${won(n)}`).join(" · ")})</span>
              )}
            </td>
          </tr>
          {s.skipped.length > 0 && (
            <tr>
              <th>읽지 못함</th>
              <td>
                {s.skipped.length}건
                <ul className="hb-muted">
                  {s.skipped.slice(0, 10).map((k) => (
                    <li key={k.row}>
                      {k.row}: {k.reason}
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          )}
          {s.snapshot && (
            <tr>
              <th>재무 현황</th>
              <td>
                대출 {s.snapshot.loans}건 · 자산 {s.snapshot.assets}건 · 투자 {s.snapshot.investments}건
                <span className="hb-muted"> (연말정산 대출 이자 계산에 써요. 이름·연락처는 저장 안 함)</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

type ReceiptState =
  | { step: "idle" }
  | { step: "loading" }
  | { step: "preview"; receipts: Awaited<ReturnType<Awaited<ReturnType<typeof loadPreparer>>["prepareCashReceipts"]>>; data: CashReceiptPreview }
  | { step: "done"; data: CashReceiptPreview }
  | { step: "error"; message: string };

const OUTCOME_LABEL = { existing: "이미 있는 거래와 연결", added: "새 지출로 추가", cancelled: "취소 거래" } as const;

/** 현금영수증 목록(CSV) 가져오기 */
function CashReceiptImport() {
  const [state, setState] = useState<ReceiptState>({ step: "idle" });

  async function run(input: File | Extract<ReceiptState, { step: "preview" }>["receipts"], commit: boolean) {
    setState({ step: "loading" });
    try {
      const receipts = input instanceof File ? await (await loadPreparer()).prepareCashReceipts(input) : input;
      const data = await ledgerApi.importCashReceipts(receipts, commit);
      setState(commit ? { step: "done", data } : { step: "preview", receipts, data });
    } catch (e) {
      setState({ step: "error", message: (e as Error).message });
    }
  }

  return (
    <div className="cr-section">
      <h2>현금영수증 가져오기</h2>
      <p className="hb-muted">
        현금영수증 목록(CSV)을 올리면 뱅크샐러드로 이미 들어온 결제(간편결제·계좌이체)와 연결하고, 없는 건 새 지출로 추가해요.
        연말정산 카드의 현금영수증 금액도 이 목록으로 계산돼요.
      </p>
      <label className={`hb-button is-secondary lg-file ${state.step === "loading" ? "is-disabled" : ""}`}>
        현금영수증 CSV 선택
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void run(file, false);
            e.target.value = "";
          }}
        />
      </label>
      {state.step === "loading" && <p className="hb-muted">읽는 중…</p>}
      {state.step === "error" && <p className="hb-error">{state.message}</p>}
      {(state.step === "preview" || state.step === "done") && (
        <div className="hb-card">
          <p className="hb-muted">
            전체 {state.data.total}건 · {won(state.data.amount)}원
            {state.data.duplicates > 0 && ` · 이미 가져온 ${state.data.duplicates}건 제외`}
          </p>
          <table className="hb-table">
            <tbody>
              <tr><th>연결</th><td>{state.data.existing}건 <span className="hb-muted">(이미 있는 거래에 &lsquo;현금영수증 발급&rsquo; 표시)</span></td></tr>
              <tr><th>새 지출</th><td>{state.data.added}건 <span className="hb-muted">(뱅크샐러드에 없던 결제)</span></td></tr>
              {state.data.cancelled > 0 && <tr><th>취소</th><td>{state.data.cancelled}건</td></tr>}
              {state.data.skipped.length > 0 && <tr><th>읽지 못함</th><td>{state.data.skipped.length}건</td></tr>}
            </tbody>
          </table>
          {state.data.rows.length > 0 && (
            <details className="cr-rows">
              <summary>한 건씩 보기</summary>
              <table>
                <tbody>
                  {state.data.rows.map((r) => (
                    <tr key={r.approvalNo}>
                      <td>{r.date}</td>
                      <td>{r.merchant}</td>
                      <td className="num">{won(r.amount)}</td>
                      <td className="hb-muted">
                        {OUTCOME_LABEL[r.outcome]}
                        {r.match && ` · ${r.match.date} ${r.match.merchant}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          {state.step === "preview" ? (
            <button className="hb-button" disabled={state.data.rows.length === 0} onClick={() => void run(state.receipts, true)}>
              {state.data.rows.length === 0 ? "새로 저장할 게 없어요" : `${state.data.rows.length}건 저장`}
            </button>
          ) : (
            <strong>저장했어요.</strong>
          )}
        </div>
      )}
    </div>
  );
}
