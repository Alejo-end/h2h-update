# H2H web page: update and test

`index.html` updates the firmware of both sides of an H2H board and tests it,
in Chrome or Edge on a computer. It does what `live-test/h2h_test.py` and the
flash scripts did, with no other program.

- Update: the page restarts a side as the RPI-RP2 drive (the 1200 baud reset),
  asks the person to choose that drive, and writes the firmware to it. A blue
  side that starts as red gets the firmware with a fixed blue role.
- Test: 19 checks over Web MIDI with both USB ports on one computer: every
  message type, SysEx up to 10004 bytes, latency, 2000 notes at once, clock,
  both directions at once, and no echo.
- Check by hand: the panic button, the A/B switch, and a cable from MIDI OUT to
  MIDI IN.

## Use it on this computer

Double-click `Open the H2H page.command`. It starts a small web server in this
folder and opens the page. Web Serial and Web MIDI do not work from a file
opened directly.

## Put out a new firmware

1. Change `FW_VERSION` and `FW_DATE` in `MIDI2HOST/MIDI2HOST.ino` to the new date.
2. Run `./release.sh "What changed, in one or two sentences"` in this folder.
   It builds the normal and the fixed-blue firmware, copies them to
   `firmware/<date>/`, and makes that date the newest in `firmware/manifest.json`.
3. Publish this folder. Every page that loads afterwards offers the new firmware.

## Publish

This folder is the repository Alejo-end/h2h-update, and GitHub Pages serves its
main branch at https://alejo-end.github.io/h2h-update/. After `./release.sh`,
commit and push:

```
git add -A && git commit -m "Firmware <date>" && git push
```

The page loads `firmware/manifest.json` from its own address, so every visitor
gets the new firmware after the push. `build-plate.sh` refreshes `js/plate.js`
from the H2H site (h2h-site) when its plate drawing changes.
