import type { ComponentType } from "react";

/** 앱(apps/*)이 웹 화면 쪽에 제공하는 계약. host 의 내비게이션·라우터에 등록된다. */
export interface WebModule {
  id: string;
  /** 내비게이션에 보일 이름 */
  title: string;
  /** 화면 경로 접두어. 예: "/ledger" */
  path: string;
  /** path 아래 모든 경로를 담당하는 루트 컴포넌트 (내부 라우팅은 앱이 처리) */
  Root: ComponentType;
}
