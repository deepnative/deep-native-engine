import type { Pool } from "pg";
import type { InvoiceResult } from "./simple-invoice-store.ts";
export interface TestProviderEvent {
  id: string;
}
export const testProviderEventStore = (_pool: Pool) => ({
  apply: async (_event: TestProviderEvent): Promise<InvoiceResult<{ outcome: string }>> => ({
    kind: "unavailable",
  }),
});
export type TestProviderEventStore = ReturnType<typeof testProviderEventStore>;
