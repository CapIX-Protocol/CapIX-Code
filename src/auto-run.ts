/**
 * Autonomous run entrypoint — the process `capix-code run --auto` executes.
 *
 * The launcher invokes the bundled engine as
 *   engine --eval "import('<runtime>/src/auto-run.ts').then(m=>m.autoRunMain())"
 * with the contract carried in the environment (never on a shell-quoted
 * command line):
 *
 *   CAPIX_AUTONOMOUS=1            marks the process as autonomous
 *   CAPIX_AUTONOMOUS_BRIEF        the task brief (required)
 *   CAPIX_QUALITY_TIER            fast|balanced|best (default balanced)
 *   CAPIX_SPEND_CAP_USD_MINOR     hard budget, integer micro-USD (optional)
 *
 * The run is fully non-interactive: the agent runtime decides every tool
 * approval through the autonomous sandbox policy, tracks spend from the real
 * receipt stream, and stops cleanly at the cap. The human-readable transcript
 * goes to stderr; stdout carries the machine-readable result line:
 *
 *   CAPIX_RUN_RESULT {"status":...,"summary":...,"artifacts":[],"receipts":[],"usage":{}}
 *
 * Exit code is 0 for `completed`, 2 for `spend_cap_reached` (a clean stop,
 * not a crash), 1 otherwise.
 */

import {
  CapixAgentRuntime,
  createAutoApprovalPolicy,
  runAutonomous,
  formatResultLine,
  type AutonomousResult,
} from '@capix/agent-runtime';

import { readQualityTier, type CapixClientMeta } from './capix-provider.js';
import { createRuntimeModelInvoker } from './plugin.js';

function clientMeta(): CapixClientMeta {
  const releaseId = process.env.CAPIX_RELEASE_ID ?? 'bundled';
  const version = process.env.CAPIX_CODE_VERSION ?? '2.3.2';
  return {
    releaseId,
    client: 'capix-code',
    clientVersion: version,
    pluginVersion: version,
    acpVersion: '1',
  };
}

function emitFailure(brief: string, message: string): AutonomousResult {
  return {
    status: 'failed',
    summary: message,
    artifacts: [],
    receipts: [],
    usage: { inputUnits: 0, outputUnits: 0, costMinor: '0', asset: 'USDC', scale: 6 },
    skipped: [],
    tier: readQualityTier(),
    spendCapMinor: process.env.CAPIX_SPEND_CAP_USD_MINOR?.trim() || null,
    sessionId: '',
  };
}

export async function autoRunMain(): Promise<void> {
  const brief = (process.env.CAPIX_AUTONOMOUS_BRIEF ?? '').trim();
  if (!brief) {
    const result = emitFailure('', 'auto-mode requires CAPIX_AUTONOMOUS_BRIEF');
    process.stdout.write(formatResultLine(result) + '\n');
    process.exit(1);
  }

  const spendCapMinor = process.env.CAPIX_SPEND_CAP_USD_MINOR?.trim() || null;
  const runtime = new CapixAgentRuntime({
    dbPath: process.env.CAPIX_AGENT_RUNTIME_DB,
    workspaceRoot: process.cwd(),
    modelInvoker: createRuntimeModelInvoker(clientMeta()),
    autoApprove: createAutoApprovalPolicy(),
    qualityTier: readQualityTier(),
  });

  let result: AutonomousResult;
  try {
    result = await runAutonomous(runtime, {
      brief,
      qualityTier: readQualityTier(),
      spendCapMinor,
      workspaceRoot: process.cwd(),
      onTranscript: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (err) {
    result = emitFailure(brief, err instanceof Error ? err.message : String(err));
  } finally {
    runtime.close();
  }

  // The ONLY stdout write: one machine-readable line for the A2A caller.
  process.stdout.write(formatResultLine(result) + '\n');
  process.exit(result.status === 'completed' ? 0 : result.status === 'spend_cap_reached' ? 2 : 1);
}
