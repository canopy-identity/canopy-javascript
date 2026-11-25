---
"@canopy-io/node": patch
---

Follows Canopy's release that lets each Environment choose the languages its hosted pages and emails are offered in, and adds ten languages. The generated types add `languages` to the sign-in settings and their change (a new Environment offers its default language alone until a list is saved), widen the branding preview's `language` to the twelve languages, and name the refusals `environment.languages_invalid`, `environment.default_language_invalid` and `environment.default_language_not_offered`.
