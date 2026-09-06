import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  AmbientGate, RateLimiter, INTENT_RE, verifyDevice, hashToken, newToken, isQuietHour,
  renderProposal, parseProposal, taskLine, dueTasks, validateMined, parseClaudeJson, type Proposal,
} from "./lib.ts";
import { encodeCommand, HABITAT_ALERTS, resolveAlert, OP, PATTERN } from "./contract/commands.ts";
import { validateDeviceTextBody, deriveDeviceTextOverheard, pickAlert, MAX_DEVICE_TEXT_LEN } from "./contract/alert-mapping.ts";
import { shouldProcessAudioFrame } from "./contract/capture-gate.ts";

describe("contract: commands encoder (ported from omarchy-wearable)", () => {
  test("LED_COLOR packs RGB", () => assert.deepEqual(encodeCommand({ kind: "led_color", r: 10, g: 200, b: 255 }), new Uint8Array([OP.LED_COLOR, 10, 200, 255])));
  test("LED_PATTERN big-endian duration", () => {
    const b = encodeCommand({ kind: "led_pattern", pattern: PATTERN.PULSE, durationMs: 1500 });
    assert.deepEqual([...b], [OP.LED_PATTERN, PATTERN.PULSE, 0x05, 0xdc]);
  });
  test("duration clamps to u16", () => assert.deepEqual([...encodeCommand({ kind: "haptic", pattern: PATTERN.LONG, durationMs: 999_999 }).slice(2)], [0xff, 0xff]));
  test("habitat vocabulary complete", () => {
    for (const k of ["task_queued", "task_running", "awaiting_input", "task_done", "error", "budget_warn"]) assert.ok(HABITAT_ALERTS[k].length > 0, k);
    assert.deepEqual(resolveAlert("nope"), []);
  });
});

describe("contract: alert mapping + capture gate", () => {
  test("validateDeviceTextBody", () => {
    assert.equal(typeof validateDeviceTextBody({}), "string");
    assert.equal(typeof validateDeviceTextBody({ text: "x".repeat(MAX_DEVICE_TEXT_LEN + 1) }), "string");
    assert.deepEqual(validateDeviceTextBody({ text: " hi ", overheard: true, at: 5 }), { text: "hi", overheard: true, at: 5 });
  });
  test("overheard unless a button press is recent", () => {
    assert.equal(deriveDeviceTextOverheard({ clientOverheard: false, lastIntentAt: undefined, now: 1000, explicitGraceMs: 90_000 }), true);
    assert.equal(deriveDeviceTextOverheard({ clientOverheard: false, lastIntentAt: 500, now: 1000, explicitGraceMs: 90_000 }), false);
    assert.equal(deriveDeviceTextOverheard({ clientOverheard: true, lastIntentAt: 500, now: 1000, explicitGraceMs: 90_000 }), true);
  });
  test("pickAlert", () => {
    assert.equal(pickAlert({ ok: false, output: "" }), "error");
    assert.equal(pickAlert({ ok: true, output: "Refused — budget" }), "budget_warn");
    assert.equal(pickAlert({ ok: true, output: "done" }), "task_done");
  });
  test("capture gate admits only within window or hands-free", () => {
    assert.equal(shouldProcessAudioFrame({ now: 10, captureWindowUntil: 20, handsFreeMode: false, handsFreeAllowed: false }).admit, true);
    assert.equal(shouldProcessAudioFrame({ now: 30, captureWindowUntil: 20, handsFreeMode: false, handsFreeAllowed: false }).admit, false);
  });
});

describe("device auth", () => {
  test("constant-time verify accepts the right token and rejects everything else", () => {
    const token = newToken();
    const devices = { phone: { hash: hashToken(token), createdAt: 0 } };
    assert.equal(verifyDevice(devices, "phone", token), true);
    assert.equal(verifyDevice(devices, "phone", token + "x"), false);
    assert.equal(verifyDevice(devices, "watch", token), false);
    assert.equal(verifyDevice(devices, "Phone!", token), false);
    assert.equal(verifyDevice(devices, "phone", ""), false);
  });
  test("rate limiter: burst then refill", () => {
    const rl = new RateLimiter(3, 1000);
    assert.deepEqual([rl.allow("a", 0), rl.allow("a", 0), rl.allow("a", 0), rl.allow("a", 0)], [true, true, true, false]);
    assert.equal(rl.allow("a", 1000), true);
    assert.equal(rl.allow("b", 0), true);
  });
});

describe("ambient gate", () => {
  test("flags commitments and keeps one neighbour each side", () => {
    const g = new AmbientGate();
    assert.deepEqual(g.push("nice weather"), []);
    assert.deepEqual(g.push("I'll send Bob the quote on Tuesday"), ["nice weather", "I'll send Bob the quote on Tuesday"]);
    assert.deepEqual(g.push("ok cool"), ["ok cool"]);
    assert.deepEqual(g.push("anyway"), []);
  });
  test("TV-style lines still only become data, never a reply path", () => {
    assert.ok(INTENT_RE.test("call now to book your appointment"));
  });
});

describe("proposals and tasks", () => {
  const p: Proposal = { id: "p-20260906120000-abcd", status: "pending", kind: "task", text: 'Send Bob the "quote"', when: "2026-09-08", quote: "I'll send Bob the quote: tuesday", source: "phone", created: "2026-09-06T12:00:00.000Z" };
  test("render/parse round trip", () => assert.deepEqual(parseProposal(renderProposal(p)), { ...p, nudged_at: undefined }));
  test("null when survives", () => assert.equal(parseProposal(renderProposal({ ...p, when: null }))?.when, null));
  test("task line uses Tasks-plugin date", () => {
    assert.equal(taskLine("Send Bob the quote", "2026-09-08T10:00"), "- [ ] Send Bob the quote 📅 2026-09-08");
    assert.equal(taskLine("Send Bob the quote", null), "- [ ] Send Bob the quote");
  });
  test("dueTasks picks open tasks due today or earlier", () => {
    const inbox = "# Inbox\n- [ ] a 📅 2026-09-05\n- [x] b 📅 2026-09-05\n- [ ] c 📅 2026-09-07\n- [ ] d\n";
    assert.deepEqual(dueTasks(inbox, "2026-09-06"), ["a 📅 2026-09-05"]);
    assert.deepEqual(dueTasks(inbox, "2026-09-06", true), ["a 📅 2026-09-05", "d"]);
  });
  test("validateMined drops junk and caps", () => {
    const out = validateMined({ proposals: [
      { kind: "task", text: "  Send Bob the quote ", when: "2026-09-08T10:00:00Z", quote: "q" },
      { kind: "weird", text: "x" }, { kind: "event", text: "", when: null, quote: "" },
      { kind: "event", text: "Dentist", when: "tuesday", quote: "q" },
    ] });
    assert.deepEqual(out, [
      { kind: "task", text: "Send Bob the quote", when: "2026-09-08T10:00", quote: "q" },
      { kind: "event", text: "Dentist", when: null, quote: "q" },
    ]);
    assert.equal(validateMined("nope").length, 0);
    assert.equal(validateMined({ proposals: Array(9).fill({ kind: "task", text: "t", when: null, quote: "" }) }).length, 5);
  });
});

describe("misc", () => {
  test("quiet hours wrap midnight", () => {
    assert.equal(isQuietHour(23, [22, 8]), true);
    assert.equal(isQuietHour(3, [22, 8]), true);
    assert.equal(isQuietHour(12, [22, 8]), false);
    assert.equal(isQuietHour(9, [9, 12]), true);
  });
  test("parseClaudeJson", () => {
    assert.deepEqual(parseClaudeJson(JSON.stringify({ result: " ok ", total_cost_usd: 0.01, is_error: false })), { ok: true, text: "ok", costUsd: 0.01, structured: undefined });
    assert.equal(parseClaudeJson("garbage").ok, false);
    assert.equal(parseClaudeJson(JSON.stringify({ subtype: "error_max_budget_usd", result: "" })).ok, false);
  });
});
