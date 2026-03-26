// ── Base path (detects /miles/ proxy for portal embedding) ──
const BASE = window.location.pathname.startsWith('/miles') ? '/miles' : '';

// ── State ──
let allDocuments = [];
let currentChatId = null;
let chatMessages_data = []; // {role, text, sources} for persistence

// ── Navigation ──
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const page = btn.dataset.page;
    const chatPage = document.getElementById('page-chat');
    const docsPage = document.getElementById('page-documents');
    const sidebar = document.getElementById('sidebar');

    // Fade out current visible page
    const currentVisible = page === 'chat' ? docsPage : chatPage;
    const nextVisible = page === 'chat' ? chatPage : docsPage;

    currentVisible.classList.add('page-fade-out');

    setTimeout(() => {
      currentVisible.classList.add('hidden');
      currentVisible.classList.remove('page-fade-out');
      nextVisible.classList.remove('hidden');
      nextVisible.classList.add('page-fade-out');
      // Force reflow
      nextVisible.offsetHeight;
      nextVisible.classList.remove('page-fade-out');

      sidebar.classList.toggle('hidden', page !== 'chat');

      if (page === 'documents') loadDocuments();
    }, 150);
  });
});

// ── Chat ──
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const chatSend = document.getElementById('chat-send');

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;
  chatInput.style.height = 'auto';
  await sendQuestion(question);
});

function askSample(btn) {
  sendQuestion(btn.dataset.question || btn.textContent.trim());
}

async function sendQuestion(question) {
  // Hide welcome
  const welcome = document.getElementById('chat-welcome');
  if (welcome) welcome.remove();

  // Create chat if not already created (e.g. sample question click without new chat)
  if (!currentChatId) {
    try {
      const res = await fetch(BASE + '/chats', { method: 'POST' });
      const data = await res.json();
      currentChatId = data.id;
      loadSidebar();
    } catch { /* continue without persistence */ }
  }

  // Track message for persistence
  chatMessages_data.push({ role: 'user', text: question, sources: null });

  // Add user message
  appendMessage('user', question);
  chatInput.value = '';
  chatSend.disabled = true;

  // Create the assistant message element for streaming into
  const msgEl = appendStreamingMessage();
  const textEl = msgEl.querySelector('.message-text');
  const contentEl = msgEl.querySelector('.message-content');
  textEl.classList.add('streaming');

  let fullText = '';
  let displayedLen = 0;
  let sources = [];
  let streamDone = false;

  // Smooth character drip with live markdown rendering
  const CHARS_PER_TICK = 3;
  const TICK_MS = 12;
  let firstToken = true;

  const dripInterval = setInterval(() => {
    if (displayedLen >= fullText.length) {
      if (streamDone) {
        clearInterval(dripInterval);
        textEl.classList.remove('streaming');
        textEl.innerHTML = formatText(fullText);
        appendSourceChips(contentEl, sources);
        // Add copy button after streaming completes
        msgEl.dataset.rawText = fullText;
        const actionsHTML = `<div class="message-actions"><button class="action-btn" onclick="copyMessage(this)">Copy</button></div>`;
        contentEl.insertAdjacentHTML('afterbegin', actionsHTML);
        // Add regenerate button after streaming completes
        chatMessages.querySelectorAll('.message.assistant .message-regen').forEach(el => el.remove());
        contentEl.insertAdjacentHTML('beforeend',
          '<div class="message-regen"><button class="action-btn regen-btn" onclick="regenerateResponse()">&#x21bb; Regenerate</button></div>');
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      return;
    }
    if (firstToken) {
      textEl.innerHTML = '';
      firstToken = false;
    }
    const end = Math.min(displayedLen + CHARS_PER_TICK, fullText.length);
    displayedLen = end;
    // Live render markdown on the displayed portion
    textEl.innerHTML = formatTextStreaming(fullText.slice(0, end));
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }, TICK_MS);

  try {
    const res = await fetch(BASE + '/query/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        history: chatMessages_data.slice(0, -1),  // all previous messages (exclude the just-added user msg)
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.detail || 'Query failed');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = JSON.parse(line.slice(6));

        if (data.type === 'sources') {
          sources = data.sources;
        } else if (data.type === 'token') {
          fullText += data.text;
        } else if (data.type === 'error') {
          throw new Error(data.message);
        }
      }
    }

    streamDone = true;

    // Save to chat history (strip trailing Sources Referenced section)
    fullText = stripSourcesSection(fullText);
    chatMessages_data.push({ role: 'assistant', text: fullText, sources });
    saveCurrentChat();

    // AI-generate title after first Q&A exchange
    if (chatMessages_data.length === 2 && currentChatId) {
      generateChatTitle(currentChatId, question, fullText);
    }
  } catch (err) {
    clearInterval(dripInterval);
    textEl.classList.remove('streaming');
    textEl.innerHTML = `Error: ${err.message}`;
    showToast(err.message, 'error');
  } finally {
    chatSend.disabled = false;
    chatInput.focus();
  }
}

function appendSourceChips(contentEl, sources) {
  if (!sources || sources.length === 0) return;
  const seen = new Set();
  const unique = sources.filter(s => {
    const key = `${s.filename}:${s.page}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const chips = unique.map(s => {
    const fn = s.filename.replace(/'/g, "\\'");
    const excerpt = (s.excerpt || '').replace(/'/g, "\\'").replace(/"/g, '&quot;').slice(0, 120);
    return `<span class="source-chip clickable" onclick="openSourcePage('${fn}', ${s.page})" title="${excerpt}"><span class="source-icon">📄</span>${s.filename}${s.page ? `, p.${s.page}` : ''}</span>`;
  }).join('');

  contentEl.insertAdjacentHTML('beforeend', `
    <div class="message-sources" style="animation:fadeIn 0.3s ease">
      <button class="sources-toggle" onclick="this.parentElement.classList.toggle('expanded')">
        <span class="sources-toggle-icon">📎</span>
        ${unique.length} source${unique.length > 1 ? 's' : ''} referenced
        <span class="sources-chevron">▸</span>
      </button>
      <div class="sources-list">
        ${chips}
      </div>
    </div>`);
}

function appendMessage(role, text, sources) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  const avatarLabel = role === 'user' ? 'Y' : `<img src="${BASE}/static/logo.png" alt="M">`;

  // Format text: basic markdown-like rendering
  const formattedText = formatText(text);

  let sourcesHTML = '';
  if (sources && sources.length > 0) {
    // Deduplicate sources by filename+page
    const seen = new Set();
    const unique = sources.filter(s => {
      const key = `${s.filename}:${s.page}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const chips = unique.map(s => {
      const fn = s.filename.replace(/'/g, "\\'");
      const excerpt = (s.excerpt || '').replace(/'/g, "\\'").replace(/"/g, '&quot;').slice(0, 120);
      return `<span class="source-chip clickable" onclick="openSourcePage('${fn}', ${s.page})" title="${excerpt}"><span class="source-icon">📄</span>${s.filename}${s.page ? `, p.${s.page}` : ''}</span>`;
    }).join('');
    sourcesHTML = `
      <div class="message-sources">
        <button class="sources-toggle" onclick="this.parentElement.classList.toggle('expanded')">
          <span class="sources-toggle-icon">📎</span>
          ${unique.length} source${unique.length > 1 ? 's' : ''} referenced
          <span class="sources-chevron">▸</span>
        </button>
        <div class="sources-list">
          ${chips}
        </div>
      </div>`;
  }

  div.innerHTML = `
    <div class="message-avatar">${avatarLabel}</div>
    <div class="message-content">
      <div class="message-text">${formattedText}</div>
      ${sourcesHTML}
    </div>`;

  // Add copy button for assistant messages
  if (role === 'assistant') {
    div.dataset.rawText = text;
    const actionsHTML = `<div class="message-actions"><button class="action-btn" onclick="copyMessage(this)">Copy</button></div>`;
    div.querySelector('.message-content').insertAdjacentHTML('afterbegin', actionsHTML);
    // Add regenerate button (will be shown only on last assistant message)
    div.querySelector('.message-content').insertAdjacentHTML('beforeend',
      '<div class="message-regen"><button class="action-btn regen-btn" onclick="regenerateResponse()">&#x21bb; Regenerate</button></div>');
    // Remove regen button from any previous assistant messages
    chatMessages.querySelectorAll('.message.assistant .message-regen').forEach(el => el.remove());
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function appendStreamingMessage() {
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.innerHTML = `
    <div class="message-avatar"><img src="${BASE}/static/logo.png" alt="M"></div>
    <div class="message-content">
      <div class="message-text"><span class="typing-indicator"><span></span><span></span><span></span></span></div>
    </div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function copyMessage(btn) {
  const msg = btn.closest('.message');
  const text = msg.dataset.rawText || msg.querySelector('.message-text')?.innerText || '';
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '\u2713 Copied';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 2000);
  });
}

function stripSourcesSection(text) {
  // Remove the trailing "Sources Referenced" block the LLM appends
  return text.replace(/\n*(?:\*\*)?Sources\s+Referenced(?:\*\*)?:?\s*\n[\s\S]*$/i, '').trimEnd();
}

function formatText(text) {
  // Strip trailing Sources Referenced section
  text = stripSourcesSection(text);

  // Escape HTML
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Headings: ## Heading → <h4>
  html = html.replace(/^### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^## (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^# (.+)$/gm, '<h3>$1</h3>');

  // Bold: **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Inline citations: [Source: filename, p.N] or [Source: filename, page N] → clickable link
  html = html.replace(/\[Source:\s*([^,\]]+),\s*(?:p\.|page\s*)(\d+)\]/g, (match, filename, page) => {
    const fn = filename.trim().replace(/'/g, "\\'");
    return `<a class="source-link" href="#" onclick="event.preventDefault();openSourcePage('${fn}', ${page})">[Source: ${filename.trim()}, p.${page}]</a>`;
  });
  // Fallback for citations without page
  html = html.replace(/\[Source:\s*([^\]]+)\]/g,
    '<span class="source-link-static">[Source: $1]</span>');

  // List items: - text
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Line breaks → paragraphs (skip heading/list blocks)
  html = html.split('\n\n').map(p => {
    const trimmed = p.trim();
    if (trimmed.startsWith('<h') || trimmed.startsWith('<ul')) return trimmed;
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return html;
}

// Streaming-safe markdown: renders complete markdown tokens,
// leaves incomplete ones as plain text so ** doesn't flash in/out
function formatTextStreaming(text) {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Headings (only complete lines)
  html = html.replace(/^### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^## (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^# (.+)$/gm, '<h3>$1</h3>');

  // Bold: only if both ** pairs are closed
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Hide unclosed ** at end (still being typed)
  html = html.replace(/\*\*([^*]*)$/, '<strong>$1</strong>');

  // Inline citations: [Source: filename, p.N] or [Source: filename, page N]
  html = html.replace(/\[Source:\s*([^,\]]+),\s*(?:p\.|page\s*)(\d+)\]/g, (m, filename, page) => {
    const fn = filename.trim().replace(/'/g, "\\'");
    return `<a class="source-link" href="#" onclick="event.preventDefault();openSourcePage('${fn}', ${page})">[Source: ${filename.trim()}, p.${page}]</a>`;
  });
  html = html.replace(/\[Source:\s*([^\]]+)\]/g,
    '<span class="source-link-static">[Source: $1]</span>');

  // List items
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Paragraphs
  html = html.split('\n\n').map(p => {
    const trimmed = p.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('<h') || trimmed.startsWith('<ul')) return trimmed;
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return html;
}

// ── Documents ──
async function loadDocuments() {
  const list = document.getElementById('docs-list');

  // Show cached data instantly if available (no spinner flash)
  if (allDocuments.length > 0) {
    renderDocuments(allDocuments);
  } else {
    list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  }

  // Fetch fresh data in background
  try {
    const res = await fetch(BASE + '/documents');
    allDocuments = await res.json();
    renderDocuments(allDocuments);
  } catch (err) {
    if (allDocuments.length === 0) {
      list.innerHTML = `<div class="empty-state"><p>Failed to load documents.</p></div>`;
    }
  }
}

function renderDocuments(docs) {
  const list = document.getElementById('docs-list');
  const count = document.getElementById('docs-count');

  count.textContent = `${docs.length} of ${allDocuments.length} documents`;

  if (docs.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <h3>No documents yet</h3>
        <p>Click "+ Add Documents" to get started.</p>
      </div>`;
    return;
  }

  const fileIcon = (ext) => {
    switch(ext) {
      case 'pdf': return '<svg class="doc-icon doc-icon-pdf" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15h6M9 18h4"/></svg>';
      case 'docx': case 'doc': return '<svg class="doc-icon doc-icon-docx" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>';
      default: return '<svg class="doc-icon doc-icon-txt" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    }
  };

  list.innerHTML = docs.map(doc => {
    const ext = doc.filename.split('.').pop().toLowerCase();
    const date = doc.ingested_at && doc.ingested_at !== 'unknown'
      ? new Date(doc.ingested_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    const fn = doc.filename.replace(/'/g, "\\'");
    const chunkLabel = doc.chunk_count === 1 ? '1 chunk' : `${doc.chunk_count.toLocaleString()} chunks`;
    return `
      <div class="doc-row" onclick="openDocPreview('${fn}')">
        <div class="doc-name-cell">
          ${fileIcon(ext)}
          <div>
            <div class="doc-name">${doc.filename}</div>
            <div class="doc-type">${ext.toUpperCase()}</div>
          </div>
        </div>
        <div class="doc-chunks">${chunkLabel}</div>
        <div class="doc-date">${date}</div>
        <div class="doc-status"><div class="status-dot"></div></div>
        <div><button class="doc-delete-btn" onclick="event.stopPropagation();deleteDocument('${fn}')" title="Remove document">×</button></div>
      </div>`;
  }).join('');
}

function filterDocuments() {
  const q = document.getElementById('docs-search').value.toLowerCase();
  const filtered = allDocuments.filter(d => d.filename.toLowerCase().includes(q));
  renderDocuments(filtered);
}

async function uploadFiles(fileList) {
  if (!fileList || fileList.length === 0) return;

  const btn = document.getElementById('btn-upload');
  const label = document.getElementById('upload-label');
  btn.disabled = true;
  label.innerHTML = `<span class="spinner"></span> Uploading ${fileList.length} file${fileList.length > 1 ? 's' : ''}...`;

  const formData = new FormData();
  for (const f of fileList) {
    formData.append('files', f);
  }

  try {
    const res = await fetch(BASE + '/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) throw new Error(data.detail || 'Upload failed');

    showToast(`Added ${data.uploaded.length} file${data.uploaded.length > 1 ? 's' : ''} → ${data.chunks_created} chunks`, 'success');
    loadDocuments();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    label.textContent = '+ Add Documents';
    document.getElementById('file-upload').value = '';
  }
}

async function deleteDocument(filename) {
  if (!confirm(`Remove "${filename}"? The file and its chunks will be deleted.`)) return;

  try {
    const res = await fetch(`${BASE}/documents/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Delete failed');
    }
    showToast(`Removed ${filename}`, 'success');
    loadDocuments();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function clearDocuments() {
  if (!confirm('Clear all ingested documents? This cannot be undone.')) return;

  const btn = document.getElementById('btn-clear');
  btn.disabled = true;

  try {
    await fetch(BASE + '/documents', { method: 'DELETE' });
    showToast('All documents cleared.', 'info');
    allDocuments = [];
    renderDocuments([]);
  } catch (err) {
    showToast('Failed to clear documents.', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── Document Preview Modal ──
async function openDocPreview(filename) {
  const drawer = document.getElementById('doc-preview');
  const overlay = document.getElementById('drawer-overlay');
  const title = document.getElementById('preview-title');
  const meta = document.getElementById('preview-meta');
  const icon = document.getElementById('preview-icon');
  const content = document.getElementById('preview-chunks');

  const ext = filename.split('.').pop().toLowerCase();
  icon.textContent = ext === 'pdf' ? '📕' : '📄';
  title.textContent = filename;
  meta.textContent = 'Loading...';
  content.innerHTML = '<div class="preview-loading"><span class="spinner"></span> Loading preview...</div>';

  // Show modal
  overlay.classList.add('visible');
  drawer.classList.add('open');

  try {
    const res = await fetch(`${BASE}/documents/${encodeURIComponent(filename)}/preview`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Failed to load preview');
    }

    const data = await res.json();

    if (data.type === 'pdf') {
      // Render first N pages as images
      meta.textContent = `PDF \u2022 ${data.total_pages} pages (showing first ${data.pages})`;
      let html = '';
      for (let i = 1; i <= data.pages; i++) {
        html += `
          <div class="preview-page">
            <div class="preview-page-label">Page ${i}</div>
            <img
              class="preview-page-img"
              src="/documents/${encodeURIComponent(filename)}/preview/page/${i}"
              alt="Page ${i}"
              loading="lazy"
            >
          </div>`;
      }
      content.innerHTML = html;

    } else {
      // Text preview
      const charCount = data.total_chars >= 1000
        ? `${(data.total_chars / 1000).toFixed(1)}k chars`
        : `${data.total_chars} chars`;
      meta.textContent = `Text \u2022 ${charCount}`;

      const escapedText = data.content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      content.innerHTML = `<div class="preview-text-content">${escapedText}</div>`;
    }
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
    meta.textContent = 'Error';
  }
}

async function openSourcePage(filename, page) {
  const drawer = document.getElementById('doc-preview');
  const overlay = document.getElementById('drawer-overlay');
  const title = document.getElementById('preview-title');
  const meta = document.getElementById('preview-meta');
  const icon = document.getElementById('preview-icon');
  const content = document.getElementById('preview-chunks');

  const ext = filename.split('.').pop().toLowerCase();
  icon.textContent = ext === 'pdf' ? '📕' : '📄';
  title.textContent = filename;
  meta.textContent = `Page ${page}`;
  content.innerHTML = '<div class="preview-loading"><span class="spinner"></span> Rendering page...</div>';

  // Show modal
  overlay.classList.add('visible');
  drawer.classList.add('open');

  if (ext === 'pdf') {
    content.innerHTML = `
      <div class="preview-page">
        <div class="preview-page-label">Page ${page}</div>
        <img
          class="preview-page-img"
          src="/documents/${encodeURIComponent(filename)}/preview/page/${page}"
          alt="Page ${page}"
          onerror="this.parentElement.innerHTML='<div class=\\'empty-state\\'><p>Failed to render page.</p></div>'"
        >
      </div>`;
  } else {
    // For text files, fetch the preview and show it
    try {
      const res = await fetch(`${BASE}/documents/${encodeURIComponent(filename)}/preview`);
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      const escapedText = data.content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      content.innerHTML = `<div class="preview-text-content">${escapedText}</div>`;
    } catch {
      content.innerHTML = '<div class="empty-state"><p>Failed to load text preview.</p></div>';
    }
  }
}

function closeDocPreview() {
  const drawer = document.getElementById('doc-preview');
  const overlay = document.getElementById('drawer-overlay');

  drawer.classList.remove('open');
  overlay.classList.remove('visible');
}

// Close drawer on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDocPreview();
});

// ── Toasts ──
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-message">${escapeHTML(message)}</span>
    <button class="toast-dismiss" onclick="this.parentElement.remove()">&times;</button>
    <div class="toast-progress"></div>
  `;
  container.appendChild(toast);
  setTimeout(() => { toast.remove(); }, 4000);
}

// ── Keyboard shortcut (textarea: Enter sends, Shift+Enter newline) ──
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event('submit'));
  }
});

// ── Textarea auto-resize ──
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
});

// ── Welcome input handling ──
const welcomeInput = document.getElementById('welcome-input');
if (welcomeInput) {
  welcomeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const q = welcomeInput.value.trim();
      if (!q) return;
      chatInput.value = q;
      welcomeInput.value = '';
      chatForm.dispatchEvent(new Event('submit'));
    }
  });
  welcomeInput.addEventListener('input', () => {
    welcomeInput.style.height = 'auto';
    welcomeInput.style.height = Math.min(welcomeInput.scrollHeight, 160) + 'px';
  });
}

// ── Sidebar toggle ──
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('collapsed');
  localStorage.setItem('sidebarCollapsed', sidebar.classList.contains('collapsed'));
}

// On page load, restore sidebar state
if (localStorage.getItem('sidebarCollapsed') === 'true') {
  document.getElementById('sidebar')?.classList.add('collapsed');
}

// ── Regenerate Response ──
function regenerateResponse() {
  // Find the last user question
  const lastUserIdx = chatMessages_data.map(m => m.role).lastIndexOf('user');
  if (lastUserIdx === -1) return;
  const question = chatMessages_data[lastUserIdx].text;

  // Remove the last assistant message from data
  if (chatMessages_data.length > lastUserIdx + 1 && chatMessages_data[lastUserIdx + 1].role === 'assistant') {
    chatMessages_data.splice(lastUserIdx + 1, 1);
  }
  // Also remove the last user message since sendQuestion will re-add it
  chatMessages_data.splice(lastUserIdx, 1);

  // Remove last two messages from DOM (user + assistant)
  const messages = chatMessages.querySelectorAll('.message');
  if (messages.length >= 2) {
    messages[messages.length - 1].remove();
    messages[messages.length - 2].remove();
  } else if (messages.length >= 1) {
    messages[messages.length - 1].remove();
  }

  // Re-send
  sendQuestion(question);
}

// ── Chat Rename ──
function startRenameChat(chatId, titleEl) {
  const currentTitle = titleEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sidebar-rename-input';
  input.value = currentTitle;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newTitle = input.value.trim() || currentTitle;
    try {
      // Fetch current chat to get messages
      const chatRes = await fetch(`${BASE}/chats/${chatId}`);
      const chatData = await chatRes.json();
      await fetch(`${BASE}/chats/${chatId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle, messages: chatData.messages || [] }),
      });
    } catch {}
    loadSidebar();
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
  });
}

// ── Re-init dot grid after welcome screen is restored ──
function reinitDotGrid() {
  // Destroy old instance if exists
  if (window._dotGrid) {
    window._dotGrid.destroy?.();
    window._dotGrid = null;
  }
  const el = document.getElementById('dot-grid');
  if (el && typeof DotGrid !== 'undefined') {
    window._dotGrid = new DotGrid(el);
  }
  // Re-bind welcome input
  const wi = document.getElementById('welcome-input');
  if (wi) {
    wi.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const q = wi.value.trim();
        if (!q) return;
        chatInput.value = q;
        wi.value = '';
        chatForm.dispatchEvent(new Event('submit'));
      }
    });
    wi.addEventListener('input', () => {
      wi.style.height = 'auto';
      wi.style.height = Math.min(wi.scrollHeight, 160) + 'px';
    });
  }
}

// ── Chat History / Sidebar ──
const welcomeHTML = document.getElementById('chat-welcome')?.outerHTML || '';

async function loadSidebar() {
  const container = document.getElementById('sidebar-chats');
  try {
    const res = await fetch(BASE + '/chats');
    const chats = await res.json();

    if (chats.length === 0) {
      container.innerHTML = '<div class="sidebar-empty">No conversations yet</div>';
      return;
    }

    container.innerHTML = chats.map(c => {
      const isActive = c.id === currentChatId;
      const titleClass = c.title === 'New chat' ? 'sidebar-chat-title unnamed' : 'sidebar-chat-title';
      return `
        <div class="sidebar-chat-item ${isActive ? 'active' : ''}" onclick="openChat('${c.id}')">
          <span class="${titleClass}" ondblclick="event.stopPropagation();startRenameChat('${c.id}', this)">${escapeHTML(c.title)}</span>
          <button class="sidebar-chat-delete" onclick="event.stopPropagation();deleteChat('${c.id}')" title="Delete">×</button>
        </div>`;
    }).join('');
  } catch {
    container.innerHTML = '<div class="sidebar-empty">Failed to load</div>';
  }
}

function escapeHTML(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function newChat() {
  // Just reset — don't create a chat until first message is sent
  chatMessages_data = [];
  currentChatId = null;

  // Reset to welcome screen
  chatMessages.innerHTML = welcomeHTML;
  reinitDotGrid();

  // Switch to chat page if on documents
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-page="chat"]').classList.add('active');
  document.getElementById('page-chat').classList.remove('hidden');
  document.getElementById('page-documents').classList.add('hidden');
  document.getElementById('sidebar').classList.remove('hidden');
}

async function openChat(id) {
  try {
    const res = await fetch(`${BASE}/chats/${id}`);
    if (!res.ok) throw new Error('Chat not found');
    const data = await res.json();

    currentChatId = id;
    chatMessages_data = data.messages || [];

    // Switch to chat page
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-page="chat"]').classList.add('active');
    document.getElementById('page-chat').classList.remove('hidden');
    document.getElementById('page-documents').classList.add('hidden');
    document.getElementById('sidebar').classList.remove('hidden');

    // Clear and re-render messages
    if (chatMessages_data.length === 0) {
      chatMessages.innerHTML = welcomeHTML;
  reinitDotGrid();
    } else {
      chatMessages.innerHTML = '';
      for (const msg of chatMessages_data) {
        appendMessage(msg.role, msg.text, msg.sources);
      }
    }

    // Update sidebar active state
    document.querySelectorAll('.sidebar-chat-item').forEach(el => el.classList.remove('active'));
    const activeEl = document.querySelector(`.sidebar-chat-item[onclick*="${id}"]`);
    if (activeEl) activeEl.classList.add('active');
  } catch (err) {
    showToast('Failed to load chat', 'error');
  }
}

async function saveCurrentChat() {
  if (!currentChatId) return;
  try {
    await fetch(`${BASE}/chats/${currentChatId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatMessages_data }),
    });
    loadSidebar();
  } catch { /* silent fail */ }
}

async function generateChatTitle(chatId, question, answer) {
  try {
    const res = await fetch(`${BASE}/chats/${chatId}/title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, answer }),
    });
    if (res.ok) loadSidebar();
  } catch { /* silent fail — title stays as fallback */ }
}

async function deleteChat(id) {
  try {
    await fetch(`${BASE}/chats/${id}`, { method: 'DELETE' });
    if (currentChatId === id) {
      currentChatId = null;
      chatMessages_data = [];
      chatMessages.innerHTML = welcomeHTML;
  reinitDotGrid();
    }
    loadSidebar();
  } catch {
    showToast('Failed to delete chat', 'error');
  }
}

// Load sidebar on page load
loadSidebar();
