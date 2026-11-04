export interface Bootstrap {
  version: string;
  libraryRoot: string;
  tdl: string;
  tdlRunning: boolean;
  hasSession: boolean;
  ffmpeg: string;
  chats: number;
  current: string;
  configPath: string;
  history?: string[];
}

export interface ChatRow {
  slug: string;
  name: string;
  type?: string;
  id?: string;
  messages: number;
  media: number;
  missing: number;
  firstTs?: number;
  lastTs?: number;
  updatedAt?: string;
  pages: number;
  hasSource: boolean;
  official: number;
  dir: string;
  current: boolean;
}

export interface TaskRow {
  id: string;
  name: string;
  kind: string;
  percent: number;
  transferred: number;
  expected: number;
  speed: number;
  etaMs: number;
  elapsedMs: number;
  done: boolean;
  stalled: boolean;
}

export interface DownloadState {
  opId: string;
  slug: string;
  chat: string;
  pass: number;
  passMax: number;
  phase: string;
  state: string;
  detail: string;
  done: number;
  total: number;
  percent: number;
  bytes: number;
  knownBytes: number;
  knownCount: number;
  speedNow: number;
  speedAvg: number;
  speedAvgWall: number;
  speedPeak: number;
  etaMs: number;
  etaSource: string;
  elapsedMs: number;
  retryInMs: number;
  networkAttempt: number;
  networkAttemptMax: number;
  restartsUsed: number;
  deferred: number;
  stalledFileRetries: number;
  stallAfterMs: number;
  concurrent: number;
  threads: number;
  baseConcurrent: number;
  baseThreads: number;
  active: TaskRow[];
  completed: TaskRow[];
  recent: string[];
  logPath?: string;
  updatedAt: number;
}

export interface OperationState {
  opId: string;
  phase: string;
  stage: string;
  detail: string;
  current: number;
  total: number;
  unit: string;
  elapsedMs: number;
}

export interface DoneState {
  opId: string;
  ok: boolean;
  error?: string;
  stage?: string;
  messages?: number;
  media?: number;
  missing?: number;
}

export interface Reply {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface LoginState {
  id: string;
  kind: string;
  state: "starting" | "waiting" | "success" | "failed" | "cancelled" | "missing";
  screen: string[];
  prompt?: string;
  message?: string;
  seq: number;
}

export interface TdlInfo {
  exe: string;
  version: string;
  sessionDir: string;
  hasSession: boolean;
  running: boolean;
  namespace: string;
}

export interface SessionCheck {
  state: string;
  message: string;
  detail?: string;
  code: number;
}

export interface MediaItem {
  id: string;
  name: string;
  kind: "image" | "video" | "audio" | "file";
  size: number;
  modTime: number;
}

export interface PendingInput {
  seq: number;
  paths?: string[];
  folders?: string[];
  source?: string;
}

export interface Notice {
  seq: number;
  text?: string;
}

export interface DesktopState {
  chats: ChatRow[];
  download?: DownloadState;
  operation?: OperationState;
  done?: DoneState;
  login?: LoginState;
  pending?: PendingInput;
  notice?: Notice;
  running: boolean;
}
