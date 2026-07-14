from typing import List

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # API
    API_V1_STR: str = "/api/v1"
    PROJECT_NAME: str = "Ardoise API"
    PROJECT_DESCRIPTION: str = "Sync relay for the Ardoise shared-expenses PWA (operation log)"
    VERSION: str = "0.1.0"

    # Database (MariaDB). Must be set in .env
    DB_HOST: str
    DB_PORT: int = 3306
    DB_USER: str
    DB_PASSWORD: str
    DB_NAME: str = "ardoise"

    @property
    def database_url(self) -> str:
        return (
            f"mysql+pymysql://{self.DB_USER}:{self.DB_PASSWORD}"
            f"@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}?charset=utf8mb4"
        )

    # Shared instance password. When set, every sync endpoint requires the
    # X-API-Key header to match. Empty = auth disabled (local dev).
    API_KEY: str = ""

    # Environment
    DEBUG: bool = False
    ENVIRONMENT: str = "development"

    # CORS
    BACKEND_CORS_ORIGINS: str = "http://localhost:3060,http://localhost:8065"

    @property
    def cors_origins_list(self) -> List[str]:
        return [origin.strip() for origin in self.BACKEND_CORS_ORIGINS.split(",")]

    # Logging
    LOG_LEVEL: str = "INFO"

    # DB pool
    DB_POOL_SIZE: int = 5
    DB_MAX_OVERFLOW: int = 10
    DB_POOL_TIMEOUT: int = 30

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
