// Finding the two sides of the board over MIDI. Firmware 2026-11-21 answers
// F0 7D 32 48 07 F7 with who it is (see send_host_info() in MIDI2HOST.ino), so
// the page needs no serial port to show the board.

import { sleep } from "./serial.js";

export const PORT_NAME = { red: "H2H Red", blue: "H2H Blue" };
const ASK = [0xf0, 0x7d, 0x32, 0x48, 0x07, 0xf7];

const isReply = (d) => d[0] === 0xf0 && d[1] === 0x7d && d[2] === 0x32 && d[3] === 0x48 && d[4] === 0x08;

export function portsOf(access, side) {
  const pick = (map) => [...map.values()].find((p) => p.name?.includes(PORT_NAME[side]) && p.state === "connected") || null;
  return { input: pick(access.inputs), output: pick(access.outputs) };
}

function parseReply(d) {
  const date = (i) => (d[i] ? `20${String(d[i]).padStart(2, "0")}-${String(d[i + 1]).padStart(2, "0")}-${String(d[i + 2]).padStart(2, "0")}` : null);
  return {
    role: d[5] === 1 ? "blue" : "red",
    forced: ["none", "red", "blue"][d[6]] || "none",
    firmware: date(7),
    trsType: ["a", "b", null][d[10]] ?? null,
    other: d[11] ? "2026-11-20 or older" : date(12),
    linkOpen: d[15] === 1,
    parked: d[16] === 1,
    usbSerial: String.fromCharCode(...d.slice(17, -1)),
  };
}

// Asks one side who it is. Returns the answer, or { firmware: null } when the
// side has older firmware that does not answer, or null when it is not there.
export async function ask(access, side, ms = 500) {
  const { input, output } = portsOf(access, side);
  if (!input || !output) return null;
  let done;
  const got = new Promise((r) => (done = r));
  const listen = (e) => {
    const d = Array.from(e.data);
    if (isReply(d)) done(parseReply(d));
  };
  await input.open().catch(() => {});
  input.addEventListener("midimessage", listen);
  try {
    output.send(ASK);
    const reply = await Promise.race([got, sleep(ms).then(() => undefined)]);
    return reply ?? { role: side, firmware: null, forced: null, trsType: null, old: true };
  } finally {
    input.removeEventListener("midimessage", listen);
  }
}
