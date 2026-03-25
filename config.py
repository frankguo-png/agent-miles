import os
from pathlib import Path
from dotenv import load_dotenv

_base_dir = Path(__file__).resolve().parent
load_dotenv(_base_dir / ".env.local", override=True)
load_dotenv(_base_dir / ".env")  # Fallback (won't override values already set)

# API Keys
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# Paths
CHROMA_PERSIST_DIR = os.getenv("CHROMA_PERSIST_DIR", "./chroma_db")
DOCUMENTS_DIR = os.getenv("DOCUMENTS_DIR", "./documents")

# Chunking
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "600"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "100"))

# Retrieval
TOP_K_RESULTS = int(os.getenv("TOP_K_RESULTS", "5"))

# Models
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514")
EMBEDDING_MODEL = "text-embedding-3-small"

# ChromaDB collection name
COLLECTION_NAME = "transfer_pricing_docs"
