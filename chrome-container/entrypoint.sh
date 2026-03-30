#!/bin/bash
set -e

# Start Xvfb virtual display
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
export DISPLAY=:99

# Wait for Xvfb to be ready
sleep 1

x11vnc -display :99 -nopw -forever -shared -rfbport 5900 &
websockify --web /usr/share/novnc 6080 localhost:5900 &

socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222 &

exec google-chrome-stable \
    --remote-debugging-port=9222 \
    --remote-debugging-address=0.0.0.0 \
    --user-data-dir=/home/chrome/chrome-profile \
    --window-size=1920,1080 \
    --no-first-run \
    --no-default-browser-check \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-dev-shm-usage \
    --no-sandbox \
    --lang=en-US \
    --disable-blink-features=AutomationControlled \
    --disable-background-networking \
    --disable-sync \
    --disable-translate \
    --mute-audio
