import type { WebModule } from "@homebase/core/web";
import { LedgerRoot } from "./LedgerRoot.tsx";

export const ledgerWeb: WebModule = {
  id: "ledger",
  title: "가계부",
  path: "/ledger",
  Root: LedgerRoot,
};
