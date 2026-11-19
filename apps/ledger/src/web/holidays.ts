import { getHolidayPreset } from "@hyunbinseo/holidays-kr";
import { useEffect, useState } from "react";

/**
 * 대한민국 공휴일 (우주항공청 월력요항 기반 데이터, 설·추석 연휴·대체공휴일·선거일 포함).
 * 데이터가 없는 연도는 빈 값으로 둔다. 매년 패키지를 업데이트하면 다음 해 공휴일이 추가된다.
 */
export function useHolidays(days: string[]): Map<string, readonly string[]> {
  const [holidays, setHolidays] = useState(new Map<string, readonly string[]>());
  const years = [...new Set(days.map((d) => d.slice(0, 4)))].join(",");

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      years.split(",").map((y) => getHolidayPreset(y).catch(() => ({}) as Record<string, readonly string[]>)),
    ).then((presets) => {
      if (!cancelled) setHolidays(new Map(presets.flatMap((p) => Object.entries(p))));
    });
    return () => {
      cancelled = true;
    };
  }, [years]);

  return holidays;
}
