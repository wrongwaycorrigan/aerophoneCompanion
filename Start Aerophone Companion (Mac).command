#!/bin/sh
cd "$(dirname "$0")/app" || exit 1
PORT=8642
( sleep 1
  if [ -d "/Applications/Google Chrome.app" ]; then open -na "Google Chrome" --args --app="http://localhost:$PORT/"
  elif [ -d "/Applications/Microsoft Edge.app" ]; then open -na "Microsoft Edge" --args --app="http://localhost:$PORT/"
  else open "http://localhost:$PORT/"; fi ) &
echo "Aerophone Companion running at http://localhost:$PORT  (close this window to stop)"
exec python3 -m http.server $PORT --bind 127.0.0.1
