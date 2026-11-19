import type { WebModule } from "@homebase/core/web";
import { CalendarRoot } from "./CalendarRoot.tsx";

export const calendarWeb: WebModule = {
  id: "calendar",
  title: "일정",
  path: "/calendar",
  Root: CalendarRoot,
};
