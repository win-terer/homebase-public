import { won, type SplitPart, type Transaction } from "./api.ts";

/**
 * **한 번 결제한 것이 여러 줄로 갈려 들어온 것**을 한 줄로 묶는다 (화면 계산, DB 는 그대로).
 *
 * 네이버페이로 한 번 결제하면 남은 포인트가 먼저 빠지고 나머지가 카드로
 * 나간다. 뱅크샐러드는 그 둘을 **따로** 적어 준다. 달력에는 같은 시각에 두 줄이 서서, 한 번
 * 산 물건이 두 번 산 것처럼 보인다 (사용자 지적 2026-11-12).
 *
 * 1년치 1,900여 건에서 **78묶음**이 나왔고(세 줄로 갈린 것도 6묶음) 전부 진짜 한 결제였다.
 *
 * ## 묶는 잣대 — 같은 날 · 같은 초 · 같은 가게 · 같은 부호
 *
 * 시각이 **초까지** 같아야 한다. 같은 가게에서 같은 초에 두 번 결제하는 일은 없다.
 * 부호까지 같아야 하는 이유: `-20,500` 과 `+20,500` 이 같은 초에 있는 건 쪼개진 결제가 아니라
 * **그 자리에서 취소한 것**이다(실제로 있다). 그건 `pairCancels` 몫이라 여기서 건드리면 안 된다.
 *
 * ## 대표 줄
 *
 * **메모가 달린 줄**을 앞세운다 — 사람이 적어 둔 것이 달력에 보여야 한다. 메모가 없으면 금액이
 * 가장 큰 줄. 실제 78묶음 중 메모가 두 줄에 걸린 건 **0건**이라 어느 쪽을 골라도 잃는 게 없다.
 * 분류·태그·사진도 대표 줄 것을 쓰고, 메모를 고치면 대표 줄에 저장된다(진짜 id 라 그대로 통한다).
 *
 * ## 합치지 않는 곳
 *
 * **연말정산**(`TaxCard.tsx`)은 원래 줄 그대로 본다. 공제는 결제수단별로 갈리는데 — 카드와
 * 통장으로 갈린 결제가 실제로 있다 — 합치면 통장 몫까지 카드 공제로 샌다.
 */

/** 묶인 줄에 붙는 칸 — `Transaction.splitParts` (칸 자체는 api.ts 의 `SplitPart`) */
export type SplitParts = readonly SplitPart[];

const keyOf = (t: Transaction) => `${t.date}|${t.time}|${t.rawMerchant ?? t.merchant}`;
const bigger = (a: Transaction, b: Transaction) => Math.abs(b.amount) - Math.abs(a.amount) || a.id - b.id;

/**
 * 갈려 들어온 줄들을 한 줄로 합친 목록을 돌려준다. 순서는 그대로.
 *
 * **`pairCancels` 보다 먼저** 부른다 — 합쳐 두면 쪼개진 결제의 쪼개진 환불도 금액이 맞아
 * 저절로 짝이 된다(실제로 록시땅 결제·환불이 둘 다 두 줄로 들어왔다).
 */
export function mergeSplits(txs: Transaction[]): Transaction[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of txs) {
    if (t.kind !== "expense" || !t.time) continue;
    const list = groups.get(keyOf(t));
    if (list) list.push(t);
    else groups.set(keyOf(t), [t]);
  }
  /** 대표 줄 id → 합친 줄 */
  const merged = new Map<number, Transaction>();
  /** 대표가 아닌 줄 id — 목록에서 뺀다 */
  const folded = new Set<number>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // 같은 초에 부호가 섞여 있으면 그 자리에서 취소한 것이다 — pairCancels 가 맡는다
    if (!members.every((m) => m.amount < 0) && !members.every((m) => m.amount > 0)) continue;
    const head = members.find((m) => m.memo) ?? [...members].sort(bigger)[0]!;
    const parts = [...members].sort(bigger).map((m) => ({ id: m.id, amount: m.amount, paymentMethod: m.paymentMethod }));
    merged.set(head.id, { ...head, amount: members.reduce((sum, m) => sum + m.amount, 0), splitParts: parts });
    for (const m of members) if (m.id !== head.id) folded.add(m.id);
  }
  if (!merged.size) return txs;
  return txs.flatMap((t) => {
    const m = merged.get(t.id);
    if (m) return [m];
    return folded.has(t.id) ? [] : [t];
  });
}

/**
 * 결제수단을 구성 줄에 쓸 짧은 말로. `네이버페이 간편결제(포인트)` → `포인트`,
 * `카카오페이 머니` → `머니`, `네이버페이 간편결제` → `간편결제`. 카드·통장 이름은 그대로.
 */
export function partLabel(method: string | null): string {
  const m = (method ?? "").trim();
  const inner = /\(([^)]+)\)\s*$/.exec(m);
  if (inner) return inner[1]!;
  if (/페이\s*머니$/.test(m)) return "머니";
  if (/간편결제$/.test(m)) return "간편결제";
  return m || "결제";
}

/** `포인트 1,300 + 간편결제 14,000` — 날짜 상세·설명 상자에 적는 구성 */
export function splitSummary(parts: SplitParts): string {
  return parts.map((p) => `${partLabel(p.paymentMethod)} ${won(Math.abs(p.amount))}`).join(" + ");
}
