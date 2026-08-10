# The badge relay. Build context is the repository root:
#
#   docker build -f server/Dockerfile .
#
# There is no install step, and that is not an omission. The relay imports only
# node: builtins - no package.json, no lockfile, nothing to audit or pin - so
# the entire build is three file copies. Keeping it that way is deliberate: an
# image with no dependencies has no dependency updates.

FROM node:22-alpine

WORKDIR /app

# Exactly what the relay needs. test.mjs is left out on purpose: it pulls in
# tools/fake-badge.mjs, and a test harness has no business in a running server.
COPY server/index.mjs server/ws.mjs server/rooms.mjs server/store.mjs ./server/

# --root wants a directory, and the relay serves static files out of it. Point
# it at an empty one and the only things it answers are /ws and /health, which
# is all a public relay should do - the app itself is served from chipseq.app.
# To make this host the app as well (a venue fallback), copy the repository in
# and drop the --root argument instead.
RUN mkdir -p /srv/empty

# Where the adoptions database goes when compose mounts a volume here. Created
# in the image and owned by `node` on purpose: Docker copies the mountpoint's
# ownership onto a fresh named volume, and without this the volume arrives
# owned by root and the unprivileged process cannot write to it.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8080

# No --db here: the image on its own keeps state in memory, so it runs with no
# volume attached. compose.yaml adds the flag along with somewhere to put it.
CMD ["node", "server/index.mjs", "--port", "8080", "--root", "/srv/empty"]
