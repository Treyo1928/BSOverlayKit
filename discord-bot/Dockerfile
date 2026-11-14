# The caster bot (see README.md). Built and run by the overlay's docker-compose.yml.
FROM node:22-slim
WORKDIR /bot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY bot.mjs ./
USER node
CMD ["node", "bot.mjs"]
