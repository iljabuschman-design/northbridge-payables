FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data
ENV DB_PATH=/app/data/app.db

EXPOSE 3000
CMD ["node", "server.js"]

