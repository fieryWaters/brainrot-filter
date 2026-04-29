FROM node:20-alpine

WORKDIR /app

COPY server/package.json ./package.json
COPY server/index.js ./index.js

RUN mkdir -p /app/ingest-log

EXPOSE 8787

CMD ["node", "index.js"]
