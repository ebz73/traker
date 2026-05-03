#!/bin/bash
set -e

Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
export DISPLAY=:99

sleep 1

if [ -n "$VNC_PASSWORD" ]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/x11vnc.pass
  x11vnc -display :99 -rfbauth /tmp/x11vnc.pass -forever -shared -rfbport 5901 &
else
  x11vnc -display :99 -nopw -forever -shared -rfbport 5901 &
fi
websockify --web /usr/share/novnc 6081 localhost:5901 &

exec env CAMOUFOX_HEADLESS=false python3 -m uvicorn broker:app \
    --host 0.0.0.0 --port 3001 --log-level info --app-dir /opt
