import { z } from "zod";

import { jsonValueSchema } from "./json.js";

/**
 * Codex app-server uses JSON-RPC 2.0 message shapes while omitting the
 * `jsonrpc` member on the wire. IDs can originate from either peer.
 */
export const appServerMessageIdSchema = z.union([z.string(), z.number()]);

export type AppServerMessageId = z.infer<typeof appServerMessageIdSchema>;

export const appServerErrorObjectSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: jsonValueSchema.optional(),
  })
  .catchall(jsonValueSchema);

export const appServerRequestSchema = z
  .object({
    id: appServerMessageIdSchema,
    method: z.string().min(1),
    params: jsonValueSchema.optional(),
    result: z.never().optional(),
    error: z.never().optional(),
  })
  .catchall(jsonValueSchema);

export const appServerNotificationSchema = z
  .object({
    id: z.never().optional(),
    method: z.string().min(1),
    params: jsonValueSchema.optional(),
    result: z.never().optional(),
    error: z.never().optional(),
  })
  .catchall(jsonValueSchema);

export const appServerSuccessResponseSchema = z
  .object({
    id: appServerMessageIdSchema,
    method: z.never().optional(),
    params: z.never().optional(),
    result: jsonValueSchema,
    error: z.never().optional(),
  })
  .catchall(jsonValueSchema);

export const appServerErrorResponseSchema = z
  .object({
    id: appServerMessageIdSchema,
    method: z.never().optional(),
    params: z.never().optional(),
    result: z.never().optional(),
    error: appServerErrorObjectSchema,
  })
  .catchall(jsonValueSchema);

/**
 * Minimal lossless envelope used by the facade. Method-specific payloads stay
 * opaque so newer app-server fields can pass through without a bridge update.
 */
export const appServerEnvelopeSchema = z.union([
  appServerRequestSchema,
  appServerNotificationSchema,
  appServerSuccessResponseSchema,
  appServerErrorResponseSchema,
]);

export type AppServerErrorObject = z.infer<typeof appServerErrorObjectSchema>;
export type AppServerRequest = z.infer<typeof appServerRequestSchema>;
export type AppServerNotification = z.infer<typeof appServerNotificationSchema>;
export type AppServerSuccessResponse = z.infer<typeof appServerSuccessResponseSchema>;
export type AppServerErrorResponse = z.infer<typeof appServerErrorResponseSchema>;
export type AppServerEnvelope = z.infer<typeof appServerEnvelopeSchema>;
