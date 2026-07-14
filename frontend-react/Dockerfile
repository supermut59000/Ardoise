# Build stage. glibc image (not alpine/musl) so native tools (oxc/lightningcss)
# use prebuilt binaries instead of the wasm fallback.
# Use `npm install`, not `npm ci`: native tools ship platform-specific optional
# deps (@emnapi/*, *-linux-*) that a lockfile generated on one platform/npm
# version does not fully record, which makes the stricter `npm ci` refuse to run.
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# Production stage
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
