/** homebase 카테고리 목록 (2026-09-30 사용자와 정함). 서버(자동 분류)와 화면(선택기)이 같이 쓴다 */

/** 표시 순서대로. 대분류 → 소분류. income 은 수입 카테고리 (선택기에서 수입일 때만 보임) */
export const CATEGORY_TREE: { major: string; minors: string[]; income?: true }[] = [
  { major: "식비", minors: ["중식", "외식", "배달", "식재료"] },
  { major: "카페/간식", minors: ["커피/음료", "베이커리/디저트"] },
  { major: "생활", minors: ["마트/생필품", "편의점", "가구/가전"] },
  { major: "쇼핑", minors: ["온라인쇼핑", "옷/신발"] },
  { major: "주거", minors: ["대출 이자", "월세", "관리비", "전기세", "가스비", "인테리어", "이사"] },
  { major: "통신/구독", minors: ["휴대폰", "인터넷", "구독"] },
  { major: "교통", minors: ["대중교통", "택시", "기차/버스"] },
  { major: "의료/건강", minors: ["병원", "약국", "의료기기", "운동"] },
  { major: "문화/여가", minors: ["웹툰/웹소설", "게임", "영화/공연", "놀이"] },
  { major: "미용", minors: ["헤어", "화장품"] },
  { major: "보험", minors: [] },
  { major: "모임/경조사", minors: ["모임 회비", "선물", "경조사"] },
  { major: "세금/수수료", minors: [] },
  // 수입
  { major: "급여", minors: ["급여", "상여/정산"], income: true },
  { major: "금융수입", minors: ["이자", "캐시백/리워드"], income: true },
  { major: "기타", minors: [], income: true },
];

export const INCOME_MAJORS: ReadonlySet<string> = new Set(CATEGORY_TREE.filter((g) => g.income).map((g) => g.major));
export const EXPENSE_MAJORS: ReadonlySet<string> = new Set(CATEGORY_TREE.filter((g) => !g.income).map((g) => g.major));
