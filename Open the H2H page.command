#!/bin/zsh
# Double-click to open the H2H page from this folder. It runs a small web server
# on this computer (Web Serial and Web MIDI need one) and opens Chrome or Edge.
cd "${0:A:h}"
PORT=8765
python3 serve.py $PORT &
SERVER=$!
sleep 1
URL="http://127.0.0.1:$PORT/"
open -a "Google Chrome" "$URL" 2>/dev/null || open -a "Microsoft Edge" "$URL" 2>/dev/null || open "$URL"
echo "The H2H page runs at $URL. Close this window to stop it."
wait $SERVER
