FROM node:20-alpine

WORKDIR /app

# Copy root package files
COPY package.json package-lock.json ./

# Copy workspace packages
COPY contracts/package.json ./contracts/
COPY frontend/package.json ./frontend/

# Install all dependencies (needed for workspaces to link correctly)
RUN npm install --ignore-scripts

# Copy source files needed by the relayer
COPY scripts/ ./scripts/
COPY contracts/ ./contracts/
COPY frontend/src/deployments.json ./frontend/src/deployments.json

ENV NETWORK=paseo

CMD ["sh", "-c", "cd contracts && NODE_PATH=$(pwd)/node_modules:$(pwd)/../node_modules NETWORK=paseo npx ts-node --transpile-only --skip-project --compiler-options '{\"module\":\"commonjs\",\"esModuleInterop\":true,\"resolveJsonModule\":true}' ../scripts/relayer.ts"]
