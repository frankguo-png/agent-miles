# Agent Miles — Transfer Pricing Research Chatbot

A RAG (Retrieval-Augmented Generation) chatbot that lets transfer pricing professionals ask natural language questions and get instant, citation-backed answers from a corpus of tax documents.

## Setup

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and add your API keys:

- `ANTHROPIC_API_KEY` — **Required** for answer generation (Claude)
- `OPENAI_API_KEY` — Optional for embeddings (falls back to local sentence-transformers model if not set)

### 3. Add documents

Place your PDF, .docx, or .txt files in the `./documents/` folder. Sample documents are included for testing.

### 4. Run the server

```bash
uvicorn main:app --reload
```

The API will be available at `http://localhost:8000`.

## API Endpoints

### `GET /health`
Health check.

### `POST /ingest`
Triggers ingestion of all documents in `./documents/`. Returns count of documents and chunks processed.

```bash
curl -X POST http://localhost:8000/ingest
```

### `POST /query`
Ask a question and get a citation-backed answer.

```bash
curl -X POST http://localhost:8000/query \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the arm'\''s length principle?"}'
```

### `GET /documents`
List all ingested documents with metadata.

### `DELETE /documents`
Clear the vector store to allow re-ingestion.

## Standalone Usage

You can also use the ingestion and query modules directly:

```bash
# Ingest documents
python ingest.py

# Query (import in Python)
from query import ask
result = ask("What transfer pricing methods are available?")
print(result["answer"])
```

## Project Structure

```
agent-miles/
├── main.py              # FastAPI app
├── ingest.py            # Document ingestion pipeline
├── query.py             # RAG query engine
├── embeddings.py        # Embedding function factory
├── config.py            # Configuration (env vars)
├── prompts.py           # System prompts for Claude
├── requirements.txt
├── .env.example
├── documents/           # Drop documents here for ingestion
└── README.md
```
