FROM node:20-bullseye-slim

# --- Java runtime (needed by apktool + jadx) ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-17-jre-headless curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- apktool ---
RUN mkdir -p /opt/tools && \
    curl -fL -o /opt/tools/apktool.jar \
      https://github.com/iBotPeaches/Apktool/releases/download/v3.0.2/apktool_3.0.2.jar

# --- jadx ---
RUN curl -fL -o /tmp/jadx.zip \
      https://github.com/skylot/jadx/releases/download/v1.5.6/jadx-1.5.6.zip && \
    unzip -q /tmp/jadx.zip -d /opt/tools/jadx && \
    chmod +x /opt/tools/jadx/bin/jadx && \
    rm /tmp/jadx.zip

ENV APKTOOL_JAR=/opt/tools/apktool.jar
ENV JADX_BIN=/opt/tools/jadx/bin/jadx
ENV WORK_ROOT=/tmp/apk-jobs
ENV NODE_ENV=production

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY public ./public

EXPOSE 8080
CMD ["node", "server/server.js"]
