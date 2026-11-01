---
"@canopy-io/node": patch
---

Generated types follow the API as Canopy now publishes it: an audit event carries `channel` (`"mcp"` for a change an AI assistant made through the account MCP server, `null` for a direct call), the audit event list takes a `channel` filter, and the API key scope list matches the current catalogue.
