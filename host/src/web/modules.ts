import type { WebModule } from "@homebase/core/web";
import { calendarWeb } from "@homebase/calendar/web";
import { ledgerWeb } from "@homebase/ledger/web";

/** 새 앱을 추가하면 여기에 등록한다. (서버 쪽은 src/server/modules.ts) */
export const webModules: WebModule[] = [calendarWeb, ledgerWeb];
