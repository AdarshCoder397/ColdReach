from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import router
from app.core.database import engine
from app.models import Base

app = FastAPI(
    title="ColdReach API",
    description="Cold email campaign management platform",
    version="1.0.0",
)

# CORS Configuration
from app.core.config import settings
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Create tables AFTER app is defined
Base.metadata.create_all(bind=engine)

app.include_router(router, prefix="/api")

@app.get("/health")
def health():
    return {"status": "ok"}