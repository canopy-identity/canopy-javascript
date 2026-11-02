---
"@canopy-io/node": patch
---

`LocalAuthorizer.applyEvent` treats `identity.social_link.added` and `identity.social_link.removed` as changes that move no one's access. Before, they were unknown events and emptied the whole cache, which a social sign-up, linking an account every time, did on every delivery. The agent skill now covers social sign-in on both sign-in shapes, linked accounts on the Direct API, and the social refusals.
