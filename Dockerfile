# Image tag MUST match the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

ENV NODE_ENV=production
WORKDIR /app

# Install deps first for layer caching
COPY package.json ./
RUN npm install --omit=dev

COPY stay-alive.js healthcheck.js ./

# State (last-success date, error throttle) persists here — mount a volume on it.
ENV STATE_PATH=/data/state.json
ENV HEALTH_PORT=8080
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=10s --start-period=45s --retries=3 \
  CMD node /app/healthcheck.js

# The base image already contains Chromium; no `playwright install` needed.
CMD ["node", "stay-alive.js"]
