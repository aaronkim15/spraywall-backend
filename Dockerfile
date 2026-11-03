# Backend image for the Raspberry Pi (and anywhere else).
# node:22 Debian base: sharp ships prebuilt binaries for linux-arm64/amd64,
# so a plain npm install works on the Pi (use 64-bit Raspberry Pi OS).
FROM node:22-slim

WORKDIR /app

# Install deps first so this layer is cached unless package.json changes.
COPY package*.json ./
RUN npm install --omit=dev

# App source.
COPY . .
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000

# Entry: apply migrations, then start the server.
CMD ["./docker-entrypoint.sh"]
