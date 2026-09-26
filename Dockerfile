# Image unique : API + interface web compilée.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "apps/api"]
