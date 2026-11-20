/* global window, document */

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function setHidden(el, hidden) {
  if (hidden) el.classList.add('hidden');
  else el.classList.remove('hidden');
}

function formatRelativeTime(ms) {
  const now = Date.now();
  const diffMs = Math.max(0, now - ms);
  const mins = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function safeText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function renderEmpty(listEl, message) {
  listEl.innerHTML = `<div class="empty">${message}</div>`;
}

function renderList(listEl, items, onClick) {
  if (!items || items.length === 0) {
    renderEmpty(listEl, 'Nothing yet');
    return;
  }

  const clockSvg = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M12 7v5l3 2"></path>
    </svg>
  `.trim();

  listEl.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'row';
    row.tabIndex = 0;
    row.role = 'button';

    const title = safeText(item.title || 'Untitled');
    const workspaceName = item.workspaceName || item.workspace_name || null;
    const updatedAt = typeof item.updatedAt === 'number'
      ? item.updatedAt
      : typeof item.updated_at === 'number'
        ? item.updated_at
        : typeof item.updated_at === 'string'
          ? new Date(item.updated_at).getTime()
          : null;

    row.innerHTML = `
      <div class="rowMain">
        <div class="rowTitle">${escapeHtml(title)}</div>
        ${workspaceName ? `<div class="rowMeta">${escapeHtml(workspaceName)}</div>` : ``}
      </div>
      <div class="rowTime">${updatedAt ? `${clockSvg}<span>${escapeHtml(formatRelativeTime(updatedAt))}</span>` : ''}</div>
    `;

    const click = () => onClick(item);
    row.addEventListener('click', click);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') click();
    });

    listEl.appendChild(row);
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function navigate(cv, mode) {
  if (cv?.ui?.navigate) {
    await cv.ui.navigate({ kind: 'sidebar', mode });
    return;
  }
  if (cv?.events?.emit) {
    cv.events.emit('ui:navigate', { kind: 'sidebar', mode });
    return;
  }
  throw new Error('Navigation API not available');
}

async function openContent(cv, type, id) {
  if (cv?.ui?.openContent) {
    await cv.ui.openContent({ type, id });
    return;
  }
  if (cv?.events?.emit) {
    cv.events.emit('ui:openContent', { type, id });
    return;
  }
  throw new Error('OpenContent API not available');
}

async function loadRecent(cv, limit) {
  // Preferred API: one call returns all four lists (keeps the extension simple).
  if (cv?.dashboard?.getRecent) return cv.dashboard.getRecent({ limit });

  // Accept getSummary() too, but only use the recent payload.
  if (cv?.dashboard?.getSummary) {
    const summary = await cv.dashboard.getSummary({ limit });
    return summary?.recent ?? { notes: [], reports: [], canvases: [], exhibits: [] };
  }

  // Fallback: try to approximate using whatever per-type APIs exist.
  async function list(type) {
    if (cv?.content?.list) return cv.content.list({ type, limit });
    return [];
  }

  const [notes, reports, canvases, exhibits] = await Promise.all([
    list('note'),
    list('report'),
    list('canvas'),
    list('exhibit'),
  ]);

  return { notes, reports, canvases, exhibits };
}

async function refresh() {
  const errorEl = $('error');
  const loadingEl = $('loading');

  setHidden(errorEl, true);
  setHidden(loadingEl, false);

  try {
    const cv = window.clairvoyance;
    if (!cv) {
      throw new Error('window.clairvoyance is missing. This extension requires the host bridge injection.');
    }

    const limit = typeof cv?.settings?.limit === 'number' ? cv.settings.limit : 5;
    const recent = await loadRecent(cv, limit);

    // Lists
    renderList($('list-notes'), recent?.notes ?? [], (item) => openContent(cv, 'note', item.id));
    renderList($('list-reports'), recent?.reports ?? [], (item) => openContent(cv, 'report', item.id));
    renderList($('list-canvases'), recent?.canvases ?? [], (item) => openContent(cv, 'canvas', item.id));
    renderList($('list-exhibits'), recent?.exhibits ?? [], (item) => openContent(cv, 'exhibit', item.id));

    setHidden(loadingEl, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    $('error').textContent = message;
    setHidden($('error'), false);
    setHidden(loadingEl, true);

    // Keep lists readable in error state
    renderEmpty($('list-notes'), 'Unavailable');
    renderEmpty($('list-reports'), 'Unavailable');
    renderEmpty($('list-canvases'), 'Unavailable');
    renderEmpty($('list-exhibits'), 'Unavailable');
  }
}

function wireUp() {
  // Delegated "View all" links
  document.addEventListener('click', async (e) => {
    const node = e.target;
    if (!(node instanceof Element)) return;
    const btn = node.closest('button[data-action="viewAll"]');
    if (!btn) return;
    const mode = btn.getAttribute('data-target');
    if (!mode) return;

    try {
      const cv = window.clairvoyance;
      await navigate(cv, mode);
    } catch {
      // Best-effort: ignore if host doesn't implement navigation yet.
    }
  });

  // Click the error notice to retry.
  $('error').addEventListener('click', () => refresh());
}

wireUp();
refresh();
