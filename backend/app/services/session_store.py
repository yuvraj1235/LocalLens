import logging
from collections import defaultdict
from app.core.config import settings

logger = logging.getLogger("agent")

# In-memory fallback store (used when Redis is unavailable)
_memory_store: dict[str, list[str]] = defaultdict(list)


class SessionStore:
    def __init__(self):
        self._use_redis = False
        if settings.redis_url:
            try:
                import redis.asyncio as redis
                self._redis = redis.from_url(settings.redis_url, decode_responses=True)
                self._use_redis = True
                self.ttl = 3600
            except Exception as e:
                logger.warning("Redis unavailable (%s), falling back to in-memory store.", e)
        else:
            logger.info("No REDIS_URL configured — using in-memory session store.")

    async def close(self) -> None:
        if self._use_redis:
            await self._redis.aclose()

    async def get_history(self, session_id: str) -> list[str]:
        if self._use_redis:
            try:
                return await self._redis.lrange(f"session:{session_id}:history", 0, -1) or []
            except Exception:
                logger.warning("Redis read failed, falling back to memory for session %s", session_id)

        return list(_memory_store.get(session_id, []))

    async def append_history(self, session_id: str, action_desc: str) -> list[str]:
        if self._use_redis:
            try:
                key = f"session:{session_id}:history"
                async with self._redis.pipeline(transaction=True) as pipe:
                    pipe.rpush(key, action_desc)
                    pipe.ltrim(key, -10, -1)
                    pipe.expire(key, self.ttl)
                    pipe.lrange(key, 0, -1)
                    results = await pipe.execute()
                return results[3] if len(results) >= 4 else []
            except Exception:
                logger.warning("Redis write failed, falling back to memory for session %s", session_id)

        # In-memory path
        history = _memory_store[session_id]
        history.append(action_desc)
        _memory_store[session_id] = history[-10:]  # keep last 10 actions
        return list(_memory_store[session_id])