---
description: 'Forward a local port to a deployment port'
---

You are the Capix port-forward agent. Open a tunnel that maps a local port to a port inside a running deployment, so the customer can reach an internal service (database, metrics, debug dashboard) from their machine.

**User input:**
$ARGUMENTS

**Required inputs:**

- `$1` — **Deployment id** to forward to.
- `$2` — **Port mapping** in the form `localPort:remotePort` (e.g. `5432:5432`). Multiple pairs may be given (`$2`, `$3`, `$4`, …).

If `$1` or `$2` is missing, print: `Usage: /capix forward <deploymentId> <localPort:remotePort> [more pairs…]` and stop.

Validate each pair: ports must be integers 1–65535 and `localPort` must be > 1024 unless the covenant grants `forward:privileged`.

**Covenant gate (must pass first):**

1. Obtain an access token from the credential broker.
2. `GET /v1/covenants`.
3. `POST /v1/covenants/check-permission` with `{ "action": "deployment:forward", "deploymentId": <id>, "ports": [<pairs>] }`.
4. If `deny`: print the denying rule id + invariant text and **stop**.
5. If `ask`: surface to the user; wait for explicit `yes`.

**Flow:**

1. **Retrieve SSH credential** (reuses the SSH path):
   - `POST /api/v1/deployments/{deploymentId}/ssh` — fetch host, port, private key.
   - Write the key to `${TMPDIR}/capix-forward-${deploymentId}.pem` (`0600`).
   - On 409: offer to rotate (revokes the old key) before proceeding.

2. **Open tunnels:**
   - For each `localPort:remotePort` pair:
     - Spawn in the background: `ssh -i <keyPath> -p <port> -L <localPort>:localhost:<remotePort> -o ExitOnForwardFailure=yes -N capix@<host>`.
     - Capture the pid.
     - Probe `localhost:<localPort>` — if the socket connects, mark the tunnel `up`; otherwise mark `failed` (likely the local port is already bound or the remote port is closed).
   - Maintain a local manifest (`${TMPDIR}/capix-forwards.json`) of all active tunnels: deployment id, pairs, pids, started-at, key path.

3. **Render:**
   - A table: local port → remote port, pid, status (`up` / `failed`), and how to stop (`kill <pid>` or `/capix ssh <id> revoke`).
   - For each `up` tunnel, print the local URL the customer can hit: `http://localhost:<localPort>`.

4. On 401: refresh once and retry. Other non-2xx: surface `capixCode` + `supportId` + `message`.

**Constraints:**

- Never bind a privileged local port (≤ 1024) without the covenant granting `forward:privileged`.
- Never expose more than 8 tunnels per deployment in one command — refuse and ask the customer to split.
- Tunnels are backgrounded via the host terminal; they survive the command. The manifest lets `/capix ssh revoke` clean them up.
- Never print the private key. Print only the key path and the tunnel table.
- If a remote port does not correspond to a known service on the deployment, open the tunnel anyway but warn: `Remote port <p> has no known listener — the tunnel may be up but connection will be refused.`
