FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json ./
RUN npm install --production

# Copy app source
COPY index.js ./

EXPOSE 3000

CMD ["node", "index.js"]
