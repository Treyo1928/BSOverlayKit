# The overlay's Discord bot (see README.md). Built and run by the overlay's docker-compose.yml.
FROM python:3.13-slim
WORKDIR /bot
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY bot.py deafen.py ./
# who the bot has deafened is kept here (a volume in docker-compose.yml), so a restart cannot leave anyone deaf
RUN useradd --system --uid 1000 bot && mkdir -p /bot/state && chown bot /bot/state
USER bot
ENV PYTHONUNBUFFERED=1
CMD ["python", "bot.py"]
