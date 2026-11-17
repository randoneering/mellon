FROM node:24.22.2-bookworm@sha256:8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40

WORKDIR /opt/pi
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org

COPY t3-runtime/ /opt/t3/
COPY start.mjs smoke.mjs smoke-client.mjs egress.mjs relay.mjs /opt/bootstrap/
COPY T3-LICENSE /opt/t3/LICENSE
RUN groupadd --gid 10001 worker \
    && useradd --uid 10001 --gid 10001 --home-dir /home/worker --no-create-home --shell /bin/bash worker \
    && mkdir -p /worker-state /home/worker /workspace/mellon \
    && chown 10001:10001 /worker-state /home/worker /workspace/mellon

ENV HOME=/home/worker \
    PI_CODING_AGENT_DIR=/worker-state/pi-agent \
    T3CODE_HOME=/worker-state/t3 \
    NODE_ENV=production \
    LD_LIBRARY_PATH=/opt/t3/lib \
    PATH=/opt/pi/node_modules/.bin:/opt/t3:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER 10001:10001
WORKDIR /workspace/mellon
ENTRYPOINT ["node", "/opt/bootstrap/start.mjs"]
CMD []
