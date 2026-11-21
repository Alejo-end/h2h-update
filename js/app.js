import { USB_FILTERS, sleep, readInfo, parseInfo, restartForUpdate } from "./serial.js";
import { ask } from "./board.js";
import { Diagram, h2h } from "./plate.js";
import { RED, BLUE, findPorts, Inbox, runAll, panicCheck, midiInCheck, midiOutPlay } from "./tests.js";

const $ = (id) => document.getElementById(id);
const SIDES = ["blue", "red"];
const NAME = { red: "host red", blue: "host blue" };
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// What the page knows about each side, from MIDI: the answer of ask() or null
const S = { red: null, blue: null };
const serialPorts = { red: null, blue: null };  // only needed to update
let access = null;    // Web MIDI
let release = null;   // the newest release from firmware/manifest.json
let busy = false;     // an update, the test or a check runs

// The plate in the middle: the H2H site's drawing and its model of the lights
const plate = new Diagram($("plate-host"), { mode: "panic" });
plate.onCap = () => doing("That is a picture. Press the panic button on the board itself.");
h2h.setPlugged("blue", false);
h2h.setPlugged("red", false);
h2h.start();

// Light running through the plate, at most a few times a second
const lastRun = { blue: 0, red: 0, din: 0 };
function showMessage(from, note = 60) {
  const now = performance.now();
  if (now - lastRun[from] < 220) return;
  lastRun[from] = now;
  void plate.play(h2h.send(from, note));
}

// --- Log and narration ---
function log(...parts) {
  const t = new Date().toTimeString().slice(0, 8);
  $("log").textContent += `${t} ${parts.join(" ")}\n`;
}
const doing = (t) => ($("doing").textContent = t);

// --- Rendering ---
const fwText = (info) => (info?.firmware ? `firmware ${info.firmware}` : "firmware 2026-11-20 or older");
const isCurrent = (info) => !!(info?.firmware && release && info.firmware === release.version);
let warnedMismatch = false;

function render() {
  for (const side of SIDES) {
    const info = S[side];
    document.querySelector(`.side-row.${side}`).classList.toggle("ok", !!info);
    let text = "not seen. Plug in its USB cable.";
    if (info) {
      text = `${fwText(info)}, ${isCurrent(info) ? "up to date" : release ? "an update is ready" : "checking"}`;
      if (side === "red" && info.trsType) text += `. Midi out sends type ${info.trsType}`;
      if (info.forced === "blue") text += ". Its role is fixed in the firmware";
    }
    $(`${side}-state`).textContent = text;
    h2h.setPlugged(side, !!info);
    const b = $(`update-${side}`);
    b.disabled = !info || !release || busy || !("serial" in navigator);
    b.textContent = info && isCurrent(info) ? `Install again on ${NAME[side]}` : `Update ${NAME[side]}`;
    b.classList.toggle("btn-ghost", !(info && release && !isCurrent(info)));
  }
  if (S.red?.trsType) h2h.setTrs(S.red.trsType);
  for (const id of ["run-tests", "check-panic", "check-in", "check-out"]) $(id).disabled = busy || !access;
  $("check-switch").disabled = busy || !S.red;

  if (busy) return;
  const mismatch = !!(S.red && S.blue && S.red.firmware !== S.blue.firmware);
  $("connect-note").textContent = mismatch ? "The two sides run different firmware, so they blink orange when they start. Update both." : "";
  if (mismatch && !warnedMismatch) {
    h2h.show("mismatch", "blue");
    h2h.show("mismatch", "red");
  }
  warnedMismatch = mismatch;

  // the state in words, only when it changes, so a test result stays until then
  let idle = "Both sides are here.";
  if (!access) idle = "Waiting for permission to use MIDI.";
  else if (!S.red && !S.blue) idle = "Plug in both USB ports of H2H.";
  else if (!S.red || !S.blue) idle = `${cap(NAME[S.red ? "blue" : "red"])} is not plugged in yet.`;
  else if (release && isCurrent(S.red) && isCurrent(S.blue)) idle = "Both sides run the newest firmware. Run the test.";
  else if (release) idle = "An update is ready.";
  if (idle !== lastIdle) doing(idle);
  lastIdle = idle;
}
let lastIdle = "";

// --- Seeing the board over MIDI ---
let refreshing = false;
const misses = { red: 0, blue: 0 };
async function refresh() {
  if (!access || refreshing || busy) return;
  refreshing = true;
  try {
    for (const side of SIDES) {
      const before = S[side];
      const now = await ask(access, side);
      // a side that answered before may be busy with a long SysEx: keep what it said, 3 tries
      if (now?.old && before?.firmware && (misses[side] = (misses[side] || 0) + 1) < 3) continue;
      misses[side] = 0;
      S[side] = now;
      if (!!before !== !!S[side]) {
        log(`${NAME[side]} ${S[side] ? "seen, " + fwText(S[side]) : "gone"}`);
        if (S[side]) h2h.show("handshake", side);
      }
    }
  } finally {
    refreshing = false;
    render();
  }
}

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    $("needs").hidden = false;
    return;
  }
  try {
    access = await navigator.requestMIDIAccess({ sysex: true });
  } catch (e) {
    log("midi:", e.message);
    $("connect-text").textContent = "The page needs your permission to use MIDI, or it cannot see H2H.";
    $("allow-midi").hidden = false;
    render();
    return;
  }
  $("allow-midi").hidden = true;
  $("connect-text").textContent = "The plate lights up when this computer sees a side.";
  access.onstatechange = () => setTimeout(refresh, 400);
  setInterval(refresh, 2000);
  await refresh();
}

// --- Updating ---
let flowResolve = null;
function flow(text, buttonText) {
  $("flow").hidden = false;
  $("flow-text").textContent = text;
  const b = $("flow-button");
  b.hidden = !buttonText;
  if (buttonText) b.textContent = buttonText;
  $("flow-cancel").textContent = "Stop";
  return buttonText ? new Promise((r) => (flowResolve = r)) : Promise.resolve();
}
function flowEnd(text) {
  $("flow-text").textContent = text;
  $("flow-button").hidden = true;
  $("flow-cancel").textContent = "Close";
}
class Stop extends Error {}
let stopFlow = false;

async function fetchFirmware(path) {
  const r = await fetch(`firmware/${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`The firmware file ${path} could not be loaded (${r.status}).`);
  const buf = await r.arrayBuffer();
  const magic = new Uint32Array(buf, 0, 2);
  if (magic[0] !== 0x0a324655 || magic[1] !== 0x9e5d5157) throw new Error(`${path} is not a UF2 file.`);
  return new Blob([buf]);
}

async function chooseDriveAndWrite(blob, side) {
  for (;;) {
    doing(`${cap(NAME[side])} is now a drive named RPI-RP2.`);
    await flow(`${cap(NAME[side])} is now a drive named RPI-RP2. Choose that drive in the next window and allow the page to save to it.`,
      "Choose the RPI-RP2 drive");
    if (stopFlow) throw new Stop();
    let dir;
    try {
      dir = await window.showDirectoryPicker({ id: "h2h-drive", mode: "readwrite" });
    } catch {
      continue;
    }
    try {
      await dir.getFileHandle("INFO_UF2.TXT");
    } catch {
      await flow(`"${dir.name}" is not the RPI-RP2 drive. If there is no RPI-RP2 drive, hold the BOOT button of ${NAME[side]} while you plug its cable in again.`,
        "Choose again");
      if (stopFlow) throw new Stop();
      continue;
    }
    flow("Writing the firmware. The side restarts when it is done.");
    doing(`Writing the firmware to ${NAME[side]}.`);
    const fh = await dir.getFileHandle("NEW.UF2", { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    try {
      await w.close();
    } catch (e) {
      log("close:", e.message, "(the side restarts as soon as the last block is in)");
    }
    return;
  }
}

async function update(side) {
  if (busy || !release) return;
  // The serial port is only needed to restart the side into update mode
  let port = serialPorts[side];
  if (!port) {
    try {
      port = await navigator.serial.requestPort({ filters: USB_FILTERS });
    } catch {
      return; // the list was closed
    }
  }
  busy = true;
  stopFlow = false;
  render();
  try {
    flow(`Asking ${NAME[side]} over its serial port.`);
    let sInfo;
    try {
      sInfo = parseInfo(await readInfo(port));
    } catch {
      throw new Error("That port is in use by another program, for example the Arduino serial monitor. Close it and try again.");
    }
    if (!sInfo) throw new Error("That port did not answer like a side of H2H.");
    serialPorts[sInfo.role] = port;
    if (sInfo.role !== side) throw new Error(`That port is ${NAME[sInfo.role]}. Click again and pick H2H ${cap(side)}.`);
    const force = side === "blue" && (sInfo.forced === "blue" || S.blue?.forced === "blue");
    const path = force ? release.files.force_blue : release.files.normal;
    log(`update ${side} with ${path}`);
    const blob = await fetchFirmware(path);

    flow(`Restarting ${NAME[side]} for the update.`);
    doing(`${cap(NAME[side])} restarts for the update.`);
    await restartForUpdate(port).catch((e) => log("restart:", e.message));
    S[side] = null;
    h2h.setPlugged(side, false);
    await sleep(1500);
    await chooseDriveAndWrite(blob, side);

    flow(`Waiting for ${NAME[side]} to start with the new firmware.`);
    doing(`Waiting for ${NAME[side]}.`);
    let info = null;
    for (const end = performance.now() + 25000; performance.now() < end;) {
      if (stopFlow) throw new Stop();
      await sleep(800);
      info = await ask(access, side, 400);
      if (info && !info.old) break;
    }
    S[side] = info;
    if (info) h2h.show("handshake", side);
    if (!info) {
      flowEnd(`${cap(NAME[side])} did not come back as ${NAME[side]}. If the page now sees two red sides, this blue side needs the firmware with a fixed blue role: see "Update without this page" below.`);
    } else {
      flowEnd(isCurrent(info) ? `Done. ${cap(NAME[side])} runs firmware ${info.firmware}.`
        : `${cap(NAME[side])} started, but it reports ${fwText(info)}. Try again.`);
    }
  } catch (e) {
    if (e instanceof Stop) flowEnd("Stopped. If a side is still an RPI-RP2 drive, unplug it and plug it in again.");
    else {
      log("update:", e.message);
      flowEnd(e.message);
    }
  } finally {
    busy = false;
    render();
    refresh();
  }
}

// --- Tests ---
function midiSetup() {
  const ports = findPorts(access);
  const missing = SIDES.filter((s) => !ports.out[s === "red" ? RED : BLUE] || !ports.in[s === "red" ? RED : BLUE]);
  if (missing.length) throw new Error(`The computer has no MIDI port for ${missing.map((s) => NAME[s]).join(" and ")}. Plug in both USB ports.`);
  // what arrives at one host came from the other side
  return {
    ports,
    boxes: { [RED]: new Inbox(ports.in[RED], () => showMessage("blue")), [BLUE]: new Inbox(ports.in[BLUE], () => showMessage("red")) },
  };
}

function addResult(r) {
  const list = $("results");
  if (list.dataset.group !== r.group) {
    list.dataset.group = r.group;
    const g = document.createElement("div");
    g.className = "group";
    g.textContent = r.group;
    list.append(g);
  }
  const item = document.createElement("div");
  item.className = `item ${r.ok ? "pass" : "fail"}`;
  const mark = document.createElement("span");
  mark.className = "mark";
  mark.textContent = r.ok ? "✓" : "✗";
  mark.setAttribute("aria-label", r.ok ? "passed" : "failed");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = r.name;
  const detail = document.createElement("span");
  detail.className = "detail";
  detail.textContent = r.detail || "";
  item.append(mark, name, detail);
  list.append(item);
  item.scrollIntoView({ block: "nearest" });
}

async function runTests() {
  if (busy) return;
  busy = true;
  render();
  const list = $("results");
  list.innerHTML = "";
  delete list.dataset.group;
  const results = [];
  try {
    const { ports, boxes } = midiSetup();
    await runAll(ports, boxes, (r) => {
      results.push(r);
      log(`${r.ok ? "PASS" : "FAIL"} ${r.group}: ${r.name} ${r.detail || ""}`);
      addResult(r);
    }, (t) => {
      $("test-progress").textContent = t;
      if (t) doing(cap(t));
    });
    const failed = results.filter((r) => !r.ok).length;
    const p = document.createElement("p");
    p.className = "summary";
    p.textContent = failed ? `${failed} of ${results.length} checks failed.` : `All ${results.length} checks passed.`;
    list.append(p);
    doing(failed ? `${failed} checks failed. The details are on the right.` : "H2H passed every check.");
  } catch (e) {
    log("test:", e.message);
    $("test-progress").textContent = e.message;
    doing(e.message);
  } finally {
    busy = false;
    render();
  }
}

async function handCheck(outId, fn) {
  if (busy) return;
  busy = true;
  render();
  const out = $(outId);
  out.className = "outcome";
  out.textContent = "";
  try {
    const r = await fn((t) => {
      out.textContent = t;
      doing(t);
    });
    out.textContent = r.detail;
    out.classList.add(r.ok ? "pass" : "fail");
    doing(r.detail);
    log(`${outId}: ${r.ok ? "PASS" : "FAIL"} ${r.detail}`);
  } catch (e) {
    out.textContent = e.message;
    out.classList.add("fail");
  } finally {
    plate.el.classList.remove("ask-panic");
    busy = false;
    render();
  }
}

const checkPanic = () =>
  handCheck("panic-out", async (say) => {
    const { ports, boxes } = midiSetup();
    plate.el.classList.add("ask-panic");
    say("Notes are held on both hosts. Press panic on the board now.");
    const r = await panicCheck(ports, boxes);
    plate.el.classList.remove("ask-panic");
    if (r.ok) {
      h2h.panic();
      plate.el.classList.remove("ring-flash");
      void plate.el.getBoundingClientRect();
      plate.el.classList.add("ring-flash");
    }
    return { ok: r.ok, detail: (r.ok ? "Panic works. " : "") + r.detail };
  });

const checkSwitch = () =>
  handCheck("switch-out", async (say) => {
    const first = (await ask(access, "red"))?.trsType;
    if (!first) throw new Error("Host red did not say its midi out type. Update it first.");
    say(`Midi out sends type ${first}. Flip the a trs b switch now.`);
    for (const end = performance.now() + 30000; performance.now() < end;) {
      await sleep(300);
      const info = await ask(access, "red", 300);
      if (info?.trsType && info.trsType !== first) {
        S.red = info;
        h2h.setTrs(info.trsType);
        return { ok: true, detail: `The switch works. Midi out changed from type ${first} to type ${info.trsType}.` };
      }
    }
    return { ok: false, detail: `Midi out stayed on type ${first} for 30 s.` };
  });

const checkIn = () =>
  handCheck("in-out", async (say) => {
    const { ports } = midiSetup();
    // notes from midi in reach both hosts: show them coming in on the plate
    const boxes = {
      [RED]: new Inbox(ports.in[RED], (m) => (m.d[0] & 0xf0) === 0x90 && showMessage("din", m.d[1])),
      [BLUE]: new Inbox(ports.in[BLUE], () => {}),
    };
    say("Play a few notes on the keyboard on midi in now.");
    const r = await midiInCheck(boxes);
    return { ok: r.ok, detail: (r.ok ? "Midi in works. " : "") + r.detail };
  });

const checkOut = () =>
  handCheck("out-out", async (say) => {
    const { ports } = midiSetup();
    say("Playing nine notes on channel 1 to midi out.");
    const timer = setInterval(() => showMessage("red"), 230);
    await midiOutPlay(ports);
    clearInterval(timer);
    const type = S.red?.trsType;
    return { ok: true, detail: `Played nine notes on channel 1${type ? `, type ${type}` : ""}. If the synth stayed silent, flip the a trs b switch and play again.` };
  });

// --- Firmware list ---
async function loadManifest() {
  try {
    const r = await fetch("firmware/manifest.json", { cache: "no-store" });
    const m = await r.json();
    release = m.releases.find((x) => x.version === m.latest) || m.releases[0];
    $("latest").textContent = `Firmware ${release.version}`;
    $("notes").textContent = release.notes || "";
    const dl = $("downloads");
    dl.innerHTML = "";
    const add = (href, text) => {
      const a = document.createElement("a");
      a.href = `firmware/${href}`;
      a.download = href.split("/").pop();
      a.textContent = text;
      dl.append(a);
    };
    add(release.files.normal, `Firmware ${release.version}`);
    add(release.files.force_blue, `Firmware ${release.version}, fixed blue role`);
  } catch (e) {
    log("manifest:", e.message);
    $("latest").textContent = "Firmware";
    $("notes").textContent = "The firmware list could not be loaded. Check the internet connection and reload the page.";
    $("downloads").textContent = "";
  }
  render();
}

// --- Start ---
async function start() {
  for (const side of SIDES) $(`update-${side}`).onclick = () => update(side);
  $("flow-button").onclick = () => flowResolve?.();
  $("flow-cancel").onclick = () => {
    if (busy) {
      stopFlow = true;
      flowResolve?.();
    } else $("flow").hidden = true;
  };
  $("allow-midi").onclick = initMidi;
  $("run-tests").onclick = runTests;
  $("check-panic").onclick = checkPanic;
  $("check-switch").onclick = checkSwitch;
  $("check-in").onclick = checkIn;
  $("check-out").onclick = checkOut;
  if (!("serial" in navigator) || !navigator.requestMIDIAccess) $("needs").hidden = false;
  render();
  await loadManifest();
  await initMidi();
}

start();
