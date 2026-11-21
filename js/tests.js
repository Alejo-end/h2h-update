// The host-to-host test of live-test/h2h_test.py, in the browser (Web MIDI).
// Both USB ports of the board must be on this computer. Web MIDI gives each
// message the time it arrived, and can send at a set time, so the clock test
// measures the board and not the browser.

import { sleep } from "./serial.js";

export const RED = "H2H Red";
export const BLUE = "H2H Blue";

export async function openMidi() {
  if (!navigator.requestMIDIAccess) throw new Error("This browser has no Web MIDI. Use Chrome or Edge.");
  return navigator.requestMIDIAccess({ sysex: true });
}

// The H2H ports, or null for each side that is not there
export function findPorts(access) {
  const pick = (map, name) => [...map.values()].find((p) => p.name && p.name.includes(name)) || null;
  return {
    out: { [RED]: pick(access.outputs, RED), [BLUE]: pick(access.outputs, BLUE) },
    in: { [RED]: pick(access.inputs, RED), [BLUE]: pick(access.inputs, BLUE) },
  };
}

// Collects what one input receives
export class Inbox {
  constructor(input, onMessage) {
    this.msgs = [];
    this.last = 0;
    this.waiter = null;
    input.onmidimessage = (e) => {
      const m = { d: Array.from(e.data), t: e.timeStamp };
      if (isHousekeeping(m.d)) return;
      this.msgs.push(m);
      this.last = performance.now();
      onMessage?.(m);
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(m);
      }
    };
  }
  take() {
    const m = this.msgs;
    this.msgs = [];
    return m;
  }
  // Waits until the input was quiet for quietMs (at most maxMs), then returns all it got
  async settle(quietMs = 300, maxMs = 10000) {
    const start = performance.now();
    for (;;) {
      await sleep(10);
      const now = performance.now();
      if (now - Math.max(this.last, start) >= quietMs || now - start >= maxMs) return this.take();
    }
  }
  next(timeoutMs) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = (m) => {
        clearTimeout(t);
        resolve(m);
      };
    });
  }
}

// Not part of the test: MIDI-CI discovery from the computer (F0 7E xx 0D ..),
// and the board's answer to the page's "who are you" (F0 7D 32 48 08 ..)
export const isHousekeeping = (d) =>
  d[0] === 0xf0 && ((d[1] === 0x7e && d[3] === 0x0d) || (d[1] === 0x7d && d[2] === 0x32 && d[3] === 0x48 && d[4] === 0x08));

const same = (a, b) => a.length === b.length && a.every((m, i) => m.length === b[i].length && m.every((x, j) => x === b[i][j]));
const flat = (msgs) => msgs.flatMap((m) => m.d);

function allTypes() {
  const out = [];
  for (let ch = 0; ch < 16; ch++)
    out.push([0x90 | ch, 60, 100], [0x80 | ch, 60, 0], [0xb0 | ch, 7, 127], [0xc0 | ch, 5], [0xd0 | ch, 64],
      [0xa0 | ch, 60, 33], [0xe0 | ch, 0, 64]);
  out.push([0x90, 61, 0]);                                // note on with velocity 0
  out.push([0xf8], [0xfa], [0xfb], [0xfc]);               // clock, start, continue, stop
  out.push([0xf2, 0x10, 0x02], [0xf3, 3], [0xf1, 0x21], [0xf6]);
  return out;
}

function sysex(n, seed) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) % 128;
  };
  const b = [0xf0, 0x7d, 0x00];
  for (let i = 0; i < n; i++) b.push(rnd());
  b.push(0xf7);
  return b;
}

const short = (name) => "host " + name.replace("H2H ", "").toLowerCase();

// Runs every automatic test. report(result) is called for each result as it comes:
// { group, name, ok, detail }
export async function runAll(ports, boxes, report, progress) {
  const quiet = async () => {
    await sleep(50);
    boxes[RED].take();
    boxes[BLUE].take();
  };
  const offAll = (o) => {
    for (let ch = 0; ch < 16; ch++) o.send([0xb0 | ch, 123, 0]);
  };

  async function direction(src, dst) {
    const o = ports.out[src], box = boxes[dst];
    const group = `${short(src)} to ${short(dst)}`;
    await quiet();

    progress(`${group}: every message type`);
    const sent = allTypes();
    const t0 = performance.now() + 20;
    sent.forEach((m, i) => o.send(m, t0 + i * 2));
    let got = (await box.settle(400)).map((m) => m.d);
    report({ group, name: `Every message type (${sent.length})`, ok: same(got, sent),
      detail: same(got, sent) ? "" : `got ${got.length} of ${sent.length}` });

    for (const n of [10, 1000, 4000, 10000]) {
      progress(`${group}: SysEx of ${n + 4} bytes`);
      const sx = sysex(n, n);
      await quiet();
      const start = performance.now();
      o.send(sx);
      let bytes = [];
      while (performance.now() - start < 8000 && bytes[bytes.length - 1] !== 0xf7) {
        await sleep(20);
        bytes = bytes.concat(flat(box.take()));
      }
      const dt = (performance.now() - start) / 1000;
      await sleep(150);
      bytes = bytes.concat(flat(box.take()));
      const ok = bytes.length === sx.length && bytes.every((x, i) => x === sx[i]);
      report({ group, name: `SysEx of ${n + 4} bytes`, ok, detail: ok ? `${dt.toFixed(2)} s` : `got ${bytes.length} bytes` });
    }

    progress(`${group}: latency`);
    await quiet();
    // each note is sent at a set time a little ahead, so the browser's own delay in
    // passing it on does not count: only the board and USB. As for the clock, a busy
    // computer holds one now and then, so 98 % must be within 3 ms.
    const lat = [];
    for (let k = 0; k < 200; k++) {
      box.take();
      const t = performance.now() + 4;
      const wait = box.next(500);
      o.send([0x90, k % 128, 1 + (k % 127)], t);
      const m = await wait;
      if (m) lat.push(m.t - t);
      o.send([0x80, k % 128, 0]);
      await box.settle(5, 100);
    }
    lat.sort((a, b) => a - b);
    const at = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] ?? 0;
    report({ group, name: "Latency of 200 notes", ok: lat.length === 200 && at(0.5) < 2 && at(0.98) < 3,
      detail: `median ${at(0.5).toFixed(2)} ms, 98 % within ${at(0.98).toFixed(2)} ms, longest ${at(1).toFixed(2)} ms, ${lat.length} of 200 arrived` });

    progress(`${group}: 2000 notes at once`);
    await quiet();
    const burst = [];
    for (let k = 0; k < 2000; k++) burst.push([0x90 | (k % 16), k % 128, 1 + (k % 127)]);
    const b0 = performance.now();
    burst.forEach((m) => o.send(m));
    const arrived = await box.settle(500, 15000);
    got = arrived.map((m) => m.d);
    const span = arrived.length ? (arrived[arrived.length - 1].t - b0) / 1000 : 1;
    report({ group, name: "2000 notes at once, in order, none lost", ok: same(got, burst),
      detail: `${got.length} arrived, ${Math.round(got.length / Math.max(span, 0.001))} notes a second` });
    offAll(o);
    await box.settle(200);
  }

  async function clock(src, dst) {
    const o = ports.out[src], box = boxes[dst];
    const group = `${short(src)} to ${short(dst)}`;
    progress(`${group}: clock`);
    await quiet();
    const period = 60000 / 120 / 24, n = 240;
    const t0 = performance.now() + 100;
    const sent = [];
    for (let k = 0; k < n; k++) {
      sent.push(t0 + k * period);
      o.send([0xf8], t0 + k * period);
    }
    await sleep(n * period + 400);
    const ticks = box.take().filter((m) => m.d[0] === 0xf8).map((m) => m.t);
    // Each tick is sent at its exact time (Web MIDI schedules it), so the time from
    // sending to arriving is what the board and USB add. USB moves MIDI in 1 ms
    // frames. A busy computer holds a message for 5 to 60 ms now and then, with any
    // MIDI device (measured on firmware 2026-11-20 too), so 98 % within 3 ms is good.
    const lat = ticks.length === n ? ticks.map((t, k) => t - sent[k]).sort((a, b) => a - b) : [];
    const at = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] ?? 99;
    report({ group, name: "Clock at 120 BPM for 5 s", ok: ticks.length === n && at(0.98) < 3,
      detail: ticks.length === n
        ? `240 ticks, each ${at(0.5).toFixed(2)} ms after sending, 98 % within ${at(0.98).toFixed(2)} ms, the latest ${at(1).toFixed(2)} ms`
        : `${ticks.length} of ${n} ticks arrived` });
  }

  async function bothWays() {
    progress("Both directions at once");
    await quiet();
    const sa = [], sb = [];
    for (let k = 0; k < 1000; k++) {
      sa.push([0x91, k % 128, 1 + (k % 127)]);
      sb.push([0x92, k % 128, 1 + (k % 127)]);
    }
    sa.forEach((m, i) => {
      ports.out[RED].send(m);
      ports.out[BLUE].send(sb[i]);
    });
    await sleep(200);
    const [ga, gb] = await Promise.all([boxes[BLUE].settle(500), boxes[RED].settle(500)]);
    const ok = same(ga.map((m) => m.d), sa) && same(gb.map((m) => m.d), sb);
    report({ group: "both ways", name: "1000 notes each way at the same time", ok,
      detail: `${ga.length} and ${gb.length} of 1000 arrived` });
    offAll(ports.out[RED]);
    offAll(ports.out[BLUE]);
    await sleep(200);
  }

  async function echo() {
    for (const name of [RED, BLUE]) {
      progress(`${short(name)}: no echo`);
      await quiet();
      ports.out[name].send([0x90, 70, 70]);
      ports.out[name].send([0x80, 70, 0]);
      const back = await boxes[name].settle(300, 1000);
      report({ group: "both ways", name: `Nothing comes back to ${short(name)}`, ok: back.length === 0,
        detail: back.length ? `${back.length} messages came back (is a cable from MIDI OUT to MIDI IN plugged in?)` : "" });
    }
  }

  // Nothing may arrive before the test sends anything
  progress("Listening for other MIDI");
  boxes[RED].take();
  boxes[BLUE].take();
  await sleep(600);
  const stray = boxes[RED].take().length + boxes[BLUE].take().length;
  if (stray) {
    report({ group: "before the test", name: "Nothing else sends MIDI to the hosts", ok: false,
      detail: `${stray} messages came in without the page sending any. Unplug what is on midi in. If that is not it, a program on this computer passes MIDI from one side to the other, for example a DAW track that listens to H2H Blue and plays to H2H Red: quit it, then run the test again.` });
    progress("");
    return;
  }

  await direction(BLUE, RED);
  await clock(BLUE, RED);
  await direction(RED, BLUE);
  await clock(RED, BLUE);
  await bothWays();
  await echo();
  progress("");
}

// Panic: notes are held on both hosts, then the person presses the button.
// Each host must get a note off for its held note, sustain off and all notes
// off. Returns { ok, detail }.
export async function panicCheck(ports, boxes, waitMs = 30000) {
  for (const b of Object.values(boxes)) b.take();
  ports.out[BLUE].send([0x93, 61, 90]);  // reaches host 1
  ports.out[RED].send([0x94, 62, 90]);   // reaches host 2
  await sleep(150);
  boxes[RED].take();
  boxes[BLUE].take();
  const start = performance.now();
  const seen = (box) => box.msgs.some((m) => (m.d[0] & 0xf0) === 0xb0 && m.d[1] === 123);
  while (performance.now() - start < waitMs && !(seen(boxes[RED]) && seen(boxes[BLUE]))) await sleep(50);
  if (!seen(boxes[RED]) && !seen(boxes[BLUE])) return { ok: false, detail: "No panic arrived. Press the button on the board." };
  await sleep(300);
  const check = (box, noteOff) => {
    const m = box.take().map((x) => x.d);
    const off = m.some((d) => d[0] === noteOff[0] && d[1] === noteOff[1]);
    const chans = (cc) => new Set(m.filter((d) => (d[0] & 0xf0) === 0xb0 && d[1] === cc).map((d) => d[0] & 15)).size;
    const sustain = new Set(m.filter((d) => (d[0] & 0xf0) === 0xb0 && d[1] === 64 && d[2] === 0).map((d) => d[0] & 15)).size;
    return { off, notesOff: chans(123), soundOff: chans(120), sustain };
  };
  const r = check(boxes[RED], [0x83, 61]);
  const b = check(boxes[BLUE], [0x84, 62]);
  const good = (x) => x.off && x.notesOff === 16 && x.soundOff === 16 && x.sustain === 16;
  const say = (x, host) =>
    `${host}: ${x.off ? "note off" : "no note off"}, sustain off on ${x.sustain}, all sound off on ${x.soundOff}, all notes off on ${x.notesOff} of 16 channels`;
  return { ok: good(r) && good(b), detail: `${say(r, "Host red")}. ${say(b, "Host blue")}.` };
}

// MIDI IN goes to both hosts. A keyboard on midi in: both hosts must get its
// notes. Returns { ok, detail }.
export async function midiInCheck(boxes, waitMs = 20000) {
  for (const b of Object.values(boxes)) b.take();
  const notes = (box) => box.msgs.filter((m) => (m.d[0] & 0xf0) === 0x90 && m.d[2] > 0);
  const start = performance.now();
  while (performance.now() - start < waitMs && !(notes(boxes[RED]).length && notes(boxes[BLUE]).length)) await sleep(50);
  const r = notes(boxes[RED]), b = notes(boxes[BLUE]);
  for (const x of Object.values(boxes)) x.take();
  if (!r.length && !b.length) return { ok: false, detail: "No note came in. Check the cable and that the keyboard sends on its MIDI or TRS out." };
  const ch = ((r[0] || b[0]).d[0] & 15) + 1;
  return { ok: r.length > 0 && b.length > 0,
    detail: `Host red got ${r.length} and host blue got ${b.length} notes, on channel ${ch}.` };
}

// Plays a short phrase from host red, which goes out of midi out. Only the
// person can hear whether the synth plays it.
export async function midiOutPlay(ports) {
  const o = ports.out[RED];
  const t0 = performance.now() + 50;
  [60, 62, 64, 65, 67, 65, 64, 62, 60].forEach((n, i) => {  // not the party melody (60 64 67 72 67 64 60)
    o.send([0x90, n, 96], t0 + i * 220);
    o.send([0x80, n, 0], t0 + i * 220 + 180);
  });
  await sleep(9 * 220 + 300);
}
