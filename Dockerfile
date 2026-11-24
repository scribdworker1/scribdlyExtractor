FROM node:20-bookworm-slim

# Install system utilities, fonts, process manager (tini for zombie reaping), and Chrome dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    fonts-noto \
    fonts-noto-cjk \
    xdg-utils \
    tini \
    procps \
 && mkdir -p /etc/apt/keyrings \
 && wget -qO - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y google-chrome-stable --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/google-chrome-stable
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

# Set proper writable directories for Chrome in container
ENV HOME=/home/node
ENV XDG_CONFIG_HOME=/tmp/.chromium
ENV XDG_CACHE_HOME=/tmp/.chromium

WORKDIR /app

# Ensure directories exist and are owned by node user
RUN mkdir -p /tmp/.chromium /tmp/chromium-user-data \
             /home/node/.config/google-chrome/Crashpad \
             /home/node/.config/google-chrome/"Crash Reports" \
             /home/node/.config/chromium/Crashpad \
             /home/node/.config/chromium/"Crash Reports" \
 && chown -R node:node /tmp/.chromium /tmp/chromium-user-data /home/node /app

# Install dependencies (no lockfile required)
COPY package.json ./
RUN npm install --omit=dev

# Copy source code
COPY src ./src
RUN chown -R node:node /app

# Run as built-in non-root 'node' user
USER node

EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
