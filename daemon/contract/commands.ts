// Verbatim copy of omarchy-wearable server-contract/src/device/commands.ts.
// Do not edit here: run scripts/sync-contract.sh <path-to-omarchy-wearable>.

/**
 * Command packet encoder for GATT characteristic 0xCAB1AB97 on the NovaPAI
 * firmware (see plan §2.4 and devices/novapai-kelvinlee/firmware/devkit/src/
 * agent_commands.c).
 *
 * Wire format: 4 bytes, little-endian semantics per op.
 *
 *   [op][a][b][c]
 *
 *   op = 0x01  LED_COLOR       a=R  b=G  c=B
 *   op = 0x02  LED_PATTERN     a=pattern  b=duration_hi  c=duration_lo (ms)
 *   op = 0x03  HAPTIC          a=pattern  b=duration_hi  c=duration_lo (ms)
 *   op = 0x04  STATUS_QUERY    a=b=c=0   (device responds via 0x23BA7924 notify)
 *
 * Pattern codes are shared by LED_PATTERN and HAPTIC ops so the encoder doesn't
 * need to track which is which. Durations are unsigned 16-bit big-endian
 * (high byte first) so an operator reading the packet on a serial log can
 * decode visually.
 */

export const GATT_AGENT_COMMANDS_UUID = "CAB1AB97-0000-1000-8000-00805F9B34FB";

export const OP = {
  LED_COLOR: 0x01,
  LED_PATTERN: 0x02,
  HAPTIC: 0x03,
  STATUS_QUERY: 0x04,
} as const;

export const PATTERN = {
  OFF: 0x00,
  SOLID: 0x01,
  BREATHING: 0x02,
  PULSE: 0x03,       // single slow pulse
  BLINK: 0x04,       // fast on/off
  FLASH: 0x05,       // one bright flash then off
  SINGLE: 0x10,      // haptic: one short buzz
  DOUBLE: 0x11,      // haptic: two short
  TRIPLE: 0x12,      // haptic: three short
  LONG: 0x13,        // haptic: one long buzz
} as const;

export type Op = (typeof OP)[keyof typeof OP];
export type Pattern = (typeof PATTERN)[keyof typeof PATTERN];

export interface LedColorCmd { kind: "led_color"; r: number; g: number; b: number; }
export interface LedPatternCmd { kind: "led_pattern"; pattern: Pattern; durationMs?: number; }
export interface HapticCmd { kind: "haptic"; pattern: Pattern; durationMs?: number; }
export interface StatusQueryCmd { kind: "status_query"; }
export type DeviceCommand = LedColorCmd | LedPatternCmd | HapticCmd | StatusQueryCmd;

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const i = Math.round(n);
  if (i < 0) return 0;
  if (i > 255) return 255;
  return i;
}

function clampMs(ms: number | undefined): [number, number] {
  // Big-endian u16, max 65535 ms (~65 s). Callers wanting forever durations
  // should issue SOLID with duration 0 and clear with explicit OFF later.
  const v = Math.max(0, Math.min(0xffff, Math.round(ms ?? 0)));
  return [(v >> 8) & 0xff, v & 0xff];
}

/** Encode a DeviceCommand into the 4-byte GATT write payload. */
export function encodeCommand(cmd: DeviceCommand): Uint8Array {
  const buf = new Uint8Array(4);
  switch (cmd.kind) {
    case "led_color":
      buf[0] = OP.LED_COLOR;
      buf[1] = clampByte(cmd.r);
      buf[2] = clampByte(cmd.g);
      buf[3] = clampByte(cmd.b);
      return buf;
    case "led_pattern": {
      const [hi, lo] = clampMs(cmd.durationMs);
      buf[0] = OP.LED_PATTERN;
      buf[1] = cmd.pattern & 0xff;
      buf[2] = hi;
      buf[3] = lo;
      return buf;
    }
    case "haptic": {
      const [hi, lo] = clampMs(cmd.durationMs);
      buf[0] = OP.HAPTIC;
      buf[1] = cmd.pattern & 0xff;
      buf[2] = hi;
      buf[3] = lo;
      return buf;
    }
    case "status_query":
      buf[0] = OP.STATUS_QUERY;
      return buf;
  }
}

/** Named habitat-alert signals, resolved to {led + haptic} command pairs.
 *  Source vocabulary: devices/novapai-kelvinlee/docs/HABITAT_ALERTS.md (plan §4.3). */
export const HABITAT_ALERTS: Record<string, DeviceCommand[]> = {
  // Task lifecycle
  task_queued: [
    { kind: "led_pattern", pattern: PATTERN.PULSE, durationMs: 1000 },
    { kind: "led_color", r: 0, g: 80, b: 200 },
    { kind: "haptic", pattern: PATTERN.SINGLE, durationMs: 120 },
  ],
  task_running: [
    { kind: "led_pattern", pattern: PATTERN.BREATHING, durationMs: 0 },
    { kind: "led_color", r: 0, g: 80, b: 200 },
  ],
  awaiting_input: [
    { kind: "led_pattern", pattern: PATTERN.PULSE, durationMs: 0 },
    { kind: "led_color", r: 220, g: 140, b: 0 },
    { kind: "haptic", pattern: PATTERN.LONG, durationMs: 500 },
  ],
  task_done: [
    { kind: "led_pattern", pattern: PATTERN.FLASH, durationMs: 2000 },
    { kind: "led_color", r: 0, g: 200, b: 60 },
    { kind: "haptic", pattern: PATTERN.DOUBLE, durationMs: 300 },
  ],
  error: [
    { kind: "led_pattern", pattern: PATTERN.FLASH, durationMs: 3000 },
    { kind: "led_color", r: 220, g: 20, b: 20 },
    { kind: "haptic", pattern: PATTERN.TRIPLE, durationMs: 450 },
  ],
  budget_warn: [
    { kind: "led_pattern", pattern: PATTERN.BREATHING, durationMs: 0 },
    { kind: "led_color", r: 220, g: 140, b: 0 },
  ],
};

/** Resolve a habitat-alert name into its queued command packets. Returns
 *  an empty array for unknown names (caller can log but never crash). */
export function resolveAlert(name: string): DeviceCommand[] {
  return HABITAT_ALERTS[name] ?? [];
}
