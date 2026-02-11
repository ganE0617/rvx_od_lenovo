FROM node:18-bullseye-slim AS builder

# Install build dependencies for mediasoup (Python, build-essential)
RUN apt-get update && apt-get install -y python3 python3-pip build-essential

WORKDIR /app
# Copy root files
COPY package.json turbo.json ./
COPY packages ./packages
COPY apps/media-server ./apps/media-server

# Install deps (using npm workspaces)
RUN npm install

# Build
RUN npm run build --workspace=media-server

# --- Production Stage ---
FROM node:18-bullseye-slim AS runner

WORKDIR /app

# Install runtime deps (if any, e.g. python might be needed for worker binary?) 
# Mediasoup usually bundles prebuilt worker or builds it.
# If built from source, we need to copy the build outcome.
# We will just copy node_modules from builder for simplicity in MVP, 
# although not optimal for size.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Copy workspaces built code
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/media-server ./apps/media-server

WORKDIR /app/apps/media-server

CMD ["node", "dist/index.js"]
