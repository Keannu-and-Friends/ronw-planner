# ronw-planner: zero-dependency Node server, so there's nothing to npm install.
FROM node:22-alpine

# su-exec lets the container start as root to fix ./data's owner, then run the app as the node user.
RUN apk add --no-cache su-exec

WORKDIR /app
COPY server.js app.js index.html styles.css package.json ./

# Accounts and guild data live in /data (./data on the host), never in the image.
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4747 \
    DATA_DIR=/data \
    TRUST_PROXY=1

EXPOSE 4747

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4747/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# A bind-mounted ./data is often created by Docker as root on the host. Give it to the node user, then drop root.
ENTRYPOINT ["/bin/sh", "-c", "if [ \"$(id -u)\" = 0 ]; then mkdir -p \"$DATA_DIR\"; chown -R node:node \"$DATA_DIR\" 2>/dev/null || true; exec su-exec node \"$@\"; fi; exec \"$@\"", "--"]
CMD ["node", "server.js"]
