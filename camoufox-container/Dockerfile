FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# System deps for Camoufox (Firefox) + VNC
RUN apt-get update && apt-get install -y \
    wget ca-certificates fonts-liberation \
    python3 python3-pip \
    libgtk-3-0 libdbus-glib-1-2 libxt6 libx11-xcb1 \
    libasound2t64 libxcomposite1 libxdamage1 libxrandr2 \
    libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libgbm1 libnspr4 libnss3 libpango-1.0-0 \
    libxss1 libxtst6 \
    xvfb x11vnc novnc websockify \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Camoufox + broker deps
RUN pip3 install --break-system-packages --ignore-installed \
    camoufox \
    fastapi \
    "uvicorn[standard]"

# Download Camoufox Firefox binary
RUN python3 -m camoufox fetch

COPY broker.py /opt/broker.py
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 3001=Camoufox broker, 6081=noVNC
EXPOSE 3001 6081

ENTRYPOINT ["/entrypoint.sh"]
