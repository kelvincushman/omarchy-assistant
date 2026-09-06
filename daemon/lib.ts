// Pure helpers for the Omarchy assistant daemon. No fs, no network, no
// spawning: everything here is testable with node:test alone.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function ymd(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function hhmm(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Quiet hours wrap midnight: [22, 8] means 22:00..07:59. */
export function isQuietHour(hour: number, quiet: [number, number]): boolean {
  const [start, end] = quiet;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// ---------------------------------------------------------------------------
// Device auth (transliterated from omarchy-wearable registry.ts / channel.ts)
// ---------------------------------------------------------------------------

export const DEV_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export interface DeviceRecord { hash: string; label?: string; createdAt: number; }

/** Constant-time check of (devId, token) against the registry. */
export function verifyDevice(devices: Record<string, DeviceRecord>, devId: string, token: string): boolean {
  if (!DEV_ID_RE.test(devId)) return false;
  if (typeof token !== "string" || token.length === 0) return false;
  const row = devices[devId];
  if (!row) return false;
  const got = Buffer.from(hashToken(token), "hex");
  const want = Buffer.from(row.hash, "hex");
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/** A bearer token is accepted if it belongs to any paired device. */
export function verifyBearer(devices: Record<string, DeviceRecord>, token: string): string | null {
  for (const devId of Object.keys(devices)) if (verifyDevice(devices, devId, token)) return devId;
  return null;
}

/** Token bucket: 10 burst, 1 token per 6 s, per key. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private burst: number;
  private refillMs: number;
  constructor(burst = 10, refillMs = 6000) { this.burst = burst; this.refillMs = refillMs; }
  allow(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) / this.refillMs);
    b.at = now;
    if (b.tokens < 1) { this.buckets.set(key, b); return false; }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Ambient gate (stage 0 of the miner). Free, regex only.
// ---------------------------------------------------------------------------

export const INTENT_RE = new RegExp(
  [
    "remind me", "remember to", "don'?t forget",
    "i(?:'ll| will| need to| have to| should| must| promised?)",
    "schedule", "book", "appointment", "meeting", "deadline", "due",
    "call (?:him|her|them|back)", "send (?:\\w+ )?(?:the|a|an) ",
    "tomorrow", "tonight", "next (?:mon|tue|wed|thu|fri|sat|sun)\\w*", "on (?:mon|tue|wed|thu|fri|sat|sun)\\w*",
    "at \\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b",
  ].join("|"),
  "i",
);

/** Keeps one line of context either side of a flagged line. */
export class AmbientGate {
  private prev: string | null = null;
  private wantNext = false;
  /** Returns the lines to queue for the miner (0..2), never a reply. */
  push(line: string): string[] {
    const out: string[] = [];
    const hit = INTENT_RE.test(line);
    if (hit) {
      if (this.prev !== null && !this.wantNext) out.push(this.prev);
      out.push(line);
      this.wantNext = true;
    } else if (this.wantNext) {
      out.push(line);
      this.wantNext = false;
    }
    this.prev = line;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Proposals (markdown with YAML frontmatter, one file each)
// ---------------------------------------------------------------------------

export type ProposalStatus = "pending" | "accepted" | "dismissed" | "expired";
export interface Proposal {
  id: string;
  status: ProposalStatus;
  kind: "task" | "event";
  text: string;
  when: string | null;     // ISO date or datetime, or null
  quote: string;
  source: string;
  created: string;         // ISO
  nudged_at?: string;      // ISO
}

export function newProposalId(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `p-${stamp}-${randomBytes(2).toString("hex")}`;
}

const yamlStr = (s: string) => JSON.stringify(s);

export function renderProposal(p: Proposal): string {
  const lines = [
    "---",
    `id: ${p.id}`,
    `status: ${p.status}`,
    `kind: ${p.kind}`,
    `text: ${yamlStr(p.text)}`,
    `when: ${p.when ? yamlStr(p.when) : "null"}`,
    `quote: ${yamlStr(p.quote)}`,
    `source: ${yamlStr(p.source)}`,
    `created: ${p.created}`,
  ];
  if (p.nudged_at) lines.push(`nudged_at: ${p.nudged_at}`);
  lines.push("---", "", `> ${p.quote}`, "");
  return lines.join("\n");
}

export function parseProposal(md: string): Proposal | null {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { /* keep raw */ } }
    fm[k] = v;
  }
  if (!fm.id || !fm.status || !fm.kind) return null;
  return {
    id: fm.id,
    status: fm.status as ProposalStatus,
    kind: fm.kind === "event" ? "event" : "task",
    text: fm.text ?? "",
    when: !fm.when || fm.when === "null" ? null : fm.when,
    quote: fm.quote ?? "",
    source: fm.source ?? "",
    created: fm.created ?? "",
    nudged_at: fm.nudged_at,
  };
}

/** Obsidian Tasks plugin line. */
export function taskLine(text: string, when: string | null): string {
  const date = when ? when.slice(0, 10) : null;
  return date ? `- [ ] ${text} 📅 ${date}` : `- [ ] ${text}`;
}

/** Open tasks due on or before `today` (YYYY-MM-DD), plus undated ones if `includeUndated`. */
export function dueTasks(inbox: string, today: string, includeUndated = false): string[] {
  const out: string[] = [];
  for (const line of inbox.split("\n")) {
    if (!/^- \[ \] /.test(line)) continue;
    const m = line.match(/📅 (\d{4}-\d{2}-\d{2})/);
    if (m ? m[1] <= today : includeUndated) out.push(line.replace(/^- \[ \] /, ""));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Miner output validation. Overheard text is untrusted; so is the model's
// answer about it. Only these fields, only these shapes, only this many.
// ---------------------------------------------------------------------------

export interface MinedProposal { kind: "task" | "event"; text: string; when: string | null; quote: string; }

export function validateMined(raw: unknown, max = 5): MinedProposal[] {
  const out: MinedProposal[] = [];
  const list = raw && typeof raw === "object" && Array.isArray((raw as any).proposals) ? (raw as any).proposals : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const kind = item.kind === "event" ? "event" : item.kind === "task" ? "task" : null;
    if (!kind) continue;
    const text = typeof item.text === "string" ? item.text.trim().slice(0, 140) : "";
    if (!text) continue;
    let when: string | null = null;
    if (typeof item.when === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(item.when)) when = item.when.slice(0, 16);
    const quote = typeof item.quote === "string" ? item.quote.trim().slice(0, 200) : "";
    out.push({ kind, text, when, quote });
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// claude -p --output-format json
// ---------------------------------------------------------------------------

export interface BrainResult { ok: boolean; text: string; costUsd: number; structured?: unknown; }

export function parseClaudeJson(stdout: string): BrainResult {
  let j: any;
  try { j = JSON.parse(stdout); } catch { return { ok: false, text: stdout.trim().slice(0, 500) || "brain returned no JSON", costUsd: 0 }; }
  const text = typeof j.result === "string" ? j.result.trim() : "";
  return {
    ok: j.is_error !== true && j.subtype !== "error_max_budget_usd",
    text: text || (j.is_error ? "brain error" : ""),
    costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : 0,
    structured: j.structured_output,
  };
}

/** One-line sanitiser for text that goes into notifications and prompts. */
export function oneLine(s: string, max = 200): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}
