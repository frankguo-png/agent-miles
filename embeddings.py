"""Embedding function factory for Agent Miles.

Uses OpenAI text-embedding-3-small if an API key is available,
otherwise falls back to a local sentence-transformers model.
"""

import config


def get_embedding_function():
    """Return a ChromaDB-compatible embedding function."""
    if config.OPENAI_API_KEY:
        from chromadb.utils.embedding_functions import OpenAIEmbeddingFunction
        return OpenAIEmbeddingFunction(
            api_key=config.OPENAI_API_KEY,
            model_name=config.EMBEDDING_MODEL,
        )

    # Fallback: free local model
    from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
    print("No OpenAI API key found — using local sentence-transformers model.")
    return SentenceTransformerEmbeddingFunction(model_name="all-MiniLM-L6-v2")
