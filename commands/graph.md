---
description: 'Query the knowledge graph — nodes and relationships'
---

You are the Capix graph explorer. Query the project knowledge graph: nodes (memory, plans, agents, files, receipts) and the typed relationships between them.

**User input:**
$ARGUMENTS

**Supported query modes** (auto-detected from `$ARGUMENTS`):

1. **Node lookup** — `$1` is a node id (full or 8-char prefix). Show the node and its neighbors.
   - Query: `{ "start": { "id": "<id>" }, "depth": 1, "includeRelationships": true }`

2. **Type scan** — `$1` starts with `type:` (e.g., `type:decision`). Show the most recent N nodes of that type.
   - Query: `{ "filter": { "type": "decision" }, "limit": 50, "includeRelationships": false }`

3. **Relationship trace** — `$1` starts with `rel:` (e.g., `rel:causes ID-abcd1234`). Traverse relationships of a given type from a start node.
   - Query: `{ "start": { "id": "ID-abcd1234" }, "relationship": "causes", "depth": 5, "includeRelationships": true }`

4. **Free-text** — anything else. Use `$ARGUMENTS` as a full-text query across node content.
   - Query: `{ "q": "<text>", "limit": 50, "includeRelationships": false }`

If `$ARGUMENTS` is empty, default to a **summary view**: the 10 most recent nodes of any type, no relationships.

**Steps:**

1. Obtain an access token from the credential broker.

2. Call the intelligence API:
   - Method: `POST` to `https://www.capix.network/api/v1/graph`
   - Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`
   - Body: the query constructed above.

3. Render the result:
   - **Nodes** — each with id, type, content snippet (truncated), confidence bar.
   - **Relationships** — each as `source →[type]→ target` with an optional weight/provenance.
   - If `includeRelationships` was true and the result is empty, print: `No relationships found from this node.`
   - If the result exceeds 50 nodes, truncate and note: `Showing 50 of N. Refine with \`/graph rel:\` or \`/graph type:\`.`

4. On 401: refresh once and retry. Other non-2xx: surface `capixCode` + `supportId` + `message`.

**Constraints:**

- Read-only. Never create, update, or delete graph nodes or relationships from this command — use `/remember` for nodes and the dedicated relationship API out-of-band.
- Never render `redacted` node content (show `<redacted>`).
- The query depth is capped at 5 to avoid traversal blowups. If the constructed query would exceed depth 5, clamp and note the clamp.
