export interface Bootstrap {
  version: string;
  libraryRoot: string;
  libraryKey?: string;
  libraryKind?: "local" | "remote" | "unknown";
  tdl: string;
  tdlRunning: boolean;
  hasSession: boolean;
  ffmpeg: string;
  chats: number;
  current: string;
  configPath: string;
  history?: string[];
}

export interface RemoteStatus {
  root: string;
  remote: boolean;
  kind: string;
  reachable: boolean;
  writable: boolean;
  freeBytes: number;
  freeKnown: boolean;
  latencyMs: number;
  cacheBytes: number;
  cacheLimitBytes: number;
  cachePath?: string;
  error?: string;
}

export interface ChatRow {
  slug: string;
  name: string;
  type?: string;
  id?: string;
  messages: number;
  media: number;
  mediaReady?: boolean;
  images?: number;
  videos?: number;
  audio?: number;
  files?: number;
  missing: number;
  totalBytes?: number;
  imageBytes?: number;
  videoBytes?: number;
  audioBytes?: number;
  fileBytes?: number;
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
  totalBytes: number;
  totalBytesEstimated: boolean;
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
  paused?: boolean;
  stopped?: boolean;
  partial?: boolean;
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
  qr?: string[];
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

export interface AccountProfile {
  name: string;
  firstName: string;
  lastName: string;
  username: string;
  phone: string;
  userId: number;
  avatar?: string;
  checkedAt: number;
}

export interface SessionCheck {
  state: string;
  message: string;
  detail?: string;
  code: number;
  profile?: AccountProfile;
  source?: string;
}

export interface MediaItem {
  id: string;
  name: string;
  kind: "image" | "video" | "audio" | "file";
  size: number;
  modTime: number;
  rel: string;
  thumb?: string;
  thumbSize?: number;
  thumbModTime?: number;
  width?: number;
  height?: number;
}

export interface MediaSummary {
  total: number;
  images: number;
  videos: number;
  audio: number;
  files: number;
  bytes: number;
  imageBytes: number;
  videoBytes: number;
  audioBytes: number;
  fileBytes: number;
}

export interface MediaPage {
  items: MediaItem[];
  total: number;
  page: number;
  pageSize: number;
  version: string;
  summary: MediaSummary;
  stale: boolean;
}

export interface PendingInput {
  seq: number;
  paths?: string[];
  folders?: string[];
  source?: string;
}

export interface ExportAccount {
  name: string;
  username: string;
  userId: number;
  sourceFile: string;
}

export interface AccountInfo {
  exportAccount?: ExportAccount;
  namespace: string;
  tdlExe: string;
  tdlVersion: string;
  sessionDir: string;
  sessionFile: string;
  sessionSize: number;
  sessionModified: number;
  hasSessionFile: boolean;
  running: boolean;
}

export interface HomeStats {
  chats: number;
  messages: number;
  media: number;
  missing: number;
  pages: number;
  official: number;
  images: number;
  videos: number;
  audio: number;
  files: number;
  mediaBytes: number;
  pendingMedia?: number;
  diskFree: number;
  diskTotal: number;
  libraryBytes: number;
}

export interface TaskInfo {
  id: string;
  kind: string;
  title: string;
  chat?: string;
  chatId?: string;
  slug?: string;
  mode?: string;
  source?: string;
  target?: string;
  messages?: number;
  media?: number;
  images?: number;
  videos?: number;
  audio?: number;
  files?: number;
  doneImages?: number;
  doneVideos?: number;
  doneAudio?: number;
  doneFiles?: number;
  doneStats?: boolean;
  filesDone?: number;
  filesTotal?: number;
  detail?: string;
  state: "running" | "done" | "failed" | "partial" | "paused" | "stopped";
  percent: number;
  avgSpeed?: number;
  peakSpeed?: number;
  bytes?: number;
  totalBytes?: number;
  totalBytesEstimated?: boolean;
  done?: number;
  total?: number;
  etaMs?: number;
  elapsedMs?: number;
  concurrent?: number;
  threads?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  recordsComplete?: boolean;
}

export interface SpeedPoint {
  at: number;
  now: number;
  avg: number;
}

export interface TaskDetail extends TaskInfo {
  series?: SpeedPoint[];
  active?: TaskRow[];
  completed?: TaskRow[];
}

export interface ViewerPrefs {
  seekSeconds: number;
  longPressRate: number;
  longPressDelayMs: number;
  maxVolume: number;
  volumeStep: number;
  videoFrameAspect: string;
  speedWindowSeconds: number;
  backdrop: string;
}

export interface PickedDialog {
  seq: number;
  kind: string;
  purpose: string;
  paths?: string[];
  folder?: string;
  error?: string;
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
  dialog?: PickedDialog;
  tasks: TaskInfo[];
  running: boolean;
}

export interface OnlineChat {
  peer: string;
  id: number;
  type: string;
  name: string;
  username?: string;
  hasPhoto: boolean;
  avatar?: string;
  lastMessage?: string;
  lastKind?: string;
  lastMessageId?: number;
  lastDate?: number;
  unread?: number;
  pinned?: boolean;
  archived?: boolean;
  contact?: boolean;
  muted?: boolean;
  localSlug?: string;
  localMessages?: number;
  localMedia?: number;
  localUpdatedAt?: string;
  archivedLocally?: boolean;
}

export interface OnlineFolder {
  id: number;
  title: string;
  emoticon?: string;
  peers: string[];
}

export interface OnlineChats {
  chats: OnlineChat[];
  folders?: OnlineFolder[];
  fetchedAt: number;
  source?: string;
  error?: string;
}

export interface OnlineExportProgress {
  active: boolean;
  stage?: string;
  detail?: string;
  percent: number;
  messages: number;
  media: number;
}

export interface OnlineExportPreview {
  peer: string;
  chat: string;
  token?: string;
  existed: boolean;
  upToDate?: boolean;
  backfillOnly?: boolean;
  messages: number;
  service: number;
  images: number;
  videos: number;
  audio: number;
  files: number;
  other: number;
  media: number;
  bytes: number;
  localMessages?: number;
  localMedia?: number;
  localUpdatedAt?: string;
  localMissing?: number;
  missingBytes?: number;
  freeBytes?: number;
  spaceNeedBytes?: number;
  spaceShort?: boolean;
  chats?: number;
}

export interface BackfillPreview {
  slug: string;
  chat: string;
  messages: number;
  media: number;
  missing: number;
  knownCount: number;
  knownBytes: number;
  images: number;
  videos: number;
  audio: number;
  files: number;
  other: number;
  freeBytes: number;
  spaceShort: boolean;
}

export interface BulkPreview {
  chats: number;
  missing: number;
  knownBytes: number;
  images: number;
  videos: number;
  audio: number;
  files: number;
  other: number;
  freeBytes: number;
  spaceShort: boolean;
}

export interface OnlineExportResult {
  slug: string;
  chat: string;
  taskId: string;
  messages: number;
  media: number;
  existed: boolean;
  upToDate?: boolean;
}

export interface RemoteTools {
  rclone: boolean;
  winFsp: boolean;
  sshfs: boolean;
  winget: boolean;
  powerShell: boolean;
  openSSH: boolean;
  sshAliases?: string[];
  rcloneRemotes?: string[];
}

export type ToastKind = "success" | "error" | "warning" | "info";

export interface ToastAction {
  label: string;
  run: () => void;
}
