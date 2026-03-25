"""Document ingestion pipeline for Agent Miles.

Reads PDFs, .docx, and .txt files from a folder, splits them into chunks,
generates embeddings, and stores everything in ChromaDB.
"""

from __future__ import annotations

import os
import glob
import hashlib
from datetime import datetime, timezone
from typing import Optional

import chromadb
from langchain_text_splitters import RecursiveCharacterTextSplitter

import config
from embeddings import get_embedding_function


def _load_pdf(filepath: str) -> list[dict]:
    """Load a PDF and return a list of {text, metadata} dicts per page."""
    from langchain_community.document_loaders import PyPDFLoader
    loader = PyPDFLoader(filepath)
    pages = loader.load()
    return [
        {
            "text": page.page_content,
            "metadata": {
                "source": os.path.basename(filepath),
                "page": page.metadata.get("page", 0) + 1,  # 1-indexed
            },
        }
        for page in pages
        if page.page_content.strip()
    ]


def _load_docx(filepath: str) -> list[dict]:
    """Load a .docx file and return its content."""
    from langchain_community.document_loaders import Docx2txtLoader
    loader = Docx2txtLoader(filepath)
    docs = loader.load()
    return [
        {
            "text": doc.page_content,
            "metadata": {
                "source": os.path.basename(filepath),
                "page": 1,
            },
        }
        for doc in docs
        if doc.page_content.strip()
    ]


def _load_txt(filepath: str) -> list[dict]:
    """Load a plain text or markdown file."""
    with open(filepath, "r", encoding="utf-8") as f:
        text = f.read()
    if not text.strip():
        return []
    return [
        {
            "text": text,
            "metadata": {
                "source": os.path.basename(filepath),
                "page": 1,
            },
        }
    ]


LOADERS = {
    ".pdf": _load_pdf,
    ".docx": _load_docx,
    ".txt": _load_txt,
    ".md": _load_txt,
}


def load_documents(directory: str) -> list[dict]:
    """Load all supported documents from the given directory."""
    documents = []
    for ext, loader_fn in LOADERS.items():
        for filepath in glob.glob(os.path.join(directory, f"*{ext}")):
            print(f"  Loading {os.path.basename(filepath)}...")
            try:
                docs = loader_fn(filepath)
                documents.extend(docs)
            except Exception as e:
                print(f"  Error loading {filepath}: {e}")
    return documents


def chunk_documents(documents: list[dict]) -> list[dict]:
    """Split documents into smaller chunks with metadata preserved."""
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=config.CHUNK_SIZE,
        chunk_overlap=config.CHUNK_OVERLAP,
        length_function=len,
        separators=["\n\n", "\n", ". ", " ", ""],
    )

    chunks = []
    for doc in documents:
        splits = splitter.split_text(doc["text"])
        for i, split_text in enumerate(splits):
            chunk_id = hashlib.md5(
                f"{doc['metadata']['source']}:{doc['metadata']['page']}:{i}".encode()
            ).hexdigest()
            chunks.append(
                {
                    "id": chunk_id,
                    "text": split_text,
                    "metadata": {
                        **doc["metadata"],
                        "chunk_index": i,
                        "ingested_at": datetime.now(timezone.utc).isoformat(),
                    },
                }
            )
    return chunks


def store_chunks(chunks: list[dict]) -> chromadb.Collection:
    """Embed and store chunks in ChromaDB."""
    client = chromadb.PersistentClient(path=config.CHROMA_PERSIST_DIR)
    embedding_fn = get_embedding_function()

    # Delete existing collection if present, then recreate
    try:
        client.delete_collection(config.COLLECTION_NAME)
    except (ValueError, Exception):
        pass

    collection = client.create_collection(
        name=config.COLLECTION_NAME,
        embedding_function=embedding_fn,
        metadata={"hnsw:space": "cosine"},
    )

    # Insert in batches of 100
    batch_size = 100
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i : i + batch_size]
        collection.add(
            ids=[c["id"] for c in batch],
            documents=[c["text"] for c in batch],
            metadatas=[c["metadata"] for c in batch],
        )
        print(f"  Stored batch {i // batch_size + 1}/{(len(chunks) - 1) // batch_size + 1}")

    return collection


def ingest(directory: str | None = None) -> dict:
    """Run the full ingestion pipeline. Returns summary stats."""
    directory = directory or config.DOCUMENTS_DIR
    print(f"Starting ingestion from: {directory}")

    # Load
    documents = load_documents(directory)
    if not documents:
        print("No documents found.")
        return {"documents_processed": 0, "chunks_created": 0}

    # Get unique source filenames
    source_files = set(doc["metadata"]["source"] for doc in documents)
    print(f"Loaded {len(documents)} document sections from {len(source_files)} files.")

    # Chunk
    chunks = chunk_documents(documents)
    print(f"Created {len(chunks)} chunks.")

    # Store
    store_chunks(chunks)
    print("Ingestion complete.")

    return {
        "documents_processed": len(source_files),
        "chunks_created": len(chunks),
        "sources": sorted(source_files),
    }


if __name__ == "__main__":
    result = ingest()
    print(f"\nSummary: {result['documents_processed']} documents processed, {result['chunks_created']} chunks created.")
