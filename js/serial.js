// Talking to an H2H module over its USB serial port (Web Serial).
// Each module answers "info" with a few lines of text, see MIDI2HOST.ino.

export const USB_FILTERS = [{ usbVendorId: 0x239a, usbProductId: 0xcafe }];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Opens the port, sends "info" and returns the text that comes back.
export async function readInfo(port, ms = 1500) {
  await port.open({ baudRate: 115200 });
  try {
    await port.setSignals({ dataTerminalReady: true, requestToSend: true }).catch(() => {});
    const reader = port.readable.getReader();
    const writer = port.writable.getWriter();
    await sleep(120);
    await writer.write(new TextEncoder().encode("info\n"));
    writer.releaseLock();
    const dec = new TextDecoder();
    const end = performance.now() + ms;
    let text = "";
    while (performance.now() < end && !/designed[^\n]*\n/.test(text)) {
      const r = await Promise.race([reader.read(), sleep(end - performance.now()).then(() => null)]);
      if (!r || r.done) break;
      text += dec.decode(r.value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    return text;
  } finally {
    await port.close().catch(() => {});
  }
}

// Turns the "info" text into an object. Firmware 2026-11-20 and older print
// no firmware, usb serial or role line: those fields stay null.
export function parseInfo(text) {
  const line = (key) => {
    const m = text.match(new RegExp("^" + key + "\\s+(.*?)\\s*$", "m"));
    return m ? m[1] : null;
  };
  const side = line("this side");
  if (!side || !/h2h/i.test(text)) return null;
  const roleLine = line("role");
  const fw = line("firmware");
  return {
    raw: text.trim(),
    role: /blue/i.test(side) ? "blue" : "red",
    firmware: fw ? fw.split(/\s/)[0] : null,
    other: line("other side"),
    usbSerial: line("usb serial"),
    forced: roleLine ? (/forced blue/.test(roleLine) ? "blue" : /forced red/.test(roleLine) ? "red" : "none") : null,
    trsType: (line("midi out") || "").match(/type ([ab])/)?.[1] || null,
    gate: line("link gate"),
    link: line("link"),
    dropped: line("dropped"),
  };
}

// The 1200 baud touch: the module restarts as the RPI-RP2 drive.
export async function restartForUpdate(port) {
  try {
    await port.open({ baudRate: 1200 });
    await port.setSignals({ dataTerminalReady: true }).catch(() => {});
    await sleep(80);
    await port.setSignals({ dataTerminalReady: false }).catch(() => {});
    await sleep(80);
  } finally {
    await port.close().catch(() => {});
  }
}
