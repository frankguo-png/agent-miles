#!/bin/bash
cd /Users/fguoamp/Downloads/agent-miles
export PYTHONDONTWRITEBYTECODE=1
exec python3 -c "
import uvicorn
uvicorn.run('main:app', host='0.0.0.0', port=8001, loop='asyncio', http='h11')
"
