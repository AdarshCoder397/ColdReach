#!/bin/bash

# Start Redis server in the background
redis-server --daemonize yes

# Start Celery beat in the background
celery -A app.workers.tasks.celery_app beat --loglevel=info &

# Start Celery worker in the background (limit concurrency to 1 to fit in 512MB RAM)
celery -A app.workers.tasks.celery_app worker --loglevel=info --concurrency=1 &

# Start FastAPI server in the foreground
uvicorn main:app --host 0.0.0.0 --port 10000
