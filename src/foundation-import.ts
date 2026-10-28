import type { Pool } from "pg";
import { reviewedFoundation } from "./foundation-pack.ts";
import { reviewedContentImportStore } from "./reviewed-content-import.ts";
export type {
  ReviewedContentImportResult as FoundationImportResult,
  ReviewedContentImportStore as FoundationImportStore,
} from "./reviewed-content-import.ts";

export function foundationImportStore(pool: Pool) {
  return reviewedContentImportStore(pool, reviewedFoundation, 117);
}
