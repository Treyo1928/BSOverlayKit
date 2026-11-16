# The caster bot (see README.md). Built and run by the overlay's docker-compose.yml.
FROM node:22-slim
WORKDIR /bot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY bot.mjs deafen.mjs ./
# who the bot has deafened is kept here (a volume in docker-compose.yml), so a restart cannot leave anyone deaf
RUN mkdir -p /bot/state && chown node:node /bot/state
USER node
CMD ["node", "bot.mjs"]
