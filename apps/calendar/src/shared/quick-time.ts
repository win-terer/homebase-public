/**
 * 제목에 적은 시각을 읽어 내고 **제목에서는 지운다.**
 *
 * 일정은 거의 늘 "몇 시에 무엇" 이다. 그런데 시각 칸을 따로 두면 제목 → 종일 끄기 → 시 →
 * 분, 네 번을 만져야 한다. 그래서 `09:00 치과` 처럼 **제목 한 줄에 같이 적게** 하고, 저장할
 * 때 시각만 떼어 낸다 (사용자 요청 2026-10-06).
 *
 * 읽는 모양: `09:00` · `9:30` · `9시` · `9시 30분` · `9시반` · `오후 7시` · `저녁 7:30` ·
 * `09:00~10:30`(끝 시각까지). 앞뒤 어디에 있어도 되고, 붙어 있는 `에`·`쯤` 까지 지운다.
 *
 * **아무 숫자나 시각으로 보지 않는다** — `:` 나 `시` 가 있어야 한다. 그래서 "3팀 회의" 는
 * 그대로 남고, `시간` 은 시각이 아니므로 "7시간 운동" 도 건드리지 않는다.
 */

/** 오전/오후 말머리 → 12시간 보정 */
const BEFORE_NOON = new Set(["오전", "아침", "새벽"]);
const AFTER_NOON = new Set(["오후", "점심", "저녁"]);

/**
 * 시각 한 덩어리. `시` 뒤에 `간` 이 붙으면(= 시간) 시각이 아니므로 뺀다.
 * 마지막 칸들: 말머리 · 시 · (시 뒤 분) · 반 · (콜론 뒤 분)
 */
const TOKEN = /(?:(오전|오후|아침|점심|저녁|밤|새벽)\s*)?(\d{1,2})(?:\s*시(?!간)\s*(?:(\d{1,2})\s*분?|(반))?|:(\d{2}))/;
/** 두 시각 사이 (9시~11시) */
const SPAN = /^\s*(?:~|-|–|—|부터|에서)\s*/;
/** 시각에 붙어 다니는 토씨 — 같이 지워야 "회의 에" 가 남지 않는다 */
const TAIL = /^(?:에|쯤|경)(?![가-힣])/;

const pad = (n: number) => String(n).padStart(2, "0");

/** 한 덩어리를 `HH:MM` 으로. 말이 안 되는 숫자(25시·70분)면 null */
function clock(m: RegExpExecArray): string | null {
  const [, meridiem, hourText, minuteAfterSi, half, minuteAfterColon] = m;
  let hour = Number(hourText);
  const minute = minuteAfterColon ? Number(minuteAfterColon) : half ? 30 : minuteAfterSi ? Number(minuteAfterSi) : 0;
  if (minute > 59) return null;
  if (meridiem === "밤") hour = hour === 12 ? 0 : hour < 12 ? hour + 12 : hour;
  else if (AFTER_NOON.has(meridiem ?? "")) hour = hour < 12 ? hour + 12 : hour;
  else if (BEFORE_NOON.has(meridiem ?? "")) hour = hour === 12 ? 0 : hour;
  if (hour === 24) hour = 0;
  if (hour > 23) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

interface Found {
  time: string;
  /** 제목에서 들어낼 범위 */
  start: number;
  end: number;
}

/** `text` 의 `from` 자리부터 시각 한 덩어리를 읽는다. 숫자 한가운데서 시작하는 건 시각이 아니다 */
function readAt(text: string, from: number): Found | null {
  const m = TOKEN.exec(text.slice(from));
  if (!m) return null;
  const start = from + m.index;
  // 긴 숫자 가운데(2024 의 "20")를 시각으로 보지 않는다 — 한 글자 건너뛰고 다시 본다
  if (start > 0 && /[0-9]/.test(text[start - 1]!)) return readAt(text, start + 1);
  const time = clock(m);
  if (!time) return readAt(text, start + m[0].length);
  return { time, start, end: start + m[0].length };
}

export interface QuickTime {
  /** 시각을 들어낸 제목 (앞뒤 공백·남은 구두점 정리) */
  title: string;
  startTime: string | null;
  endTime: string | null;
}

/** 제목에서 시각을 떼어 낸다. 시각이 없으면 제목은 그대로 */
export function parseQuickTime(raw: string): QuickTime {
  const text = raw;
  const first = readAt(text, 0);
  if (!first) return { title: raw.trim(), startTime: null, endTime: null };

  let cut = first.end;
  let endTime: string | null = null;
  const span = SPAN.exec(text.slice(cut));
  if (span) {
    const second = readAt(text, cut + span[0].length);
    // 바로 뒤에 붙은 것만 끝 시각으로 본다 ("9시 회의 ~ 10시 보고" 를 한 덩어리로 묶지 않게)
    if (second && second.start === cut + span[0].length) {
      endTime = second.time;
      cut = second.end;
    }
  }
  const tail = TAIL.exec(text.slice(cut));
  if (tail) cut += tail[0].length;

  const title = (text.slice(0, first.start) + " " + text.slice(cut)).replace(/\s+/g, " ").replace(/^[\s,·-]+|[\s,·-]+$/g, "").trim();
  return { title, startTime: first.time, endTime };
}
