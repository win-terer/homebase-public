import type { SqlDb } from "@homebase/db";
import { categorize } from "../importers/categorize.ts";
import { ensureCategories } from "./categories.ts";
import { categoryRuleKey } from "./memos.ts";
import type { ParsedNotification } from "./notify-parse.ts";

/**
 * 폰 알림으로 만든 임시 거래의 카테고리.
 *
 * 알림에는 분류가 없다. 그래서 "오늘 쓴 돈" 은 보여도 "뭐에 썼나" 는 엑셀이 올 때까지
 * 미분류로 남았다. 아는 만큼은 채운다 — 순서는 **사람이 정한 것부터**:
 *
 * 1. `notify.category.<가맹점>` — 앱알림 줄에서 사용자가 직접 고른 분류. 알림의 가맹점
 *    이름(결제대행사 이름일 때가 많다)으로 기억해 둔다. 엑셀 가맹점 이름과 달라서
 *    가져오기 규칙(`category.rule.*`)만으로는 못 맞추는 경우를 메운다.
 * 2. `category.rule.<금액>.<가맹점>` — 가져오기 때 쓰는 "같은 가게·같은 금액" 규칙.
 * 3. `categorize()` 의 가맹점 이름 규칙(약국·병원·쿠팡·멤버십 …).
 *
 * 어느 것이든 `category_source = 'rule'` 로 둔다. 엑셀이 덮을 때 **사람이 고른 분류만**
 * 옮겨 붙이므로(`imports.ts`), 여기서 추측한 분류는 엑셀 분류를 밀어내지 않는다.
 */
export const notifyCategoryKey = (merchant: string) => `notify.category.${merchant}`;

/**
 * **여러 가게가 같은 이름으로 찍히는 곳** — 결제대행사·간편결제·포괄 명칭.
 *
 * 폰 알림에는 가게 이름 대신 이런 이름이 올 때가 많다(네이버페이로 결제 → "네이버페이").
 * 그런 이름으로 분류를 기억해 두면 **그 뒤 모든 결제가 그 분류로 끌려간다.** 실제로 네이버페이로
 * 낸 미용실 결제 한 번을 '미용 > 헤어' 로 고른 것이 네이버페이 알림 전체에 붙어 있었다
 * (2026-11-12 사용자 지적. '인터넷상거래 → 게임' 도 같은 경우였다).
 *
 * 한 가게가 아니므로 **기억하지 않는다.** 금액까지 묶는 `category.rule.<금액>.<가게>` 는
 * 같은 가게·같은 금액일 때만 걸려서 그대로 둔다.
 */
const PASSTHROUGH =
  /네이버페이|네이버파이낸셜|카카오페이|토스페이|토스페이먼츠|페이코|PAYCO|한국결제네트웍스|이니시스|나이스페이|나이스정보통신|다날|헥토|올더게이트|KSNET|세틀뱅크|스마일페이|인터넷상거래|간편결제|쿠페이|KOMOJU|PayerMax|페이먼츠|결제대행/i;

/** 가게 하나로 볼 수 없는 이름인가 (결제대행사·포괄 명칭) */
export const isPassthroughMerchant = (merchant: string): boolean => PASSTHROUGH.test(merchant);

export async function notifyCategory(db: SqlDb, tx: ParsedNotification): Promise<number | null> {
  // 설정 두 개를 한 번에. 지워진 카테고리를 가리키는 설정은 JOIN 에서 빠진다
  const rows = (
    await db
      .prepare(
        `SELECT s.key, s.value FROM ledger_settings s JOIN ledger_categories c ON c.id = CAST(s.value AS INTEGER)
         WHERE s.key IN (?, ?)`,
      )
      .bind(notifyCategoryKey(tx.merchant), categoryRuleKey(tx.merchant, tx.amount))
      .all<{ key: string; value: string }>()
  ).results;
  const pick = (key: string) => rows.find((r) => r.key === key)?.value;
  // 금액까지 묶은 규칙이 **더 좁으므로 먼저** 본다 (가게 이름만 보는 쪽은 결제대행사일 수 있다)
  const remembered = pick(categoryRuleKey(tx.merchant, tx.amount)) ?? pick(notifyCategoryKey(tx.merchant));
  if (remembered) return Number(remembered);

  const pair = categorize({ kind: tx.kind, date: tx.date, time: tx.time, merchant: tx.merchant });
  if (!pair) return null;
  const ids = await ensureCategories(db, [pair]);
  return ids.get(`${pair.major}\u001f${pair.minor ?? ""}`) ?? null;
}

/**
 * 앱알림 줄에서 사용자가 분류를 고르면(또는 비우면) 같은 가맹점 이름의 다음 알림에도 쓰게 기억한다.
 * **결제대행사 이름은 기억하지 않는다** (위 PASSTHROUGH 참고) — 지우는 건 언제나 된다.
 */
export async function rememberNotifyCategory(db: SqlDb, merchant: string, categoryId: number | null): Promise<void> {
  if (categoryId !== null && isPassthroughMerchant(merchant)) return;
  if (categoryId === null) {
    await db.prepare("DELETE FROM ledger_settings WHERE key = ?").bind(notifyCategoryKey(merchant)).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO ledger_settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(notifyCategoryKey(merchant), String(categoryId))
    .run();
}
