"""RAG query engine for Agent Miles.

Embeds a user question, retrieves relevant chunks from ChromaDB,
and sends them to Claude for answer generation with citations.

Optimised for speed:
- Embedding model and ChromaDB collection are cached after first use
- Streaming generator for real-time token delivery
"""

from __future__ import annotations

import json
import time
from typing import Generator, Optional

import anthropic
import chromadb

import config
from prompts import SYSTEM_PROMPT, QUERY_TEMPLATE
from embeddings import get_embedding_function

# ── Cached singletons (loaded once, reused across requests) ──
_embedding_fn = None
_chroma_client = None
_anthropic_client = None


def _get_embedding_fn():
    global _embedding_fn
    if _embedding_fn is None:
        _embedding_fn = get_embedding_function()
    return _embedding_fn


def _get_chroma_client():
    global _chroma_client
    if _chroma_client is None:
        _chroma_client = chromadb.PersistentClient(path=config.CHROMA_PERSIST_DIR)
    return _chroma_client


def _get_anthropic_client():
    global _anthropic_client
    if _anthropic_client is None:
        _anthropic_client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    return _anthropic_client


def invalidate_cache():
    """Call after ingestion or document clearing to refresh the collection."""
    global _chroma_client
    _chroma_client = None


def retrieve(question: str, top_k: int | None = None) -> list[dict]:
    """Retrieve the top-k most relevant chunks for a question."""
    top_k = top_k or config.TOP_K_RESULTS

    client = _get_chroma_client()
    embedding_fn = _get_embedding_fn()

    try:
        collection = client.get_collection(
            name=config.COLLECTION_NAME,
            embedding_function=embedding_fn,
        )
    except ValueError:
        return []

    results = collection.query(
        query_texts=[question],
        n_results=min(top_k, collection.count()),
        include=["documents", "metadatas", "distances"],
    )

    chunks = []
    for i in range(len(results["ids"][0])):
        chunks.append(
            {
                "id": results["ids"][0][i],
                "text": results["documents"][0][i],
                "metadata": results["metadatas"][0][i],
                "distance": results["distances"][0][i],
            }
        )
    return chunks


def build_context(chunks: list[dict]) -> str:
    """Format retrieved chunks into a context string for the LLM."""
    parts = []
    for i, chunk in enumerate(chunks, 1):
        source = chunk["metadata"].get("source", "unknown")
        page = chunk["metadata"].get("page", "?")
        parts.append(f"[Document {i}] Source: {source}, Page {page}\n{chunk['text']}\n")
    return "\n".join(parts)


def _build_sources(chunks: list[dict]) -> list[dict]:
    """Build the source list from retrieved chunks."""
    return [
        {
            "filename": chunk["metadata"].get("source", "unknown"),
            "page": chunk["metadata"].get("page", 0),
            "excerpt": chunk["text"][:200] + "..." if len(chunk["text"]) > 200 else chunk["text"],
        }
        for chunk in chunks
    ]


def _build_messages(user_message: str, history: Optional[list[dict]] = None) -> list[dict]:
    """Build the messages list for Claude, including conversation history."""
    messages = []
    if history:
        # Include up to last 6 messages (3 turns) for context
        recent = history[-6:]
        for msg in recent:
            role = "user" if msg["role"] == "user" else "assistant"
            messages.append({"role": role, "content": msg["text"]})
    messages.append({"role": "user", "content": user_message})
    return messages


def ask_stream(question: str, history: Optional[list[dict]] = None) -> Generator[str, None, None]:
    """Stream the RAG answer as Server-Sent Events (SSE).

    Yields SSE-formatted lines:
      data: {"type": "sources", "sources": [...]}
      data: {"type": "token", "text": "..."}
      data: {"type": "done"}
    """
    if not config.ANTHROPIC_API_KEY:
        yield f"data: {json.dumps({'type': 'error', 'message': 'ANTHROPIC_API_KEY is required.'})}\n\n"
        return

    # Retrieve relevant chunks
    chunks = retrieve(question)
    if not chunks:
        yield f"data: {json.dumps({'type': 'error', 'message': 'No documents ingested yet. Please add documents first.'})}\n\n"
        return

    # Send sources immediately so the UI can show them right away
    sources = _build_sources(chunks)
    yield f"data: {json.dumps({'type': 'sources', 'sources': sources})}\n\n"

    # Build context and prompt
    context = build_context(chunks)
    user_message = QUERY_TEMPLATE.format(context=context, question=question)

    # Build messages with conversation history for follow-up context
    messages = _build_messages(user_message, history)

    # Stream from Claude
    client = _get_anthropic_client()
    last_err: Optional[Exception] = None

    for attempt in range(3):
        try:
            with client.messages.stream(
                model=config.CLAUDE_MODEL,
                max_tokens=2048,
                system=SYSTEM_PROMPT,
                messages=messages,
            ) as stream:
                for text in stream.text_stream:
                    yield f"data: {json.dumps({'type': 'token', 'text': text})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            return
        except anthropic.APIStatusError as e:
            last_err = e
            if e.status_code in (429, 529) and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            yield f"data: {json.dumps({'type': 'error', 'message': f'Claude API error ({e.status_code})'})}\n\n"
            return
        except anthropic.APIConnectionError:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Cannot connect to Anthropic API.'})}\n\n"
            return

    yield f"data: {json.dumps({'type': 'error', 'message': f'Claude API unavailable after 3 retries.'})}\n\n"


def ask(question: str) -> dict:
    """Non-streaming version (kept for backward compatibility)."""
    if not config.ANTHROPIC_API_KEY:
        raise ValueError("ANTHROPIC_API_KEY is required for answer generation.")

    chunks = retrieve(question)
    if not chunks:
        return {
            "answer": "No documents have been ingested yet. Please add documents first.",
            "sources": [],
        }

    context = build_context(chunks)
    user_message = QUERY_TEMPLATE.format(context=context, question=question)

    client = _get_anthropic_client()
    last_err: Optional[Exception] = None
    for attempt in range(3):
        try:
            response = client.messages.create(
                model=config.CLAUDE_MODEL,
                max_tokens=2048,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
            )
            answer = response.content[0].text
            break
        except anthropic.APIStatusError as e:
            last_err = e
            if e.status_code in (429, 529) and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            raise ValueError(f"Claude API error ({e.status_code}): {e.message}")
        except anthropic.APIConnectionError:
            raise ValueError("Could not connect to the Anthropic API. Check your network.")
    else:
        raise ValueError(f"Claude API unavailable after 3 retries: {last_err}")

    return {"answer": answer, "sources": _build_sources(chunks)}
