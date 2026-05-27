FROM node:20-alpine

# Build tools needed for better-sqlite3 native bindings
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Data directory will be mounted as a Railway volume at /data
RUN mkdir -p /data/uploads

EXPOSE 3000
CMD ["node", "server.js"]
