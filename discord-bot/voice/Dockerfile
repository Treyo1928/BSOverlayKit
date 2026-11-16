# The Discord bot's ears: the part that sits in the voice channel (see ../README.md). Built and run by the overlay's docker-compose.yml.
FROM node:22-slim
WORKDIR /bot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY voice.mjs ./
USER node
CMD ["node", "voice.mjs"]
