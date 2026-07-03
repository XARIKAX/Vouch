FROM node:22-alpine
WORKDIR /app
COPY . .
ENV VOUCH_PORT=4402 \
    VOUCH_STATE=/data/state.json
VOLUME /data
EXPOSE 4402
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:4402/health || exit 1
CMD ["node", "server.js"]
