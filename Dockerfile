# SYSCOM IoT — API + front estático + LNS UDP (US915 por defecto)
# Build: docker build -t syscom-iot .
# Run:  ver docker-compose.yml (JWT_SECRET obligatorio en producción)

FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--experimental-sqlite
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY public ./public
EXPOSE 3001
EXPOSE 1700/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/setup/status',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "--experimental-sqlite", "server/server.js"]
