---
"@canopy-io/node": minor
---

The billing types follow the Starter plan. A plan code can be `starter`, and `DimensionUsage.limit` can be `null`, meaning no limit, so read it before comparing. The usage response gains `organizations`, and the entitlements response loses it. `plan_prices` lists `starter` and `pro`, each with its monthly and annual price. A subscription gains `scheduled_plan_code`, `promotion_code`, `discount` and `grace_ends_at`, and `GET /api/v1/organizations/:id/me` gains `plan_includes_sso` and `plan_includes_scim`.
