# ronw-planner: zero-dependency Node server, so there's nothing to npm install.
FROM node:22-alpine

WORKDIR /app
COPY server.js app.js index.html styles.css package.json ./

# Accounts and guild data live on a volume at /data, never in the image.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4747 \
    DATA_DIR=/data \
    TRUST_PROXY=1

USER node
EXPOSE 4747

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4747/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
