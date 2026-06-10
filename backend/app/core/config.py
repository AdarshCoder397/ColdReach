from pydantic_settings import BaseSettings
from typing import Optional

class Settings(BaseSettings):
    # App
    APP_NAME: str = "ColdReach"
    DEBUG: bool = False
    SECRET_KEY: str = "change-this-in-production-use-openssl-rand-hex-32"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days

    # Database
    DATABASE_URL: str = "postgresql://coldreach:coldreach@localhost:5432/coldreach"

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # Encryption key for SMTP passwords (generate with: Fernet.generate_key())
    ENCRYPTION_KEY: str = "your-fernet-key-here-generate-with-cryptography"

    # Timezone
    DEFAULT_TIMEZONE: str = "Asia/Kolkata"  # IST - India Standard Time
    IST_TIMEZONE: str = "Asia/Kolkata"

    # CORS origins
    CORS_ORIGINS_STR: str = "http://localhost:3000,http://localhost:3001,http://localhost:3002,http://localhost:3003,http://localhost:3004,http://127.0.0.1:3000,http://127.0.0.1:3003"

    @property
    def cors_origins(self) -> list[str]:
        return [x.strip() for x in self.CORS_ORIGINS_STR.split(",") if x.strip()]

    # OAuth Credentials (configure in env)
    GOOGLE_CLIENT_ID: str = "mock-google-client-id"
    GOOGLE_CLIENT_SECRET: str = "mock-google-client-secret"
    MICROSOFT_CLIENT_ID: str = "mock-microsoft-client-id"
    MICROSOFT_CLIENT_SECRET: str = "mock-microsoft-client-secret"

    # Email defaults
    DEFAULT_DAILY_LIMIT: int = 50
    REPLY_CHECK_INTERVAL_MINUTES: int = 5
    SEND_CHECK_INTERVAL_SECONDS: int = 60

    # Keep alive settings
    RENDER_EXTERNAL_URL: Optional[str] = None
    KEEP_ALIVE_URL: Optional[str] = None

    class Config:
        env_file = ".env"

settings = Settings()


