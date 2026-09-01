import json
import redis.asyncio as redis
from app.core.config import settings

class SessionStore:
    def __init__(self):
        # Defaults to localhost for local testing if redis_url isn't in .env
        self.redis = redis.from_url(
            settings.redis_url or "redis://localhost:6379", 
            decode_responses=True
        )
        self.ttl = 3600 # 1 hour session expiration

    async def get_history(self, session_id: str) -> list[str]:
        data = await self.redis.get(f"session:{session_id}:history")
        return json.loads(data) if data else []

    async def append_history(self, session_id: str, action_desc: str) -> list[str]:
        history = await self.get_history(session_id)
        history.append(action_desc)
        
        # Truncate to the last 10 actions to prevent prompt bloat and latency spikes
        history = history[-10:]
        
        await self.redis.setex(
            f"session:{session_id}:history", 
            self.ttl, 
            json.dumps(history)
        )
        return history