/**
 * 가맹점 표시 이름. 같은 곳이 이름만 다르게 찍힌 것을 하나로 묶는다.
 * DB 에는 소스에 찍힌 원래 이름을 그대로 두고, 화면·통계에 보여줄 때만 바꾼다.
 */

/** 앞뒤의 법인 표기 */
const CORPORATE_MARKS = /^(?:\(주\)|㈜|주식회사|\(유\)|유한회사)\s*|\s*(?:\(주\)|㈜|주식회사)$/g;

/** 운영사 이름으로 찍히는 서비스 (법인 표기를 뗀 이름 → 보여줄 이름) */
const KNOWN_ALIASES: Record<string, string> = {
  버킷플레이스: "오늘의집",
  오늘의집페이: "오늘의집",
  // 자주 가는 곳이 운영사 이름이나 잘린 이름으로 찍히면 여기에 한 줄 더하면 된다.
  // 예) 송금 받는 이름이 잘려서 찍힌 경우: "○○인테": "○○인테리어"
};

/** 법인 표기를 떼고 알려진 별칭을 적용한 이름 */
export function displayMerchant(name: string): string {
  const stripped = name.replace(CORPORATE_MARKS, "").trim() || name;
  return KNOWN_ALIASES[stripped] ?? stripped;
}

/**
 * 같은 곳인지 비교하는 키. 카드사마다 띄어쓰기·괄호·밑줄을 다르게 찍어서
 * ('○○버거 ○○점' / '○○버거○○점', '쿠팡_쿠페이' / '쿠팡(쿠페이)') 이것들을 뺀다.
 */
export function merchantKey(name: string): string {
  return displayMerchant(name).replace(/[\s_()[\]\-·.,/]/g, "").toLowerCase();
}

/**
 * 원래 이름 → 보여줄 이름. 키가 같은 이름들 중 가장 많이 쓰인 표기로 통일한다
 * (같으면 띄어쓰기가 있는 쪽, 그다음 긴 쪽).
 */
export function buildDisplayMap(rows: { merchant: string; n: number }[]): Map<string, string> {
  const groups = new Map<string, { name: string; n: number }[]>();
  for (const r of rows) {
    const k = merchantKey(r.merchant);
    const list = groups.get(k) ?? [];
    const name = displayMerchant(r.merchant);
    const existing = list.find((x) => x.name === name);
    if (existing) existing.n += r.n;
    else list.push({ name, n: r.n });
    groups.set(k, list);
  }
  const best = new Map<string, string>();
  for (const [k, list] of groups) {
    list.sort((a, b) => b.n - a.n || Number(b.name.includes(" ")) - Number(a.name.includes(" ")) || b.name.length - a.name.length);
    best.set(k, list[0]!.name);
  }
  return new Map(rows.map((r) => [r.merchant, best.get(merchantKey(r.merchant))!]));
}
