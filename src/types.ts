// Mirror of the Rust types in src-tauri/src (serde camelCase). Keep in sync.

export type StatusCat = 'todo' | 'prog' | 'review' | 'done';
export type IssueType = 'story' | 'task' | 'bug' | 'other';
export type Priority = 'highest' | 'high' | 'med' | 'low' | 'lowest' | 'none';
export type SprintState = 'active' | 'future' | 'closed';

export interface Sprint {
  id: number;
  name: string;
  state: SprintState;
}

export interface Ticket {
  key: string;
  summary: string;
  status: StatusCat;
  statusName: string;
  type: IssueType;
  typeName: string;
  priority: Priority;
  assignee: { name: string; initials: string } | null;
  isMine: boolean;
  sprint: Sprint | null;
  points: number | null;
  epic: string | null;
  blockedBy: string[];
  blocks: string[];
  url: string;
  inScope: boolean;
}

export interface Snapshot {
  fetchedAt: string;
  scopeLabel: string;
  tickets: Ticket[];
  warnings: string[];
}

export type Scope = 'openSprints' | 'futureSprints' | 'jql';

export interface SearchTool {
  name: string;
  jqlArg: string;
  fieldsArg: string;
  limitArg: string;
  startArg: string;
  /** Cursor argument for token pagination (Jira Cloud). */
  pageTokenArg?: string | null;
  pageSize: number;
}

export interface ServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface Config {
  version: number;
  server: ServerConfig;
  profile: string;
  tools: { search: SearchTool; fields?: string | null };
  fields: { storyPoints: string; sprint: string };
  site: string;
  projectKey: string;
  defaultScope: Scope;
  customJql: string;
  refreshMinutes: number;
  useFakeServer: boolean;
}

export type ErrorKind =
  | 'NotConfigured'
  | 'CommandNotFound'
  | 'SpawnFailed'
  | 'AuthRequired'
  | 'Timeout'
  | 'ToolNotAllowed'
  | 'ToolMissing'
  | 'BadResponse'
  | 'Io';

export interface AppError {
  kind: ErrorKind;
  message: string;
}

export interface ConnectionReport {
  serverName: string;
  tools: string[];
  missing: string[];
}

export interface Diagnostics {
  stderr: string[];
  path: string;
  lastError?: AppError | null;
}
