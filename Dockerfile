# --- Étape 1 : compilation de l'interface
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
# VITE_DEMO=false masque les comptes de démonstration sur la page de connexion.
ARG VITE_DEMO=true
ENV VITE_DEMO=$VITE_DEMO
RUN npm run build

# --- Étape 2 : image d'exécution (dépendances de production uniquement)
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev && npm cache clean --force
COPY apps/api/src apps/api/src
COPY apps/api/tsconfig.json apps/api/
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
