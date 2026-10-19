---
"@canopy-io/node": patch
---

`LocalAuthorizer` keeps its copy of the hierarchy in about 40% less memory: one id string per node instead of two. A parsed `GET /api/v1/nodes/parents` response holds each node id twice, as the node's own `id` and again in its children's `parent_node_id`, and the cache used to keep both copies. A 50,000-node hierarchy now costs about 4.6 MB rather than 7.4 MB. Answers are unchanged.
