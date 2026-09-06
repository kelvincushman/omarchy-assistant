#!/usr/bin/env node
// Omarchy assistant daemon. One process, two listeners:
//   - a unix socket for the CLI, hotkeys and the bar widget (same-user trust)
//   - a TCP port for the phone app over netbird (device token auth)
// Writes everything to an Obsidian vault, asks a headless coding agent for
// explicit requests, and mines ambient text into proposals that need a click.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AmbientGate, RateLimiter, type DeviceRecord, type Proposal, type MinedProposal,
  ymd, hhmm, isQuietHour, verifyDevice, verifyBearer, hashToken, newToken, DEV_ID_RE,
  newProposalId, renderProposal, parseProposal, taskLine, dueTasks, validateMined, parseClaudeJson, oneLine,
} from "./lib.ts";
import { validateDeviceTextBody, deriveDeviceTextOverheard, pickAlert } from "./contract/alert-mapping.ts";
import { resolveAlert, type DeviceCommand } from "./contract/commands.ts";

// ---------------------------------------------------------------------------
// Paths and config
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONF_DIR = path.join(HOME, ".config", "omarchy", "assistant");
const RUN_DIR = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`, "omarchy-assistant");
const TOGGLES = path.join(HOME, ".local", "state", "omarchy", "toggles");
const PLUGIN_ID = "wearable.assistant";

interface Config {
  vault: string; port: number; bind: string; brain: "claude" | "codex";
  model: string; minerModel: string; budgetUsd: number; quietHours: [number, number];
  minerEveryMin: number; minerBatch: number; digestAt: string;
}
const DEFAULTS: Config = {
  vault: path.join(HOME, "Documents", "Omarchy"),
  port: 7477, bind: "0.0.0.0", brain: "claude",
  model: "claude-fable-5-1", minerModel: "claude-haiku-4-5",
  budgetUsd: 0.30, quietHours: [22, 8],
  minerEveryMin: 20, minerBatch: 8, digestAt: "08:30",
};

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return fallback; }
}
const config: Config = { ...DEFAULTS, ...readJson<Partial<Config>>(path.join(CONF_DIR, "config.json"), {}) };
config.vault = config.vault.replace(/^~(?=\/|$)/, HOME);

const V = {
  conversations: path.join(config.vault, "Conversations"),
  overheard: path.join(config.vault, "Overheard"),
  notes: path.join(config.vault, "Notes"),
  proposals: path.join(config.vault, "Proposals"),
  inbox: path.join(config.vault, "Tasks", "Inbox.md"),
};
for (const d of [CONF_DIR, path.join(CONF_DIR, "chats"), RUN_DIR, path.join(RUN_DIR, "brain"), V.conversations, V.overheard, V.notes, V.proposals, path.dirname(V.inbox)]) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}
fs.chmodSync(RUN_DIR, 0o700);

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...extra }));

// ---------------------------------------------------------------------------
// Files: append-only, atomic create, never truncate.
// ---------------------------------------------------------------------------

function appendLine(file: string, line: string): void {
  fs.appendFileSync(file, line.endsWith("\n") ? line : line + "\n", { mode: 0o600 });
}
function writeAtomic(file: string, content: string, mode = 0o644): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}
function ensureConversation(chatId: string, device: string): string {
  const dir = path.join(V.conversations, ymd());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${chatId.replace(/[^a-z0-9_.-]/gi, "_")}.md`);
  if (!fs.existsSync(file)) writeAtomic(file, `---\nchatId: ${chatId}\ndevice: ${device}\ncreated: ${new Date().toISOString()}\n---\n\n`);
  return file;
}
function vaultTurn(chatId: string, device: string, who: "you" | "omarchy", text: string): void {
  appendLine(ensureConversation(chatId, device), `## ${hhmm()} ${who}\n\n${text.trim()}\n\n`);
}

// ---------------------------------------------------------------------------
// Devices, chats, SSE
// ---------------------------------------------------------------------------

const DEVICES_FILE = path.join(CONF_DIR, "devices.json");
let devices = readJson<Record<string, DeviceRecord>>(DEVICES_FILE, {});
const limiter = new RateLimiter();
const deviceState = new Map<string, { lastIntentAt?: number; lastEventCode?: number; lastPollAt?: number; lastSeenAt?: number }>();
const commandQueues = new Map<string, DeviceCommand[]>();
const GRACE_MS = 90_000;

function devState(devId: string) {
  let s = deviceState.get(devId);
  if (!s) { s = {}; deviceState.set(devId, s); }
  return s;
}
function enqueueAlert(devId: string, name: string): void {
  const q = commandQueues.get(devId) ?? [];
  for (const c of resolveAlert(name)) { if (q.length >= 32) q.shift(); q.push(c); }
  commandQueues.set(devId, q);
}

const chatCounts = new Map<string, number>();
function chatFile(chatId: string) { return path.join(CONF_DIR, "chats", `${chatId.replace(/[^a-z0-9_.:-]/gi, "_")}.jsonl`); }
function chatLines(chatId: string): any[] {
  try { return fs.readFileSync(chatFile(chatId), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function appendChat(chatId: string, entry: Record<string, unknown>): number {
  const id = (chatCounts.get(chatId) ?? chatLines(chatId).length) + 1;
  chatCounts.set(chatId, id);
  appendLine(chatFile(chatId), JSON.stringify({ id, ...entry }));
  return id;
}

const sse = new Map<string, Set<http.ServerResponse>>();
function pushSse(chatId: string, id: number, data: Record<string, unknown>): void {
  for (const res of sse.get(chatId) ?? []) res.write(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Desktop integration
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 0, maxBuffer: 8 << 20, env: process.env },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
function notify(title: string, body: string, opts: { glyph?: string; urgency?: "low" | "normal" | "critical"; exec?: string[]; replaceId?: number } = {}): void {
  const args = ["-g", opts.glyph ?? "󰚩", "-u", opts.urgency ?? "normal", "--app-name", "Omarchy", oneLine(title, 80), oneLine(body, 400)];
  if (opts.replaceId && Number.isInteger(opts.replaceId) && opts.replaceId > 0) args.push("-r", String(opts.replaceId));
  if (opts.exec?.length) args.push("--exec", ...opts.exec);
  run("omarchy-notification-send", args).then((r) => { if (r.code !== 0) log("notify_failed", { stderr: r.stderr.trim() }); });
}
function refreshBar(): void { run("omarchy-shell", ["-q", PLUGIN_ID, "refresh"]); }
function listening(): boolean { return !fs.existsSync(path.join(TOGGLES, "assistant-mute")); }

// ---------------------------------------------------------------------------
// Status (bar + CLI)
// ---------------------------------------------------------------------------

const status = {
  startedAt: Date.now(), thinking: false, lastReply: "", lastReplyAt: 0, lastCostUsd: 0, todayCostUsd: 0, costDay: ymd(),
  minerQueued: 0, minerLastRunAt: 0,
};
function addCost(usd: number) {
  if (status.costDay !== ymd()) { status.costDay = ymd(); status.todayCostUsd = 0; }
  status.lastCostUsd = usd; status.todayCostUsd += usd;
}
function pendingProposals(): Proposal[] {
  const out: Proposal[] = [];
  for (const f of fs.readdirSync(V.proposals)) {
    if (!f.endsWith(".md")) continue;
    const p = parseProposal(fs.readFileSync(path.join(V.proposals, f), "utf8"));
    if (p?.status === "pending") out.push(p);
  }
  return out.sort((a, b) => a.created.localeCompare(b.created));
}
function statusJson() {
  return {
    listening: listening(), thinking: status.thinking, pending: pendingProposals().length,
    lastReply: status.lastReply, lastReplyAt: status.lastReplyAt, lastCostUsd: status.lastCostUsd, todayCostUsd: status.todayCostUsd,
    minerQueued: status.minerQueued, minerLastRunAt: status.minerLastRunAt,
    proposals: pendingProposals().slice(0, 10).map((p) => ({ id: p.id, kind: p.kind, text: p.text, when: p.when })),
    devices: Object.keys(devices).map((id) => ({ id, label: devices[id].label ?? "", lastSeenAt: devState(id).lastSeenAt ?? 0, queued: (commandQueues.get(id) ?? []).length })),
    vault: config.vault, port: config.port, brain: config.brain, model: config.model, uptimeSec: Math.round((Date.now() - status.startedAt) / 1000),
  };
}

// ---------------------------------------------------------------------------
// Brain: explicit requests only. One at a time.
// ---------------------------------------------------------------------------

interface Job { chatId: string; device: string; text: string; devId?: string; notifyId?: number; }
const jobs: Job[] = [];
let brainBusy = false;

function ask(job: Job): { chatId: string; id: number } {
  const id = appendChat(job.chatId, { role: "user", text: job.text, ts: Date.now() });
  vaultTurn(job.chatId, job.device, "you", job.text);
  if (job.devId) enqueueAlert(job.devId, "task_queued");
  jobs.push(job);
  void drain();
  return { chatId: job.chatId, id };
}

async function drain(): Promise<void> {
  if (brainBusy) return;
  const job = jobs.shift();
  if (!job) return;
  brainBusy = true; status.thinking = true; refreshBar();
  if (job.devId) enqueueAlert(job.devId, "task_running");
  try {
    const result = await runBrain(job);
    addCost(result.costUsd);
    const text = result.text || (result.ok ? "(no reply)" : "Sorry, that failed.");
    const id = appendChat(job.chatId, { role: "assistant", text, ts: Date.now(), ok: result.ok, costUsd: result.costUsd });
    vaultTurn(job.chatId, job.device, "omarchy", text);
    pushSse(job.chatId, id, { type: "assistant_message", taskId: `${job.chatId}#${id}`, text, ts: Date.now() });
    if (!result.ok) pushSse(job.chatId, id, { type: "error", message: text, ts: Date.now() });
    status.lastReply = text; status.lastReplyAt = Date.now();
    notify("Omarchy", text, { urgency: result.ok ? "normal" : "critical", exec: ["omarchy-assistant", "open-chat", job.chatId], replaceId: job.notifyId });
    if (job.devId) enqueueAlert(job.devId, pickAlert({ ok: result.ok, output: text }));
    log("brain_done", { chatId: job.chatId, ok: result.ok, costUsd: result.costUsd, chars: text.length });
  } catch (e) {
    log("brain_crash", { error: String(e) });
    notify("Omarchy", "The brain crashed. See journalctl --user -u omarchy-assistant.", { urgency: "critical" });
    if (job.devId) enqueueAlert(job.devId, "error");
  } finally {
    brainBusy = false; status.thinking = false; refreshBar();
    void drain();
  }
}

function aboutMe(): string {
  try { return fs.readFileSync(path.join(config.vault, "Memory", "about-me.md"), "utf8").replace(/^---[\s\S]*?---\n/, "").trim().slice(0, 800); } catch { return ""; }
}

async function userTurn(job: Job): Promise<string> {
  const win = await run("sh", ["-c", "hyprctl activewindow -j 2>/dev/null | jq -r '.title // empty'"], { timeoutMs: 2000 });
  const me = aboutMe();
  const recent = chatLines(job.chatId).slice(-7, -1).map((l) => `${l.role === "user" ? "You" : "Omarchy"}: ${oneLine(l.text, 300)}`);
  return [
    `Now: ${new Date().toString().slice(0, 24)}. Source: ${job.device}. Vault: ${config.vault}. Budget: $${config.budgetUsd.toFixed(2)}.`,
    win.stdout.trim() ? `Active window: ${oneLine(win.stdout, 80)}` : "",
    me ? `About the user (from the vault, Memory/about-me.md):\n${me}` : "",
    recent.length ? `Recent turns:\n${recent.join("\n")}` : "",
    `Request: ${job.text}`,
  ].filter(Boolean).join("\n\n");
}

async function runBrain(job: Job) {
  const prompt = await userTurn(job);
  const cwd = path.join(RUN_DIR, "brain");
  if (config.brain === "codex") {
    const out = path.join(RUN_DIR, `codex-${Date.now()}.txt`);
    const system = fs.readFileSync(path.join(REPO, "brain", "SYSTEM.md"), "utf8");
    const r = await run("codex", ["exec", "--skip-git-repo-check", "-m", config.model, "-s", "workspace-write", "-o", out, `${system}\n\n${prompt}`], { cwd, timeoutMs: 180_000 });
    let text = ""; try { text = fs.readFileSync(out, "utf8").trim(); fs.unlinkSync(out); } catch { /* none */ }
    return { ok: r.code === 0 && text.length > 0, text: text || oneLine(r.stderr, 300), costUsd: 0 };
  }
  const r = await run("claude", [
    "-p", "--no-session-persistence", "--output-format", "json", "--permission-mode", "auto",
    "--model", config.model, "--max-budget-usd", String(config.budgetUsd), "--tools", "Bash,Read",
    "--strict-mcp-config", "--setting-sources", "", "--system-prompt-file", path.join(REPO, "brain", "SYSTEM.md"),
    "--", prompt,
  ], { cwd, timeoutMs: 180_000 });
  const parsed = parseClaudeJson(r.stdout);
  if (r.code !== 0 && !parsed.text) parsed.text = oneLine(r.stderr, 300) || `brain exited ${r.code}`;
  return parsed;
}

// ---------------------------------------------------------------------------
// Ambient: vault + regex gate + batched tool-less miner. Never a reply.
// ---------------------------------------------------------------------------

const QUEUE_FILE = path.join(CONF_DIR, "miner-queue.jsonl");
const gates = new Map<string, AmbientGate>();

function overheard(source: string, text: string): void {
  appendLine(path.join(V.overheard, `${ymd()}.md`), `- ${hhmm()} [${source}] ${oneLine(text, 4000)}`);
  let gate = gates.get(source);
  if (!gate) { gate = new AmbientGate(); gates.set(source, gate); }
  for (const line of gate.push(text)) {
    appendLine(QUEUE_FILE, JSON.stringify({ source, text: oneLine(line, 500), at: Date.now() }));
    status.minerQueued++;
  }
}
function note(source: string, text: string, notifyId?: number): void {
  appendLine(path.join(V.notes, `${ymd()}.md`), `- ${hhmm()} ${oneLine(text, 4000)}`);
  notify("Noted", text, { glyph: "󰎞", urgency: "low", replaceId: notifyId });
}

function queuedSegments(): { source: string; text: string; at: number }[] {
  try { return fs.readFileSync(QUEUE_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
let minerBusy = false;
async function mine(force = false): Promise<number> {
  if (minerBusy) return 0;
  const segs = queuedSegments();
  status.minerQueued = segs.length;
  if (segs.length === 0) return 0;
  const stale = Date.now() - status.minerLastRunAt >= config.minerEveryMin * 60_000;
  if (!force && !(stale || segs.length >= config.minerBatch)) return 0;
  if (!force && isQuietHour(new Date().getHours(), config.quietHours)) return 0;
  minerBusy = true;
  try {
    // Claim the batch first so a crash mid-run never re-mines the same lines.
    fs.renameSync(QUEUE_FILE, `${QUEUE_FILE}.${Date.now()}.done`);
    status.minerQueued = 0; status.minerLastRunAt = Date.now();
    const input = segs.map((s) => `[${new Date(s.at).toTimeString().slice(0, 5)} ${s.source}] ${s.text}`).join("\n");
    const schema = JSON.stringify({ type: "object", properties: { proposals: { type: "array", items: { type: "object",
      properties: { kind: { type: "string", enum: ["task", "event"] }, text: { type: "string" }, when: { type: ["string", "null"] }, quote: { type: "string" } },
      required: ["kind", "text", "when", "quote"] } } }, required: ["proposals"] });
    const r = await run("claude", [
      "-p", "--no-session-persistence", "--output-format", "json", "--model", config.minerModel, "--max-budget-usd", "0.05",
      "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--json-schema", schema,
      "--system-prompt-file", path.join(REPO, "brain", "MINER.md"), "--", `Today is ${ymd()} (${new Date().toDateString()}).\n\n${input}`,
    ], { cwd: path.join(RUN_DIR, "brain"), timeoutMs: 120_000 });
    const parsed = parseClaudeJson(r.stdout);
    addCost(parsed.costUsd);
    let raw: unknown = parsed.structured;
    if (raw === undefined) { try { raw = JSON.parse(parsed.text); } catch { raw = null; } }
    const mined = validateMined(raw);
    log("miner_done", { segments: segs.length, proposals: mined.length, costUsd: parsed.costUsd, ok: parsed.ok });
    if (mined.length) propose(mined, segs[0].source);
    return mined.length;
  } finally { minerBusy = false; refreshBar(); }
}

function propose(items: MinedProposal[], source: string): void {
  const created: Proposal[] = [];
  for (const m of items) {
    const p: Proposal = { id: newProposalId(), status: "pending", kind: m.kind, text: m.text, when: m.when, quote: m.quote, source, created: new Date().toISOString() };
    writeAtomic(path.join(V.proposals, `${p.id}.md`), renderProposal(p) + `Heard in [[Overheard/${ymd()}]].\n`);
    created.push(p);
  }
  const first = created[0];
  const body = created.length === 1 ? `${first.kind === "event" ? "Event" : "Task"}: ${first.text}${first.when ? ` · ${first.when}` : ""}` : created.map((p) => `• ${p.text}`).join("\n");
  notify(`Omarchy suggests (${created.length})`, body, { glyph: "󰃰", urgency: "low", exec: ["omarchy-assistant", "review"] });
}

function loadProposal(id: string): Proposal | null {
  if (!/^p-\d{14}-[0-9a-f]{4}$/.test(id)) return null;
  try { return parseProposal(fs.readFileSync(path.join(V.proposals, `${id}.md`), "utf8")); } catch { return null; }
}
function saveProposal(p: Proposal): void { writeAtomic(path.join(V.proposals, `${p.id}.md`), renderProposal(p)); }

function scheduleNudge(unitSuffix: string, onCalendar: string, id: string): void {
  run("systemd-run", ["--user", "--quiet", "--collect", `--on-calendar=${onCalendar}`, `--unit=omarchy-assistant-nudge-${id}-${unitSuffix}`, "omarchy-assistant", "nudge", id])
    .then((r) => { if (r.code !== 0) log("nudge_schedule_failed", { id, onCalendar, stderr: r.stderr.trim() }); });
}
function accept(p: Proposal, calendar: boolean, dedupe = true): void {
  p.status = "accepted"; saveProposal(p);
  appendLine(V.inbox, taskLine(p.text, p.when));
  if (p.when) {
    const day = p.when.slice(0, 10);
    if (p.kind === "event" && p.when.length >= 16) {
      const t = new Date(p.when);
      const fmt = (d: Date) => `${ymd(d)} ${hhmm(d)}:00`;
      scheduleNudge("t60", fmt(new Date(t.getTime() - 60 * 60_000)), p.id);
      scheduleNudge("t10", fmt(new Date(t.getTime() - 10 * 60_000)), p.id);
    } else {
      scheduleNudge("day", `${day} 09:00:00`, p.id);
    }
  }
  if (calendar && p.when) void addToCalendar(p, dedupe);
  notify("Added", `${p.text}${p.when ? ` · ${p.when}` : ""}`, { glyph: "󰄬", urgency: "low", exec: ["xdg-open", `obsidian://open?path=${V.inbox}`] });
}
async function addToCalendar(p: Proposal, dedupe = true): Promise<void> {
  // Every claude.ai connector schema rides along (--tools does not filter MCP
  // tools), so one turn costs ~2c on Haiku. A search + create + reply is three
  // turns. The search matters: a run that creates the event and then dies on
  // the final reply would otherwise be retried into a duplicate.
  const r = await run("claude", [
    "-p", "--no-session-persistence", "--output-format", "json", "--model", config.minerModel, "--max-budget-usd", "0.40",
    "--tools", "", "--allowedTools", dedupe ? "mcp__claude_ai_Google_Calendar__create_event,mcp__claude_ai_Google_Calendar__search_events" : "mcp__claude_ai_Google_Calendar__create_event", "--setting-sources", "",
    "--system-prompt", dedupe
      ? "You manage exactly one Google Calendar event. First call search_events with the title. If an event with that title already starts at the requested time, do not create another. Otherwise call create_event once. Then reply with one line: 'created' or 'already exists', the title and the start time, or the error."
      : "Call create_event exactly once for the event described, then reply with one line: 'created', the title and the start time, or the error. Never call it twice.",
    "--", `Title: ${p.text}. Start: ${p.when} (local time). Duration 1 hour unless an end is implied. Primary calendar.`,
  ], { cwd: path.join(RUN_DIR, "brain"), timeoutMs: 180_000 });
  const parsed = parseClaudeJson(r.stdout);
  addCost(parsed.costUsd);
  log("calendar_done", { id: p.id, ok: parsed.ok, text: oneLine(parsed.text, 200), ...(parsed.ok ? {} : { code: r.code, stdout: oneLine(r.stdout, 800), stderr: oneLine(r.stderr, 400) }) });
  notify(parsed.ok ? "Calendar" : "Calendar unsure", parsed.ok ? (parsed.text || "done") : "The run failed after possibly creating the event. Check the calendar before retrying.", { glyph: "󰃭", urgency: parsed.ok ? "low" : "normal" });
}
function nudge(p: Proposal): string {
  if (p.status !== "accepted") return "not accepted";
  const now = new Date();
  if (p.nudged_at && now.getTime() - Date.parse(p.nudged_at) < 60 * 60_000) return "rate limited";
  if (isQuietHour(now.getHours(), config.quietHours)) {
    const [h, m] = config.digestAt.split(":").map(Number);
    const next = new Date(now); next.setHours(h, m, 0, 0); if (next <= now) next.setDate(next.getDate() + 1);
    scheduleNudge(`q${next.getTime()}`, `${ymd(next)} ${hhmm(next)}:00`, p.id);
    return "deferred to digest";
  }
  p.nudged_at = now.toISOString(); saveProposal(p);
  notify(p.text, `${p.kind === "event" ? "coming up" : "due today"} · click to snooze 1h`, { glyph: "󰂚", urgency: "normal", exec: ["omarchy-assistant", "snooze", p.id] });
  for (const [devId, s] of deviceState) if (s.lastPollAt && now.getTime() - s.lastPollAt < 5 * 60_000) enqueueAlert(devId, "awaiting_input");
  return "nudged";
}
function snooze(p: Proposal): void {
  run("systemd-run", ["--user", "--quiet", "--collect", "--on-active=1h", `--unit=omarchy-assistant-nudge-${p.id}-s${Date.now()}`, "omarchy-assistant", "nudge", p.id]);
  notify("Snoozed 1h", p.text, { glyph: "󰒲", urgency: "low" });
}

let digestDay = "";
function digest(force = false): string[] {
  const today = ymd();
  if (!force && digestDay === today) return [];
  digestDay = today;
  let inbox = ""; try { inbox = fs.readFileSync(V.inbox, "utf8"); } catch { /* none */ }
  const due = dueTasks(inbox, today);
  for (const p of pendingProposals()) if (Date.now() - Date.parse(p.created) > 7 * 86_400_000) { p.status = "expired"; saveProposal(p); }
  if (due.length) notify(`Today (${due.length})`, due.slice(0, 6).map((t) => `• ${t}`).join("\n"), { glyph: "󰃶", urgency: "low", exec: ["xdg-open", `obsidian://open?path=${V.inbox}`] });
  return due;
}

setInterval(() => {
  void mine();
  if (hhmm() === config.digestAt) digest();
}, 60_000);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req: http.IncomingMessage, max = 8192): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > max) { resolve(null); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}
function authDevice(req: http.IncomingMessage): string | null {
  const devId = String(req.headers["x-device-id"] ?? "");
  const token = String(req.headers["x-device-token"] ?? "");
  if (devId && token) return verifyDevice(devices, devId, token) ? devId : null;
  const auth = String(req.headers.authorization ?? "");
  if (auth.startsWith("Bearer ")) return verifyBearer(devices, auth.slice(7).trim());
  return null;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, local: boolean): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  const m = req.method ?? "GET";

  // ----- local only (unix socket) -----
  if (local && p === "/status" && m === "GET") return send(res, 200, statusJson());
  if (local && p === "/local/proposals" && m === "GET") return send(res, 200, { proposals: pendingProposals() });
  if (local && p === "/local/digest" && m === "POST") return send(res, 200, { due: digest(true) });
  if (local && p === "/local/mine" && m === "POST") return send(res, 200, { proposals: await mine(true) });
  if (local && p.startsWith("/local/chat/") && m === "GET") return send(res, 200, { turns: chatLines(decodeURIComponent(p.slice(12))).slice(-20) });
  if (local && p === "/local/calendar" && m === "POST") {
    // Explicit request from the brain or CLI: no proposal step, it is the user's own ask.
    const body = JSON.parse((await readBody(req)) || "{}");
    const text = oneLine(String(body.text ?? ""), 140);
    const when = typeof body.when === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(body.when) ? body.when.slice(0, 16) : null;
    if (!text || !when) return send(res, 400, { error: "need text and when (YYYY-MM-DD or YYYY-MM-DDTHH:MM)" });
    const prop: Proposal = { id: newProposalId(), status: "pending", kind: when.length >= 16 ? "event" : "task", text, when, quote: "explicit request", source: "ask", created: new Date().toISOString() };
    saveProposal(prop);
    accept(prop, true, false); // explicit ask: one create call, no search turn
    return send(res, 202, { ok: true, id: prop.id, text, when });
  }
  if (local && p === "/local/pair" && m === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const devId = String(body.devId ?? "");
    if (!DEV_ID_RE.test(devId)) return send(res, 400, { error: "devId must match ^[a-z0-9][a-z0-9_-]{1,63}$" });
    const token = newToken();
    devices = { ...devices, [devId]: { hash: hashToken(token), label: String(body.label ?? ""), createdAt: Date.now() } };
    writeAtomic(DEVICES_FILE, JSON.stringify(devices, null, 2), 0o600);
    log("device_paired", { devId });
    return send(res, 200, { devId, token, baseUrl: `http://${netbirdIp() ?? "<netbird-ip>"}:${config.port}` });
  }
  if (local && p === "/local/text" && m === "POST") {
    const raw = await readBody(req);
    if (raw === null) return send(res, 413, { error: "body too large" });
    let body: any; try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "invalid JSON" }); }
    const v = validateDeviceTextBody(body);
    if (typeof v === "string") return send(res, 400, { error: v });
    const mode = body.mode === "note" ? "note" : body.mode === "overheard" ? "overheard" : "ask";
    const notifyId = Number.isInteger(body.notifyId) && body.notifyId > 0 ? body.notifyId : undefined;
    if (mode === "ask") { if (notifyId) notify("Thinking…", oneLine(v.text, 120), { glyph: "󰔟", urgency: "low", replaceId: notifyId }); return send(res, 202, ask({ chatId: "local", device: "laptop", text: v.text, notifyId })); }
    if (mode === "note") { note("laptop", v.text, notifyId); return send(res, 202, { ok: true }); }
    if (!listening()) return send(res, 202, { ok: true, muted: true });
    overheard("laptop", v.text); return send(res, 202, { ok: true });
  }
  const pm = local ? p.match(/^\/local\/proposal\/([^/]+)\/(accept|accept-calendar|dismiss|snooze|nudge|calendar)$/) : null;
  if (pm && m === "POST") {
    const prop = loadProposal(pm[1]);
    if (!prop) return send(res, 404, { error: "no such proposal" });
    if (pm[2] === "accept" || pm[2] === "accept-calendar") { if (prop.status !== "pending") return send(res, 409, { error: prop.status }); accept(prop, pm[2] === "accept-calendar"); }
    else if (pm[2] === "dismiss") { prop.status = "dismissed"; saveProposal(prop); }
    else if (pm[2] === "snooze") snooze(prop);
    else if (pm[2] === "nudge") return send(res, 200, { result: nudge(prop) });
    else if (pm[2] === "calendar") { if (!prop.when) return send(res, 400, { error: "proposal has no date" }); void addToCalendar(prop); }
    refreshBar();
    return send(res, 200, { ok: true, status: prop.status });
  }

  // ----- device routes (either listener, always authenticated) -----
  if (!p.startsWith("/api/")) return send(res, 404, { error: "not found" });
  const devId = authDevice(req);
  if (!devId) return send(res, 401, { error: "device auth required (X-Device-Id + X-Device-Token, or Bearer token)" });
  if (!limiter.allow(devId)) return send(res, 429, { error: "rate limited" });
  const s = devState(devId); s.lastSeenAt = Date.now();

  if (p === "/api/device/text" && m === "POST") {
    const raw = await readBody(req);
    if (raw === null) return send(res, 413, { error: "body too large" });
    let body: unknown; try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "invalid JSON" }); }
    const v = validateDeviceTextBody(body);
    if (typeof v === "string") return send(res, 400, { error: v });
    const now = Date.now();
    const chatId = `device:${devId}`;
    const isNote = s.lastEventCode === 7 && s.lastIntentAt !== undefined && now - s.lastIntentAt <= GRACE_MS;
    const amb = !isNote && deriveDeviceTextOverheard({ clientOverheard: v.overheard, lastIntentAt: s.lastIntentAt, now, explicitGraceMs: GRACE_MS });
    if (isNote) { s.lastIntentAt = undefined; note(devId, v.text); return send(res, 200, { ok: true, chatId, mode: "note" }); }
    if (amb) { if (listening()) overheard(devId, v.text); return send(res, 200, { ok: true, chatId, mode: "overheard", muted: !listening() }); }
    s.lastIntentAt = undefined;
    return send(res, 200, { ok: true, ...ask({ chatId, device: devId, text: v.text, devId }), mode: "ask" });
  }
  if (p === "/api/device/event" && m === "POST") {
    const raw = await readBody(req);
    let body: any = {}; try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "invalid JSON" }); }
    const code = Number(body.code);
    if (body.kind === "button" && (code === 6 || code === 7 || code === 8)) { s.lastIntentAt = Date.now(); s.lastEventCode = code; }
    return send(res, 200, { ok: true });
  }
  if (p === "/api/device/command/poll" && m === "POST") {
    s.lastPollAt = Date.now();
    const q = commandQueues.get(devId) ?? [];
    commandQueues.set(devId, []);
    return send(res, 200, { commands: q });
  }
  if (p === "/api/chat/stream" && m === "GET") {
    const chatId = url.searchParams.get("chatId") || `device:${devId}`;
    const since = Number(url.searchParams.get("since") || 0);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const l of chatLines(chatId)) if (l.role === "assistant" && l.id > since) res.write(`id: ${l.id}\ndata: ${JSON.stringify({ type: "assistant_message", taskId: `${chatId}#${l.id}`, text: l.text, ts: l.ts })}\n\n`);
    const set = sse.get(chatId) ?? new Set(); set.add(res); sse.set(chatId, set);
    const ka = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    req.on("close", () => { clearInterval(ka); set.delete(res); });
    return;
  }
  return send(res, 404, { error: "not found" });
}

function netbirdIp(): string | null {
  try {
    const out = execFileSync("netbird", ["status"], { encoding: "utf8", timeout: 3000 });
    return out.match(/NetBird IP:\s*([\d.]+)/)?.[1] ?? null;
  } catch { return null; }
}

const guard = (local: boolean) => (req: http.IncomingMessage, res: http.ServerResponse) =>
  handle(req, res, local).catch((e) => { log("handler_error", { error: String(e) }); if (!res.headersSent) send(res, 500, { error: "internal" }); });

const SOCK = path.join(RUN_DIR, "sock");
try { fs.unlinkSync(SOCK); } catch { /* none */ }
http.createServer(guard(true)).listen(SOCK, () => { fs.chmodSync(SOCK, 0o600); log("listening_local", { sock: SOCK }); });
http.createServer(guard(false)).listen(config.port, config.bind, () => log("listening_tcp", { bind: config.bind, port: config.port }));

process.on("SIGTERM", () => { try { fs.unlinkSync(SOCK); } catch { /* none */ } process.exit(0); });
log("started", { vault: config.vault, brain: config.brain, model: config.model, devices: Object.keys(devices).length });
refreshBar();
