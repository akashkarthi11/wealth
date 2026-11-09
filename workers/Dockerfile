FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY workers ./workers
ENV NODE_ENV=production
CMD ["npm","run","worker"]
