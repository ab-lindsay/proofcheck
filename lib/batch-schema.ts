import { z } from "zod";
import { BeverageTypeSchema } from "./schema";

// There is deliberately no batch *request* schema here. `POST /api/batch` takes multipart form data
// (one `images` entry per file plus an `applications` JSON array), and it validates each
// application independently with `ApplicationDataSchema` so one unusable row cannot reject the whole
// batch (invariant 7, fail closed per item). A whole-request schema would have to reject the batch
// as a unit, which is exactly the behaviour that invariant forbids.

/** One item's result. The route validates its own response against this before returning, so a
 *  shape drift fails loudly here rather than silently in a consumer.
 *
 *  Both objects are STRICT on purpose. Zod's default is to strip unknown keys, which would make
 *  additive drift silent in the worst way: a field deliberately added to the row (an extraction
 *  trace, say) would be quietly deleted from the response and the feature would look broken with no
 *  error anywhere. Strict turns that into an immediate failure in the route's own tests. The cost is
 *  a real coupling — adding a property to a row, or to `FieldResult` in lib/schema, requires adding
 *  it here too. That is the point of a validated contract, and it is one file. */
export const BatchRowResultSchema = z.strictObject({
  filename: z.string(),
  overall: z.enum(["APPROVED", "NEEDS_CORRECTION", "REJECTED"]),
  fields: z.array(
    z.strictObject({
      field: z.string(),
      applicationValue: z.string().nullable(),
      labelValue: z.string().nullable(),
      verdict: z.enum(["COMPLIANT", "NON_COMPLIANT", "NEEDS_CORRECTION"]),
      reason: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  warnings: z.array(z.string()),
  processingMs: z.number(),
  // "unknown" for an item that never reached extraction — a rejected image, or application data
  // that failed to parse. Such an item has no tier, provider, or beverage type to report, and it
  // carries `error` with the plain-English reason instead.
  tier: z.string(),
  provider: z.string(),
  beverageType: z.union([BeverageTypeSchema, z.literal("unknown")]),
  error: z.string().optional(),
});
export type BatchRowResult = z.infer<typeof BatchRowResultSchema>;

export const BatchResponseSchema = z.strictObject({
  results: z.array(BatchRowResultSchema),
  totalMs: z.number(),
});
export type BatchResponse = z.infer<typeof BatchResponseSchema>;
