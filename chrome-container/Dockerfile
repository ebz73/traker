# Source for Chrome 146 binary (Chrome 147 has a CDP regression that breaks
# patchright: Network.setCacheDisabled fails with "session closed").
FROM pricetracker-chrome-aci:test AS chrome-source

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install Chrome dependencies and tools
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    ca-certificates \
    gnupg \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    xvfb \
    socat \
    x11vnc \
    novnc \
    websockify \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Pin Chrome to 146.0.7680.164 by copying from a known-good image.
COPY --from=chrome-source /opt/google/chrome /opt/google/chrome
RUN ln -sf /opt/google/chrome/google-chrome /usr/bin/google-chrome-stable \
 && ln -sf /usr/bin/google-chrome-stable /usr/bin/google-chrome

# Create non-root user
RUN useradd -m -s /bin/bash chrome

# Create persistent profile directory
RUN mkdir -p /home/chrome/chrome-profile \
    && chown -R chrome:chrome /home/chrome/chrome-profile

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000 6080

ENTRYPOINT ["/entrypoint.sh"]
