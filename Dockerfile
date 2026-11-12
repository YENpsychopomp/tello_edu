# Tello 地面站映像：請在「有網路時」先 build（docker compose build），之後完全離線可用。
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY gcs ./gcs
COPY web ./web
COPY sim ./sim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8080 \
    GCS_IN_DOCKER=1

EXPOSE 8080/tcp 8890/udp 11111/udp

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=2).status == 200 else 1)"

# exec form：python 是 PID 1 的直接子行程（compose 另外設 init: true），SIGTERM 一定送得到
CMD ["python", "-m", "gcs"]
