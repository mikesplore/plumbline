FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml uv.lock README.md ./
COPY backend ./backend
COPY demo_api ./demo_api

RUN pip install --no-cache-dir uv && uv sync --locked --no-dev

EXPOSE 8000

CMD ["uv", "run", "--no-sync", "uvicorn", "plumbline.main:app", "--app-dir", "backend", "--host", "0.0.0.0", "--port", "8000"]
