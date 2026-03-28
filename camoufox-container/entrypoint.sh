#!/bin/bash
set -e

Xvfb :98 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
export DISPLAY=:98

sleep 1

x11vnc -display :98 -nopw -forever -shared -rfbport 5901 &
websockify --web /usr/share/novnc 6081 localhost:5901 &

exec env CAMOUFOX_HEADLESS=false python3 -m uvicorn broker:app \
    --host 0.0.0.0 --port 3001 --log-level info --app-dir /opt
