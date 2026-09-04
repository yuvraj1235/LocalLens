import logging
import json
import redis.asyncio as redis
from app.core.config import settings

logger = logging.getLogger("agent")


class SessionStore:
    def __init__(self):
        redis_url = settings.redis_url if settings.redis_url else "redis://localhost:6379"
        self._redis_url = redis_url
        self.ttl = 3600  # 1 hour session expiration
        
        try:
            self.redis = redis.from_url(
                self._redis_url, 
                decode_responses=True
            )
        except Exception as e:
            logger.error("Failed to initialize Redis client with URL %s: %s", self._redis_url, e)
            self.redis = None

    async def close(self) -> None:
        """Close the underlying Redis connection pool."""
        if self.redis:
            await self.redis.aclose()

    async def get_history(self, session_id: str) -> list[str]:
        if not self.redis:
            return []
        
        key = f"session:{session_id}:history"
        try:
            history = await self.redis.lrange(key, 0, -1)
            return history or []
        except Exception as e:
            logger.exception("Error fetching session history for %s from Redis: %s", session_id, e)
            return []

    async def append_history(self, session_id: str, action_desc: str) -> list[str]:
        if not self.redis:
            return [action_desc]

        key = f"session:{session_id}:history"
        try:
            async with self.redis.pipeline(transaction=True) as pipe:
                pipe.rpush(key, action_desc)
                pipe.ltrim(key, -10, -1)
                pipe.expire(key, self.ttl)
                pipe.lrange(key, 0, -1)
                
                results = await pipe.execute()
                
            return results[3] if len(results) >= 4 else []
        except Exception as e:
            logger.exception("Error appending action to session history for %s in Redis: %s", session_id, e)
            return []