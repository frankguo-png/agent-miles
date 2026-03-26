"""FastAPI app for Agent Miles — Transfer Pricing Research Chatbot."""

from __future__ import annotations

import json
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest
from pydantic import BaseModel
import chromadb

import config
from ingest import ingest
from query import ask, ask_stream, invalidate_cache
from embeddings import get_embedding_function

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(
    title="Agent Miles",
    description="Transfer pricing research chatbot with RAG-powered, citation-backed answers.",
    version="0.1.0",
)

# CORS — allow portal frontend to call our API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Allow embedding in iframes (remove X-Frame-Options restriction)
class AllowIframeMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        response = await call_next(request)
        response.headers["X-Frame-Options"] = "ALLOWALL"
        response.headers["Content-Security-Policy"] = "frame-ancestors *"
        return response


app.add_middleware(AllowIframeMiddleware)

# Serve static files
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


class HistoryMessage(BaseModel):
    role: str
    text: str


class QueryRequest(BaseModel):
    question: str
    history: Optional[list[HistoryMessage]] = None


class SourceResponse(BaseModel):
    filename: str
    page: int
    excerpt: str


class QueryResponse(BaseModel):
    answer: str
    sources: list[SourceResponse]


class IngestResponse(BaseModel):
    documents_processed: int
    chunks_created: int
    sources: list[str]


class DocumentInfo(BaseModel):
    filename: str
    chunk_count: int
    ingested_at: str


@app.get("/")
def root(embed: str = ""):
    if embed == "true":
        # Rewrite all asset/API paths to go through the /miles/ proxy
        html = (BASE_DIR / "static" / "index.html").read_text()
        html = html.replace('href="/static/', 'href="/miles/static/')
        html = html.replace('src="/static/', 'src="/miles/static/')
        html = html.replace("fetch('/", "fetch('/miles/")
        html = html.replace("fetch(`/", "fetch(`/miles/")
        return Response(content=html, media_type="text/html")
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/health")
def health():
    return {"status": "ok", "service": "agent-miles"}


@app.post("/ingest", response_model=IngestResponse)
def ingest_documents():
    """Trigger ingestion of documents from the configured folder."""
    try:
        result = ingest()
        invalidate_cache()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return result


@app.post("/upload")
async def upload_documents(files: list[UploadFile] = File(...)):
    """Upload files to the documents folder and ingest them."""
    allowed_exts = {".pdf", ".docx", ".txt", ".md"}
    docs_dir = Path(config.DOCUMENTS_DIR)
    docs_dir.mkdir(parents=True, exist_ok=True)

    saved = []
    for f in files:
        ext = Path(f.filename).suffix.lower()
        if ext not in allowed_exts:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type '{ext}'. Allowed: {', '.join(allowed_exts)}",
            )
        dest = docs_dir / f.filename
        content = await f.read()
        dest.write_bytes(content)
        saved.append(f.filename)

    # Auto-ingest after upload
    try:
        result = ingest()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"uploaded": saved, **result}


@app.post("/query", response_model=QueryResponse)
def query_documents(req: QueryRequest):
    """Ask a question and get a citation-backed answer (non-streaming)."""
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty.")
    try:
        result = ask(req.question)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return result


@app.post("/query/stream")
def query_documents_stream(req: QueryRequest):
    """Stream an answer as Server-Sent Events for real-time display."""
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty.")
    history = None
    if req.history:
        history = [{"role": m.role, "text": m.text} for m in req.history]
    return StreamingResponse(
        ask_stream(req.question, history=history),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/documents", response_model=list[DocumentInfo])
def list_documents():
    """List all ingested documents with metadata."""
    try:
        client = chromadb.PersistentClient(path=config.CHROMA_PERSIST_DIR)
        embedding_fn = get_embedding_function()
        collection = client.get_collection(
            name=config.COLLECTION_NAME,
            embedding_function=embedding_fn,
        )
    except Exception:
        return []

    # Get all metadata to build per-document summary
    all_data = collection.get(include=["metadatas"])
    doc_map: dict[str, dict] = {}
    for meta in all_data["metadatas"]:
        filename = meta.get("source", "unknown")
        if filename not in doc_map:
            doc_map[filename] = {
                "filename": filename,
                "chunk_count": 0,
                "ingested_at": meta.get("ingested_at", "unknown"),
            }
        doc_map[filename]["chunk_count"] += 1

    return sorted(doc_map.values(), key=lambda d: d["filename"])


@app.get("/documents/{filename}/preview")
def preview_document(filename: str):
    """Return preview data for a document.

    - PDFs: returns {"type": "pdf", "pages": 5} (use /preview/page/{n} for images)
    - Text files: returns {"type": "text", "content": "first ~3000 chars"}
    """
    doc_path = Path(config.DOCUMENTS_DIR) / filename
    if not doc_path.exists():
        raise HTTPException(status_code=404, detail=f"File '{filename}' not found.")

    ext = doc_path.suffix.lower()
    if ext == ".pdf":
        # Count total pages via pdfinfo
        try:
            result = subprocess.run(
                ["pdfinfo", str(doc_path)],
                capture_output=True, text=True, timeout=10,
            )
            total_pages = 1
            for line in result.stdout.splitlines():
                if line.startswith("Pages:"):
                    total_pages = int(line.split(":")[1].strip())
                    break
        except Exception:
            total_pages = 5
        return {"type": "pdf", "pages": min(total_pages, 5), "total_pages": total_pages}

    else:
        # Text-based files: return first ~3000 characters
        try:
            text = doc_path.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
        preview_text = text[:3000]
        if len(text) > 3000:
            preview_text += "\n\n... (truncated)"
        return {"type": "text", "content": preview_text, "total_chars": len(text)}


@app.get("/documents/{filename}/preview/page/{page_num}")
def preview_pdf_page(filename: str, page_num: int):
    """Render a single PDF page as a JPEG image."""
    doc_path = Path(config.DOCUMENTS_DIR) / filename
    if not doc_path.exists():
        raise HTTPException(status_code=404, detail=f"File '{filename}' not found.")
    if doc_path.suffix.lower() != ".pdf":
        raise HTTPException(status_code=400, detail="Not a PDF file.")
    if page_num < 1:
        raise HTTPException(status_code=400, detail="Page must be >= 1.")

    with tempfile.TemporaryDirectory() as tmpdir:
        out_prefix = Path(tmpdir) / "page"
        try:
            subprocess.run(
                [
                    "pdftoppm", "-jpeg", "-r", "150",
                    "-f", str(page_num), "-l", str(page_num),
                    str(doc_path), str(out_prefix),
                ],
                capture_output=True, timeout=15, check=True,
            )
        except subprocess.CalledProcessError as e:
            raise HTTPException(status_code=500, detail=f"PDF render failed: {e.stderr.decode()}")

        # pdftoppm outputs page-NN.jpg
        rendered = list(Path(tmpdir).glob("*.jpg"))
        if not rendered:
            raise HTTPException(status_code=500, detail="No rendered output.")

        image_bytes = rendered[0].read_bytes()
        return Response(content=image_bytes, media_type="image/jpeg")


@app.delete("/documents")
def clear_documents():
    """Clear the vector store to allow re-ingestion."""
    client = chromadb.PersistentClient(path=config.CHROMA_PERSIST_DIR)
    try:
        client.delete_collection(config.COLLECTION_NAME)
    except ValueError:
        pass
    invalidate_cache()
    return {"status": "cleared"}


@app.delete("/documents/{filename}")
def delete_document(filename: str):
    """Delete a single document: remove the file and its chunks from the vector store."""
    doc_path = Path(config.DOCUMENTS_DIR) / filename
    if not doc_path.exists():
        raise HTTPException(status_code=404, detail=f"File '{filename}' not found.")

    # Remove chunks from ChromaDB
    client = chromadb.PersistentClient(path=config.CHROMA_PERSIST_DIR)
    try:
        embedding_fn = get_embedding_function()
        collection = client.get_collection(
            name=config.COLLECTION_NAME,
            embedding_function=embedding_fn,
        )
        # Find all chunk IDs for this document
        all_data = collection.get(include=["metadatas"])
        ids_to_delete = [
            cid for cid, meta in zip(all_data["ids"], all_data["metadatas"])
            if meta.get("source") == filename
        ]
        if ids_to_delete:
            collection.delete(ids=ids_to_delete)
    except ValueError:
        pass  # Collection doesn't exist yet

    # Remove the file
    doc_path.unlink()
    invalidate_cache()
    return {"status": "deleted", "filename": filename, "chunks_removed": len(ids_to_delete) if 'ids_to_delete' in dir() else 0}


# ── Chat History ──

CHATS_DIR = BASE_DIR / "chats"
CHATS_DIR.mkdir(exist_ok=True)


def _chat_path(chat_id: str) -> Path:
    return CHATS_DIR / f"{chat_id}.json"


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    text: str
    sources: Optional[list] = None


class SaveChatRequest(BaseModel):
    title: Optional[str] = None
    messages: list[ChatMessage]


@app.post("/chats")
def create_chat():
    """Create a new empty chat."""
    chat_id = str(uuid.uuid4())[:8]
    now = datetime.now(timezone.utc).isoformat()
    data = {"id": chat_id, "title": "New chat", "created_at": now, "updated_at": now, "messages": []}
    _chat_path(chat_id).write_text(json.dumps(data))
    return {"id": chat_id, "title": data["title"], "created_at": now}


@app.get("/chats")
def list_chats():
    """List all chats sorted by most recent."""
    chats = []
    for f in CHATS_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text())
            chats.append({
                "id": data["id"],
                "title": data.get("title", "Untitled"),
                "created_at": data.get("created_at", ""),
                "updated_at": data.get("updated_at", ""),
            })
        except (json.JSONDecodeError, KeyError):
            continue
    chats.sort(key=lambda c: c["updated_at"], reverse=True)
    return chats


@app.get("/chats/{chat_id}")
def get_chat(chat_id: str):
    """Load a chat's messages."""
    path = _chat_path(chat_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Chat not found.")
    return json.loads(path.read_text())


@app.put("/chats/{chat_id}")
def save_chat(chat_id: str, req: SaveChatRequest):
    """Save messages to an existing chat."""
    path = _chat_path(chat_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Chat not found.")

    data = json.loads(path.read_text())
    data["messages"] = [m.dict() for m in req.messages]
    data["updated_at"] = datetime.now(timezone.utc).isoformat()

    if req.title:
        data["title"] = req.title

    path.write_text(json.dumps(data))
    return {"status": "saved", "title": data["title"]}


class TitleRequest(BaseModel):
    question: str
    answer: str


@app.post("/chats/{chat_id}/title")
def generate_chat_title(chat_id: str, req: TitleRequest):
    """Use Claude to generate a short chat title from the first Q&A."""
    import anthropic

    path = _chat_path(chat_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Chat not found.")

    try:
        client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
        resp = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=30,
            messages=[{
                "role": "user",
                "content": f"Generate a very short title (3-6 words max, no quotes) for a chat that starts with this question and answer:\n\nQ: {req.question[:200]}\nA: {req.answer[:300]}\n\nTitle:",
            }],
        )
        title = resp.content[0].text.strip().strip('"').strip("'")[:60]
    except Exception:
        # Fallback: truncate the question
        title = req.question[:50] + ("..." if len(req.question) > 50 else "")

    data = json.loads(path.read_text())
    data["title"] = title
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(data))
    return {"title": title}


@app.delete("/chats/{chat_id}")
def delete_chat(chat_id: str):
    """Delete a chat."""
    path = _chat_path(chat_id)
    if path.exists():
        path.unlink()
    return {"status": "deleted"}
