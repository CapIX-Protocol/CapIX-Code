/**
 * @capix/agent-runtime — durable SQLite store.
 *
 * All runtime state (sessions, messages, events, tool calls, plans, diffs,
 * receipts) is persisted to a single SQLite database so sessions survive
 * process restarts and can be resumed from the TUI, the IDE (over ACP), or
 * the CLI. The default database lives at `~/.capix-code/agent-runtime.db`;
 * tests pass `:memory:` for isolation.
 *
 * Money is always integer minor units stored as TEXT (BigInt-safe) — never
 * REAL. See the cost_minor columns below.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_DB_PATH = join(homedir(), '.capix-code', 'agent-runtime.db');

// ── Row shapes ──────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  model_id: string;
  project_id: string | null;
  route_mode: string;
  mode: string;
  status: string;
  workspace_root: string | null;
  instructions: string | null;
  parent_session_id: string | null;
  specialist_role: string | null;
  created_at: string;
  updated_at: string;
  total_input_units: number;
  total_output_units: number;
  total_cost_minor: string;
}

export interface MessageRow {
  id: number;
  session_id: string;
  turn_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface EventRow {
  event_id: string;
  session_id: string;
  turn_id: string;
  type: string;
  redaction: string;
  payload: string;
  created_at: string;
}

export interface ToolCallRow {
  tool_call_id: string;
  session_id: string;
  turn_id: string;
  tool_name: string;
  args: string;
  permission: string;
  status: string;
  decision_reason: string | null;
  output: string | null;
  is_error: number;
  created_at: string;
  completed_at: string | null;
}

export interface PlanRow {
  plan_id: string;
  session_id: string;
  goal: string;
  status: string;
  definition_of_done: string;
  created_at: string;
  updated_at: string;
}

export interface PlanStepRow {
  plan_id: string;
  step_id: string;
  idx: number;
  description: string;
  status: string;
  files: string;
  tests: string;
}

export interface DiffRow {
  id: number;
  session_id: string;
  turn_id: string;
  file_path: string;
  before: string;
  after: string;
  diff: string;
  created_at: string;
}

export interface ReceiptRow {
  receipt_id: string;
  session_id: string;
  turn_id: string;
  kind: string;
  model_capability: string;
  cost_minor: string;
  asset: string;
  scale: number;
  summary: string;
  outcome: string;
  leaf_hash: string;
  created_at: string;
}

/**
 * One orchestrated delegation (orchestration.ts). Cost stays integer minor
 * units as TEXT; `progress` is a 0..1 REAL (not money).
 */
export interface DelegationRow {
  id: string;
  pipeline_id: string | null;
  stage: string | null;
  role: string;
  task: string;
  context: string;
  status: string;
  progress: number | null;
  current_step: string | null;
  cost_minor: string;
  input_units: number;
  output_units: number;
  outcome: string | null;
  summary: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  project_id TEXT,
  route_mode TEXT NOT NULL DEFAULT 'auto',
  mode TEXT NOT NULL DEFAULT 'build',
  status TEXT NOT NULL DEFAULT 'active',
  workspace_root TEXT,
  instructions TEXT,
  parent_session_id TEXT REFERENCES sessions(id),
  specialist_role TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  total_input_units INTEGER NOT NULL DEFAULT 0,
  total_output_units INTEGER NOT NULL DEFAULT 0,
  total_cost_minor TEXT NOT NULL DEFAULT '0'
);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  type TEXT NOT NULL,
  redaction TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, created_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  tool_call_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,
  permission TEXT NOT NULL,
  status TEXT NOT NULL,
  decision_reason TEXT,
  output TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, created_at);

CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  definition_of_done TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id, created_at);

CREATE TABLE IF NOT EXISTS plan_steps (
  plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  step_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  files TEXT NOT NULL DEFAULT '[]',
  tests TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (plan_id, step_id)
);

CREATE TABLE IF NOT EXISTS diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  before TEXT NOT NULL,
  after TEXT NOT NULL,
  diff TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diffs_session ON diffs(session_id, id);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  model_capability TEXT NOT NULL,
  cost_minor TEXT NOT NULL,
  asset TEXT NOT NULL,
  scale INTEGER NOT NULL,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL,
  leaf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_session ON receipts(session_id, created_at);

CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT,
  stage TEXT,
  role TEXT NOT NULL,
  task TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL,
  current_step TEXT,
  cost_minor TEXT NOT NULL DEFAULT '0',
  input_units INTEGER NOT NULL DEFAULT 0,
  output_units INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  summary TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_delegations_pipeline ON delegations(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_delegations_created ON delegations(created_at);
`;

/**
 * Durable runtime store backed by SQLite. A thin, typed data-access layer —
 * all business logic lives in `runtime.ts`.
 */
export class RuntimeStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` inside an immediate transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  insertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, model_id, project_id, route_mode, mode, status,
           workspace_root, instructions, parent_session_id, specialist_role,
           created_at, updated_at, total_input_units, total_output_units, total_cost_minor)
         VALUES (@id, @model_id, @project_id, @route_mode, @mode, @status,
           @workspace_root, @instructions, @parent_session_id, @specialist_role,
           @created_at, @updated_at, @total_input_units, @total_output_units, @total_cost_minor)`
      )
      .run(row);
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      SessionRow | undefined;
    return row ?? null;
  }

  updateSession(id: string, fields: Partial<SessionRow>): void {
    const keys = Object.keys(fields) as Array<keyof SessionRow>;
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE sessions SET ${sets} WHERE id = @id`).run({ ...fields, id });
  }

  listSessions(limit: number, offset: number): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as SessionRow[];
  }

  listChildSessions(parentSessionId: string): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at ASC')
      .all(parentSessionId) as SessionRow[];
  }

  // ── Messages ────────────────────────────────────────────────────────────

  insertMessage(row: Omit<MessageRow, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO messages (session_id, turn_id, role, content, created_at)
         VALUES (@session_id, @turn_id, @role, @content, @created_at)`
      )
      .run(row);
  }

  listMessages(sessionId: string): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as MessageRow[];
  }

  // ── Events ──────────────────────────────────────────────────────────────

  insertEvent(row: EventRow): void {
    this.db
      .prepare(
        `INSERT INTO events (event_id, session_id, turn_id, type, redaction, payload, created_at)
         VALUES (@event_id, @session_id, @turn_id, @type, @redaction, @payload, @created_at)`
      )
      .run(row);
  }

  listEvents(sessionId: string): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as EventRow[];
  }

  // ── Tool calls ──────────────────────────────────────────────────────────

  insertToolCall(row: ToolCallRow): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (tool_call_id, session_id, turn_id, tool_name, args,
           permission, status, decision_reason, output, is_error, created_at, completed_at)
         VALUES (@tool_call_id, @session_id, @turn_id, @tool_name, @args,
           @permission, @status, @decision_reason, @output, @is_error, @created_at, @completed_at)`
      )
      .run(row);
  }

  updateToolCall(toolCallId: string, fields: Partial<ToolCallRow>): void {
    const keys = Object.keys(fields) as Array<keyof ToolCallRow>;
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db
      .prepare(`UPDATE tool_calls SET ${sets} WHERE tool_call_id = @tool_call_id`)
      .run({ ...fields, tool_call_id: toolCallId });
  }

  getToolCall(toolCallId: string): ToolCallRow | null {
    const row = this.db
      .prepare('SELECT * FROM tool_calls WHERE tool_call_id = ?')
      .get(toolCallId) as ToolCallRow | undefined;
    return row ?? null;
  }

  listToolCalls(sessionId: string): ToolCallRow[] {
    return this.db
      .prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as ToolCallRow[];
  }

  // ── Plans ───────────────────────────────────────────────────────────────

  insertPlan(row: PlanRow, steps: PlanStepRow[]): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO plans (plan_id, session_id, goal, status, definition_of_done, created_at, updated_at)
           VALUES (@plan_id, @session_id, @goal, @status, @definition_of_done, @created_at, @updated_at)`
        )
        .run(row);
      const stmt = this.db.prepare(
        `INSERT INTO plan_steps (plan_id, step_id, idx, description, status, files, tests)
         VALUES (@plan_id, @step_id, @idx, @description, @status, @files, @tests)`
      );
      for (const step of steps) stmt.run(step);
    });
  }

  getPlan(planId: string): PlanRow | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE plan_id = ?').get(planId) as
      PlanRow | undefined;
    return row ?? null;
  }

  getPlanSteps(planId: string): PlanStepRow[] {
    return this.db
      .prepare('SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY idx ASC')
      .all(planId) as PlanStepRow[];
  }

  listPlans(sessionId: string): PlanRow[] {
    return this.db
      .prepare('SELECT * FROM plans WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId) as PlanRow[];
  }

  updatePlan(planId: string, fields: Partial<PlanRow>): void {
    const keys = Object.keys(fields) as Array<keyof PlanRow>;
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db
      .prepare(`UPDATE plans SET ${sets} WHERE plan_id = @plan_id`)
      .run({ ...fields, plan_id: planId });
  }

  updatePlanStep(planId: string, stepId: string, fields: Partial<PlanStepRow>): void {
    const keys = Object.keys(fields) as Array<keyof PlanStepRow>;
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db
      .prepare(`UPDATE plan_steps SET ${sets} WHERE plan_id = @plan_id AND step_id = @step_id`)
      .run({ ...fields, plan_id: planId, step_id: stepId });
  }

  // ── Diffs ───────────────────────────────────────────────────────────────

  insertDiff(row: Omit<DiffRow, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO diffs (session_id, turn_id, file_path, before, after, diff, created_at)
         VALUES (@session_id, @turn_id, @file_path, @before, @after, @diff, @created_at)`
      )
      .run(row);
  }

  listDiffs(sessionId: string, filePath?: string): DiffRow[] {
    if (filePath) {
      return this.db
        .prepare('SELECT * FROM diffs WHERE session_id = ? AND file_path = ? ORDER BY id ASC')
        .all(sessionId, filePath) as DiffRow[];
    }
    return this.db
      .prepare('SELECT * FROM diffs WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as DiffRow[];
  }

  // ── Receipts ────────────────────────────────────────────────────────────

  insertReceipt(row: ReceiptRow): void {
    this.db
      .prepare(
        `INSERT INTO receipts (receipt_id, session_id, turn_id, kind, model_capability,
           cost_minor, asset, scale, summary, outcome, leaf_hash, created_at)
         VALUES (@receipt_id, @session_id, @turn_id, @kind, @model_capability,
           @cost_minor, @asset, @scale, @summary, @outcome, @leaf_hash, @created_at)`
      )
      .run(row);
  }

  getReceipt(receiptId: string): ReceiptRow | null {
    const row = this.db.prepare('SELECT * FROM receipts WHERE receipt_id = ?').get(receiptId) as
      ReceiptRow | undefined;
    return row ?? null;
  }

  listReceipts(sessionId: string): ReceiptRow[] {
    return this.db
      .prepare('SELECT * FROM receipts WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as ReceiptRow[];
  }

  // ── Delegations (orchestration) ─────────────────────────────────────────

  insertDelegation(row: DelegationRow): void {
    this.db
      .prepare(
        `INSERT INTO delegations (id, pipeline_id, stage, role, task, context, status,
           progress, current_step, cost_minor, input_units, output_units, outcome,
           summary, error, created_at, started_at, completed_at)
         VALUES (@id, @pipeline_id, @stage, @role, @task, @context, @status,
           @progress, @current_step, @cost_minor, @input_units, @output_units, @outcome,
           @summary, @error, @created_at, @started_at, @completed_at)`
      )
      .run(row);
  }

  updateDelegation(id: string, fields: Partial<DelegationRow>): void {
    const keys = Object.keys(fields) as Array<keyof DelegationRow>;
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE delegations SET ${sets} WHERE id = @id`).run({ ...fields, id });
  }

  getDelegation(id: string): DelegationRow | null {
    const row = this.db.prepare('SELECT * FROM delegations WHERE id = ?').get(id) as
      DelegationRow | undefined;
    return row ?? null;
  }

  listDelegations(limit: number, pipelineId?: string): DelegationRow[] {
    if (pipelineId) {
      return this.db
        .prepare('SELECT * FROM delegations WHERE pipeline_id = ? ORDER BY created_at ASC LIMIT ?')
        .all(pipelineId, limit) as DelegationRow[];
    }
    return this.db
      .prepare('SELECT * FROM delegations ORDER BY created_at DESC LIMIT ?')
      .all(limit) as DelegationRow[];
  }
}
