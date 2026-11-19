/**
 * homebase 카테고리 (2026-09-30 사용자와 정함) 와 자동 분류.
 * 뱅크샐러드 분류는 그대로 쓰지 않고 이 목록으로 옮긴다. 분류가 없으면 가맹점 이름 규칙으로 정한다.
 * 가져오기(서버)와 기존 기록 재분류(recategorize.ts)가 같은 함수를 쓴다.
 */
import { isOffDay } from "./business-days.ts";
import { CATEGORY_TREE } from "./category-tree.ts";

export interface CategoryPair {
  major: string;
  minor?: string;
}

export { CATEGORY_TREE, INCOME_MAJORS } from "./category-tree.ts";

/** 가맹점 이름 규칙 (위에서부터 먼저 맞는 것). 뱅크샐러드 분류가 없거나 뭉뚱그려진 지출에 쓴다 */
const MERCHANT_RULES: [RegExp, CategoryPair][] = [
  [/약국/, { major: "의료/건강", minor: "약국" }],
  [/의원|병원|치과|한의원|이비인후과|내과|외과|피부과|안과/, { major: "의료/건강", minor: "병원" }],
  [/헬스|피트니스|필라테스|요가/, { major: "의료/건강", minor: "운동" }],
  [/헤어|미용실|바버/, { major: "미용", minor: "헤어" }],
  [/록시땅|올리브영|이니스프리|아리따움/, { major: "미용", minor: "화장품" }],
  [/멤버십|SUBSCRIPTION|GITHUB|Apple Inc|넷플릭스|NETFLIX|유튜브|YOUTUBE|쿠팡플레이|티빙|웨이브|디즈니/i, { major: "통신/구독", minor: "구독" }],
  [/^시리즈$|네이버웹툰|카카오페이지|리디/, { major: "문화/여가", minor: "웹툰/웹소설" }],
  [/KOMOJU|PayerMax|카카오게임즈|넥슨|엔씨소프트|넷마블|STEAM|닌텐도|PlayStation/i, { major: "문화/여가", minor: "게임" }],
  [/시네마|CGV|메가박스|인터파크티켓|예스24티켓/i, { major: "문화/여가", minor: "영화/공연" }],
  [/PC카페|PC방|오락실|노래방|코인노래/i, { major: "문화/여가", minor: "놀이" }],
  // PC카페 뒤에 — '카페' 가 겹친다. 폰 알림(토스)은 뱅샐 분류가 없어 가게 이름으로만 정한다
  [/커피|카페|CAFE|COFFEE|스타벅스|투썸|이디야|메가MGC|빽다방|컴포즈|할리스|폴바셋|탐앤탐스|더벤티|파스쿠찌|공차|매머드/i, { major: "카페/간식", minor: "커피/음료" }],
  [/베이커리|파리바게뜨|파리바게트|뚜레쥬르|던킨|배스킨|베스킨|설빙|디저트|도넛|와플/i, { major: "카페/간식", minor: "베이커리/디저트" }],
  [/쿠팡|G마켓|지마켓|11번가|십일번가|토스쇼핑|옥션|SSG|마리오쇼핑|쓰리잘비|오늘의집|버킷플레이스|알리익스프레스|테무/i, { major: "쇼핑", minor: "온라인쇼핑" }],
  [/유니클로|스케쳐스|LF ?MALL|무신사|자라|ZARA|탑텐|나이키|아디다스/i, { major: "쇼핑", minor: "옷/신발" }],
  [/백화점|아울렛/, { major: "쇼핑" }],
  [/인테리어/, { major: "주거", minor: "인테리어" }],
  [/서울특별시|세외수입|구청|시청|법무법인|등기|국세|지방세/, { major: "세금/수수료" }],
];

/** 뱅크샐러드 대분류·소분류 → homebase 분류 (식비는 시간으로 따로 정한다) */
const BANKSALAD_MAP: Record<string, Record<string, CategoryPair> & { "*"?: CategoryPair }> = {
  교통: { 대중교통: { major: "교통", minor: "대중교통" }, 택시: { major: "교통", minor: "택시" }, 철도: { major: "교통", minor: "기차/버스" }, 시외버스: { major: "교통", minor: "기차/버스" }, 고속버스: { major: "교통", minor: "기차/버스" }, "*": { major: "교통" } },
  생활: { 마트: { major: "생활", minor: "마트/생필품" }, 생필품: { major: "생활", minor: "마트/생필품" }, 편의점: { major: "생활", minor: "편의점" }, "가구/가전": { major: "생활", minor: "가구/가전" } },
  "주거/통신": { 관리비: { major: "주거", minor: "관리비" }, 전기세: { major: "주거", minor: "전기세" }, 가스비: { major: "주거", minor: "가스비" }, 휴대폰: { major: "통신/구독", minor: "휴대폰" }, 인터넷: { major: "통신/구독", minor: "인터넷" }, "*": { major: "주거" } },
  "카페/간식": { "커피/음료": { major: "카페/간식", minor: "커피/음료" }, "*": { major: "카페/간식", minor: "베이커리/디저트" } },
  "의료/건강": { 약국: { major: "의료/건강", minor: "약국" }, "*": { major: "의료/건강" } },
  "문화/여가": { 영화: { major: "문화/여가", minor: "영화/공연" }, 공연: { major: "문화/여가", minor: "영화/공연" }, 게임: { major: "문화/여가", minor: "게임" }, "*": { major: "문화/여가" } },
  "뷰티/미용": { 헤어: { major: "미용", minor: "헤어" }, "*": { major: "미용" } },
  쇼핑: { "*": { major: "쇼핑" } },
  "온라인쇼핑": { "*": { major: "쇼핑", minor: "온라인쇼핑" } },
  "패션/쇼핑": { "*": { major: "쇼핑", minor: "옷/신발" } },
  보험: { "*": { major: "보험" } },
  "세금/공과금": { "*": { major: "세금/수수료" } },
};

/** 출근한 날 점심: 평일(공휴일 제외) 11:00~13:59 */
export function isWorkLunch(date: string, time: string | null): boolean {
  if (!time) return false;
  if (isOffDay(date)) return false;
  return time >= "11:00:00" && time < "14:00:00";
}

export interface CategorizeInput {
  kind: "expense" | "income" | "transfer";
  date: string;
  time: string | null;
  merchant: string;
  /** 소스(뱅크샐러드) 분류 */
  sourceCategory?: { major: string; minor?: string } | null;
  /** 저장된 메모 (첫 줄 = 한 줄 메모, 나머지 = 상세). 지금은 안 쓰지만 호출하는 쪽이 통째로 넘긴다 */
  memo?: string | null;
}

const clean = (s: string | undefined) => (s && s !== "미분류" ? s : undefined);

/** homebase 카테고리를 정한다. 정할 수 없으면 null (미분류). 이체는 항상 null */
export function categorize(tx: CategorizeInput): CategoryPair | null {
  if (tx.kind === "transfer") return null;
  const major = clean(tx.sourceCategory?.major);
  const minor = clean(tx.sourceCategory?.minor);

  if (tx.kind === "income") {
    if (major === "급여") return /연말정산|퇴직|상여|성과/.test(tx.merchant) ? { major: "급여", minor: "상여/정산" } : { major: "급여", minor: "급여" };
    if (/리워드|캐시백|포인트/.test(tx.merchant)) return { major: "금융수입", minor: "캐시백/리워드" };
    if (major === "금융수입") return /이자|결산/.test(tx.merchant) ? { major: "금융수입", minor: "이자" } : { major: "금융수입" };
    return { major: "기타" };
  }

  // 지출
  if (major === "식비") {
    if (minor === "배달") return { major: "식비", minor: "배달" };
    if (minor === "식재료") return { major: "식비", minor: "식재료" };
    return { major: "식비", minor: isWorkLunch(tx.date, tx.time) ? "중식" : "외식" };
  }
  const byMerchant = MERCHANT_RULES.find(([re]) => re.test(tx.merchant))?.[1];
  const table = major ? BANKSALAD_MAP[major] : undefined;
  const mapped = table ? ((minor ? table[minor] : undefined) ?? table["*"]) : undefined;
  if (mapped?.minor) return mapped;
  if (byMerchant) return byMerchant;
  if (mapped) return mapped;
  if (major) return { major, ...(minor ? { minor } : {}) }; // 모르는 뱅크샐러드 분류는 그대로
  return null;
}

/**
 * 예전 이름(뱅크샐러드 분류, 확인 필요 화면에서 만든 이름) → 새 분류.
 * 사용자가 규칙으로 직접 고른 카테고리를 옮길 때 쓴다. 여기 없는 이름은 그대로 둔다.
 */
export const RENAMED: Record<string, CategoryPair> = {
  "대출 이자": { major: "주거", minor: "대출 이자" },
  대출이자: { major: "주거", minor: "대출 이자" },
  대출: { major: "주거", minor: "대출 이자" },
  월세: { major: "주거", minor: "월세" },
  이사: { major: "주거", minor: "이사" },
  이사비: { major: "주거", minor: "이사" },
  인테리어: { major: "주거", minor: "인테리어" },
  의료: { major: "의료/건강" },
  병원: { major: "의료/건강", minor: "병원" },
  렌탈: { major: "의료/건강", minor: "의료기기" },
  양압기: { major: "의료/건강", minor: "의료기기" },
  헬스: { major: "의료/건강", minor: "운동" },
  운동: { major: "의료/건강", minor: "운동" },
  모임: { major: "모임/경조사", minor: "모임 회비" },
  회비: { major: "모임/경조사", minor: "모임 회비" },
  경조사: { major: "모임/경조사", minor: "경조사" },
  선물: { major: "모임/경조사", minor: "선물" },
  "주거/통신": { major: "주거" },
  관리비: { major: "주거", minor: "관리비" },
  전기세: { major: "주거", minor: "전기세" },
  가스비: { major: "주거", minor: "가스비" },
  휴대폰: { major: "통신/구독", minor: "휴대폰" },
  인터넷: { major: "통신/구독", minor: "인터넷" },
  용돈: { major: "기타" },
  앱테크: { major: "기타" },
  "기타수입": { major: "기타" },
};

const TREE_KEYS = new Set(CATEGORY_TREE.flatMap((g) => [`${g.major}\u001f`, ...g.minors.map((m) => `${g.major}\u001f${m}`)]));
export const pairKey = (p: CategoryPair) => `${p.major}\u001f${p.minor ?? ""}`;
export const inTree = (p: CategoryPair) => TREE_KEYS.has(pairKey(p));

/**
 * 이미 붙어 있는 카테고리(사용자가 고른 것)를 새 목록으로 옮길 곳. 새 목록에 이미 있으면 그대로,
 * 예전 이름이면 RENAMED 나 뱅크샐러드 대응표로, 모르면 null (그대로 둠).
 */
export function mapExistingCategory(parent: string | null, name: string): CategoryPair | null {
  const current = parent ? { major: parent, minor: name } : { major: name };
  if (inTree(current)) return current;
  const renamed = RENAMED[name];
  if (renamed) return renamed;
  if (parent === "식비" || name === "식비") return { major: "식비", minor: "외식" };
  const table = BANKSALAD_MAP[parent ?? name];
  const mapped = table ? ((parent ? table[name] : undefined) ?? table["*"]) : undefined;
  return mapped ?? null;
}
