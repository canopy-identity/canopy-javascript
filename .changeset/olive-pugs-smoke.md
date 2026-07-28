---
"@canopy-io/node": minor
---

Cancellation, per-request headers, per-call deadlines, and two correctness fixes on the authorization path.

**Behavior change — `identities.assignments` is paginated.** It now returns a `Paginator` rather than a single response, and accepts query parameters. The endpoint is paginated at 20 per page; the previous signature returned only the first page while documenting itself as "every role this identity holds", so an identity with more than 20 assignments was silently under-reported — the dangerous direction to be wrong in on an authorization surface.

```ts
// before — first page only
const { items } = await canopy.identities.assignments(id);

// after — every page
const all = await canopy.identities.assignments(id).all();
for await (const assignment of canopy.identities.assignments(id)) {
}
```

**The permission evaluations now retry a 5xx.** `evaluate`, `evaluateBulk` and `explain` are POSTs only because the question travels in a body — they compute a decision and write nothing. They were subject to the client's POST-is-not-idempotent rule, which made the hot path the least resilient call in the SDK. They are now marked idempotent; endpoints that create are unchanged and still never retried.

**Behavior change — caller cancellation.** Aborting the `AbortSignal` passed to a request now propagates as an abort (`AbortError`, or whatever `signal.reason` holds) and is never retried. Previously a caller's abort was wrapped as `CanopyConnectionError` and, on an idempotent request, retried — re-issuing a request the caller had already cancelled. An already-aborted signal now short-circuits before `fetch` is called at all, and an abort during retry backoff stops there.

Timeouts and transport failures are unchanged: they still throw `CanopyConnectionError` and are still retried where the method allows it.

If you branch on `isCanopyConnectionError` to handle cancellation, match on the abort instead:

```ts
catch (error) {
  if ((error as Error).name === "AbortError") {
    // the caller cancelled
  }
}
```

**Per-request headers.** `RequestOptions.headers` sets headers for a single call, so the protocol headers the API documents are now reachable: `If-Match` for optimistic concurrency, and `Idempotency-Key` for safe bulk retries. Per-request headers override the client-wide `headers`; the credential is applied last and cannot be replaced by a call site.

The four wrapped operations whose spec declares `If-Match` take it directly:

```ts
await canopy.roles.update(id, { name: "Editor" }, { ifMatch: role.version });
await canopy.roles.delete(id, { ifMatch: role.version });
await canopy.permissions.update(
  id,
  { name: "Read" },
  { ifMatch: permission.version },
);
await canopy.permissions.delete(id, { ifMatch: permission.version });
```

**Backoff between retries is now bounded.** `Retry-After` was honoured verbatim, so a `Retry-After: 120` on a 429 blocked the caller for two minutes — outside `timeoutMs`, which only ever bounded a single attempt. The advised delay is now clamped to `maxBackoffMs`, a new client and per-call option defaulting to 30s. A caller's abort is also observed _during_ the wait rather than after it, so cancelling no longer means cancelling once the backoff elapses.

**Per-call deadlines and retry caps.** `RequestOptions.timeoutMs` and `RequestOptions.maxRetries` override the client-wide values for a single call, and `permissions.evaluate`, `evaluateBulk` and `explain` now accept `CallOptions` (`signal`, `timeoutMs`, `maxRetries`, `headers`). Both were previously constructor-only, so a latency-critical call on the request path had to accept deadlines sized for administrative CRUD. They are worth setting together: a deadline alone still permits `maxRetries + 1` attempts back to back.

**Fixed.** A 2xx response whose body is not JSON — a gateway answering in place of the API — now throws `CanopyError` carrying the status, instead of a `SyntaxError` surfacing as a misleading "connection failed".

`CanopyError.retryAfterMs` is now a declared, typed field. It was previously attached at runtime and invisible to TypeScript.
