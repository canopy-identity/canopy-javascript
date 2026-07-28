import type { components, operations } from "./generated/types.js";

/**
 * Type plumbing that pulls request and response shapes straight out of the
 * generated operations.
 *
 * Every resource method is typed through these rather than by hand-writing an
 * interface. That is the whole discipline of this package: if the API adds a
 * required field, `npm run generate` brings it in and the call site stops
 * compiling. A hand-written mirror would keep compiling and start lying.
 */

/** Any operation id in the public API. */
export type OperationId = keyof operations;

/** The JSON request body an operation accepts, or `never` if it takes none. */
export type RequestBody<Id extends OperationId> = operations[Id] extends {
  requestBody: { content: { "application/json": infer Body } };
}
  ? Body
  : operations[Id] extends {
        requestBody?: { content: { "application/json": infer Body } };
      }
    ? Body
    : never;

/**
 * The JSON payload of an operation's success response, with Canopy's envelope
 * already removed — `{ data }` unwrapped, collections left whole — matching
 * what `CanopyClient.request` actually returns.
 */
export type ResponseBody<Id extends OperationId> = Unwrap<SuccessJson<Id>>;

type SuccessJson<Id extends OperationId> =
  operations[Id]["responses"] extends infer Responses
    ? Responses extends Record<string, unknown>
      ? SuccessOf<Responses>
      : never
    : never;

// 200, 201 and 207 are the success codes this API returns; 204 carries nothing.
type SuccessOf<Responses> = Responses extends {
  200: { content: { "application/json": infer Json } };
}
  ? Json
  : Responses extends { 201: { content: { "application/json": infer Json } } }
    ? Json
    : Responses extends { 207: { content: { "application/json": infer Json } } }
      ? Json
      : undefined;

/** Mirrors the envelope handling in `CanopyClient.request`. */
type Unwrap<Json> = Json extends { data: infer Data } ? Data : Json;

/** Query parameters an operation accepts, when it declares any. */
export type QueryParams<Id extends OperationId> = operations[Id] extends {
  parameters: { query?: infer Query };
}
  ? NonNullable<Query>
  : Record<string, never>;

/** Shorthand for a named schema, e.g. `Schema<"EvaluateResponseDto">`. */
export type Schema<Name extends keyof components["schemas"]> =
  components["schemas"][Name];
