FROM node:22-alpine
WORKDIR /app
COPY . .
# The platform's $PORT wins when set; 4402 is the fallback. VOUCH_PORT is
# deliberately not pinned here so it cannot override $PORT.
ENV VOUCH_STATE=/data/state.json
VOLUME /data
EXPOSE 4402
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:${PORT:-4402}/health || exit 1
CMD ["sh", "-c", "PORT=${PORT:-4402} node server.js"]
