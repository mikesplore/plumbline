FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml uv.lock README.md ./
COPY backend ./backend
COPY demo_api ./demo_api
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

RUN pip install --no-cache-dir uv && uv sync --locked --no-dev

EXPOSE 8000 8765

ENTRYPOINT ["/app/docker-entrypoint.sh"]
