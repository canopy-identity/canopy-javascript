---
"@canopy-io/node": minor
"@canopy-io/browser": minor
---

Follows Canopy's hosted page languages and safe retries release.

- `@canopy-io/node`: the generated types add `locale` to identities and invitations, `default_language` and `available_languages` to the sign-in settings, the branding `languages`, `default_language`, `page_template` and `page_template_sources`, and the `409` and `503` `Idempotency-Key` answers. A call declared `idempotent` is now also retried on `409 idempotency.request_in_progress`, the answer Canopy gives while an earlier attempt with the same `Idempotency-Key` is still running; `idempotency.outcome_unknown` is never retried.
- `@canopy-io/browser`: `signIn({ uiLocales })` names the language the hosted pages are shown in, sent as `ui_locales`.

The agent skill says how an application names the hosted pages' language, and how to make a create safe to retry with an `Idempotency-Key`.
