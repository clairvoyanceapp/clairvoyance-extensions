/**
 * Media Vault — Viewer Logic
 *
 * Handles:
 *  - Image viewing (PNG, JPG, BMP, WebP, SVG, GIF, TGA)
 *  - 3D model viewing (FBX, OBJ, GLTF/GLB) via three.js
 *  - DDS texture inspection with channel isolation & mip levels
 *  - Zoom/pan for 2D, orbit controls for 3D
 *  - Keyboard shortcuts
 */

(async () => {
  'use strict';

  /* ================================================================ */
  /*  Init API                                                        */
  /* ================================================================ */

  let api;
  try {
    api = await waitForApi();
  } catch {
    document.getElementById('viewport').innerHTML =
      '<div class="error-container"><div class="error-title">API unavailable</div></div>';
    return;
  }

  /* ================================================================ */
  /*  DOM Refs                                                        */
  /* ================================================================ */

  const $viewport       = document.getElementById('viewport');
  const $welcomeScreen  = document.getElementById('welcomeScreen');
  const $imageContainer = document.getElementById('imageContainer');
  const $filename       = document.getElementById('filename');
  const $formatBadge    = document.getElementById('formatBadge');
  const $headerMeta     = document.getElementById('headerMeta');
  const $toolbarCenter  = document.getElementById('toolbarCenter');
  const $toolbarRight   = document.getElementById('toolbarRight');
  const $metadataPanel  = document.getElementById('metadataPanel');
  const $viewerHeader   = document.getElementById('viewerHeader');
  const $statsOverlay   = document.getElementById('statsOverlay');
  const $animControls   = document.getElementById('animationControls');
  const $animSelect     = document.getElementById('animSelect');
  const $animTimeline   = document.getElementById('animTimeline');
  const $animTimeLabel  = document.getElementById('animTimeLabel');
  const $btnPlayPause   = document.getElementById('btnPlayPause');

  // Set welcome icon + browse-all button
  document.getElementById('welcomeIcon').innerHTML =
    ICONS.cube.replace(/width="16"/g, 'width="64"').replace(/height="16"/g, 'height="64"');
  document.getElementById('btnBrowseAll').addEventListener('click', () => void showFlatView());

  /* ================================================================ */
  /*  State                                                           */
  /* ================================================================ */

  let currentFile  = null;   // { path, name, relativePath, data (base64), size, mimeType }
  let currentFbxRelativePath = null; // stored for convention-based texture assignment
  let siblingTextureMatches = null;  // cached convention matches: Map<slot, {name, relativePath}>
  let viewerMode   = 'none'; // 'none' | 'image' | '3d' | 'dds'
  let activeSelectionKey = '';
  let activeSelectionUpdatedAt = 0;
  let selectionVersion = 0; // increments on each new selection, stale loads check this
  let selectionPollTimer = null;
  let cleanupImageInteractions = null;
  let imageResizeObserver = null;
  let threeResizeObserver = null;

  // Image viewer state
  let imgZoom     = 1;
  let imgPanX     = 0;
  let imgPanY     = 0;
  let imgDragging = false;
  let imgDragStart = { x: 0, y: 0, panX: 0, panY: 0 };
  let imgNaturalW = 0;
  let imgNaturalH = 0;

  // DDS state
  let ddsChannel  = 'rgb';   // 'rgb' | 'r' | 'g' | 'b' | 'a'
  let ddsMipLevel = 0;
  let ddsTiling   = false;
  let ddsData     = null;    // parsed DDS object

  // 3D state
  let threeScene, threeCamera, threeRenderer, threeControls;
  let threeMixer, threeAnimations = [], threeClock;
  let threeAnimPlaying = true;
  let threeViewMode = 'solid'; // 'solid' | 'wireframe' | 'both'
  let threeGridHelper, threeModel;
  let threeAxesHelper = null;
  let threeBBoxHelper = null;

  // Scene lights (stored for runtime adjustment)
  let lightAmbient = null;
  let lightKey = null;
  let lightFill = null;
  let lightHemi = null;

  // Scene settings state
  const sceneSettings = {
    // Lighting
    preset: 'studio',
    ambientIntensity: 0.4,
    keyIntensity: 0.7,
    keyColor: '#ffffff',
    fillIntensity: 0.2,
    hemiIntensity: 0.0,
    hemiSkyColor: '#87ceeb',
    hemiGroundColor: '#362907',
    // Environment
    bgColor: '#1a1a2e',
    showGrid: true,
    showAxes: false,
    showBBox: false,
    groundShadow: true,
    // Camera
    fov: 50,
    projection: 'perspective', // 'perspective' | 'orthographic'
    // Tone mapping
    toneMapping: 'ACES',
    exposure: 1.0,
    // Material override
    materialOverride: 'none', // 'none' | 'normals' | 'matcap-clay' | 'flat-white' | 'uv-checker'
  };

  // Model orientation — rotation in 90° increments (0 = 0°, 1 = 90°, 2 = 180°, 3 = 270°)
  let rotStepX = 0, rotStepY = 0, rotStepZ = 0;

  // Preloaded texture blob URLs (revoked on cleanup)
  let preloadedBlobUrls = [];

  // Mesh selection (raycasting)
  let selectedMesh = null;
  let selectionOutline = null;
  let raycaster = null;
  let mouseNDC = null;
  let isPointerDownForSelect = false;
  let pointerDownPos = { x: 0, y: 0 };

  // Per-mesh material edits
  const meshMaterialEdits = new Map();
  const loadedTextures = new Map();
  let workspaceImageFiles = null;

  // Metadata panel
  let metadataPanelVisible = true; // default on

  // Restore info panel state from storage
  void restoreInfoPanelState();

  // Folder view state
  let folderViewMode = 'grid'; // 'grid' | 'list'
  let flatMode = false;        // true = show all assets flat, false = single folder
  let folderEntries = [];
  let folderRelPath = '';

  // Navigation history — lets the user go Back from asset view to folder/flat view
  let navHistory = []; // stack of { mode: 'folder'|'flat', folderRelPath, folderViewMode }
  let folderEntriesByPath = null;
  let folderEntriesSourceAt = 0;
  let folderThumbObserver = null;
  const folderThumbTargets = new WeakMap();
  let folderThumbQueue = [];
  let folderThumbLoadsInFlight = 0;
  let folderRenderVersion = 0;

  // Shared file list cache (avoids redundant listFiles calls)
  let cachedFileList = null;
  let cachedFileListTime = 0;
  let cachedFileListWorkspaceId = null;
  let cachedFileListWorkspacePath = null;
  const FILE_LIST_TTL = 30000; // 30 seconds
  const STORAGE_FILE_LIST_TTL = 10 * 60 * 1000;
  const MAX_FOLDER_THUMB_LOADS = 4;

  function isBrowsableFolderEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.type === 'directory') return true;
    if (entry.type !== 'file') return false;
    return ALL_ASSET_EXTENSIONS.includes(getFileExtension(entry.name || ''));
  }

  function normalizeFolderEntry(entry) {
    return {
      name: entry.name,
      relativePath: entry.relativePath,
      type: entry.type === 'directory' ? 'directory' : 'file',
      size: typeof entry.size === 'number' ? entry.size : undefined,
    };
  }

  function cacheMatchesWorkspace(workspaceId, workspacePath) {
    if (cachedFileListWorkspaceId && workspaceId && cachedFileListWorkspaceId !== workspaceId) {
      return false;
    }
    if (cachedFileListWorkspacePath && workspacePath && cachedFileListWorkspacePath !== workspacePath) {
      return false;
    }
    return true;
  }

  function setCachedFileList(files, loadedAt = Date.now(), workspaceInfo = null) {
    cachedFileList = files;
    cachedFileListTime = loadedAt;
    cachedFileListWorkspaceId = workspaceInfo?.workspaceId || null;
    cachedFileListWorkspacePath = workspaceInfo?.workspacePath || null;
    folderEntriesByPath = null;
    folderEntriesSourceAt = 0;
  }

  function invalidateFileListCache() {
    cachedFileList = null;
    cachedFileListTime = 0;
    cachedFileListWorkspaceId = null;
    cachedFileListWorkspacePath = null;
    folderEntriesByPath = null;
    folderEntriesSourceAt = 0;
  }

  async function getStorageCachedFileList() {
    const cache = await api.storage.get(STORAGE_KEYS.assetIndexCache);
    if (!cache || typeof cache !== 'object' || !Array.isArray(cache.entries)) {
      return null;
    }

    const loadedAt = typeof cache.loadedAt === 'number' ? cache.loadedAt : 0;
    if (loadedAt <= 0 || (Date.now() - loadedAt) > STORAGE_FILE_LIST_TTL) {
      return null;
    }

    const activeWorkspace = await api.workspace.getActive();
    const activeWorkspaceId = activeWorkspace?.id || null;
    const activeWorkspacePath = activeWorkspace?.path || null;

    if (
      (cache.workspaceId && activeWorkspaceId && cache.workspaceId !== activeWorkspaceId) ||
      (cache.workspacePath && activeWorkspacePath && cache.workspacePath !== activeWorkspacePath)
    ) {
      return null;
    }

    return {
      files: cache.entries
        .filter(isBrowsableFolderEntry)
        .map(normalizeFolderEntry),
      loadedAt,
      workspaceId: cache.workspaceId || activeWorkspaceId,
      workspacePath: cache.workspacePath || activeWorkspacePath,
    };
  }

  async function persistFileListCache(files) {
    const activeWorkspace = await api.workspace.getActive();
    const payload = {
      workspaceId: activeWorkspace?.id || null,
      workspacePath: activeWorkspace?.path || null,
      loadedAt: Date.now(),
      entries: files.map((entry) => ({
        name: entry.name,
        relativePath: entry.relativePath,
        type: entry.type,
        size: typeof entry.size === 'number' ? entry.size : undefined,
      })),
    };
    broadcastExtensionEvent('asset-index-updated', payload);
    try {
      await api.storage.set(STORAGE_KEYS.assetIndexCache, payload);
    } catch (_) {}
  }

  function buildFolderEntryIndex(files) {
    const byPath = new Map();

    for (const entry of files) {
      if (!isBrowsableFolderEntry(entry)) continue;
      const parentPath = getDirectory(entry.relativePath || '');
      const bucketKey = parentPath || '';
      const bucket = byPath.get(bucketKey) || [];
      bucket.push(entry);
      byPath.set(bucketKey, bucket);
    }

    for (const entries of byPath.values()) {
      entries.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
    }

    return byPath;
  }

  async function getCachedFileList() {
    const now = Date.now();
    const activeWorkspace = await api.workspace.getActive();
    const activeWorkspaceId = activeWorkspace?.id || null;
    const activeWorkspacePath = activeWorkspace?.path || null;

    if (
      cachedFileList &&
      (now - cachedFileListTime) < FILE_LIST_TTL &&
      cacheMatchesWorkspace(activeWorkspaceId, activeWorkspacePath)
    ) {
      return cachedFileList;
    }

    const storedCache = await getStorageCachedFileList();
    if (storedCache) {
      setCachedFileList(storedCache.files, storedCache.loadedAt, storedCache);
      return cachedFileList;
    }

    const result = await api.workspace.listFiles({ includeDirectories: true });
    const files = (result.files || [])
      .filter(isBrowsableFolderEntry)
      .map(normalizeFolderEntry);

    setCachedFileList(files, now, {
      workspaceId: activeWorkspaceId,
      workspacePath: activeWorkspacePath,
    });
    void persistFileListCache(files);
    return cachedFileList;
  }

  async function getCachedFolderEntries(relativePath) {
    const files = await getCachedFileList();
    if (!folderEntriesByPath || folderEntriesSourceAt !== cachedFileListTime) {
      folderEntriesByPath = buildFolderEntryIndex(files || []);
      folderEntriesSourceAt = cachedFileListTime;
    }
    return folderEntriesByPath.get(relativePath || '') || [];
  }

  async function readFolderEntries(relativePath) {
    if (api.workspace?.readDirectory) {
      const result = await api.workspace.readDirectory({
        path: relativePath || '',
        includeDirectories: true,
      });
      const entries = Array.isArray(result?.files) ? result.files : [];
      return entries
        .filter(isBrowsableFolderEntry)
        .map(normalizeFolderEntry)
        .sort((a, b) => {
          if (a.type === 'directory' && b.type !== 'directory') return -1;
          if (a.type !== 'directory' && b.type === 'directory') return 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
    }

    return await getCachedFolderEntries(relativePath);
  }

  // Cached model stats (avoid redundant scene graph traversals)
  let cachedModelStats = null;

  /* ================================================================ */
  /*  Parse Query Params & Load                                       */
  /* ================================================================ */

  const query = api.context?.query || '';
  const params = new URLSearchParams(query);
  const filePath = params.get('path');
  const folderPath = params.get('folder');
  const fileName = params.get('name');

  const initialSelection = folderPath
    ? { type: 'directory', relativePath: folderPath, name: fileName || getFileName(folderPath) }
    : filePath
      ? { type: 'file', relativePath: filePath, name: fileName || getFileName(filePath) }
      : null;

  if (initialSelection) {
    void applySelection(initialSelection);
  } else {
    void loadStoredSelection();
  }

  window.addEventListener('clairvoyance-storage-changed', (e) => {
    // If the host included the changed key+value inline, use it directly
    // and skip the storage-read IPC round-trip entirely.
    const detail = e.detail || {};
    if (detail.key === STORAGE_KEYS.currentSelection && detail.value &&
        typeof detail.value === 'object' && typeof detail.value.relativePath === 'string') {
      void applySelection(detail.value);
      return;
    }
    void loadStoredSelection();
  });

  onExtensionEvent('selection-changed', (payload) => {
    // Use payload directly — avoids round-trip to storage which can miss or lag
    if (payload && typeof payload.relativePath === 'string') {
      void applySelection(payload);
    } else {
      void loadStoredSelection();
    }
  });

  onExtensionEvent('asset-index-updated', (payload) => {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entries)) return;
    const files = payload.entries
      .filter(isBrowsableFolderEntry)
      .map(normalizeFolderEntry);
    setCachedFileList(files, typeof payload.loadedAt === 'number' ? payload.loadedAt : Date.now(), {
      workspaceId: payload.workspaceId || null,
      workspacePath: payload.workspacePath || null,
    });
  });

  // Slow fallback poll — only for startup recovery or missed events
  selectionPollTimer = window.setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    void loadStoredSelection();
  }, 5000);

  window.addEventListener('focus', () => {
    void loadStoredSelection();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void loadStoredSelection();
    }
  });

  window.addEventListener('beforeunload', () => {
    if (selectionPollTimer !== null) {
      window.clearInterval(selectionPollTimer);
      selectionPollTimer = null;
    }
  });

  /* ================================================================ */
  /*  Selection Sync                                                   */
  /* ================================================================ */

  function getSelectionKey(selection) {
    if (!selection || typeof selection.relativePath !== 'string') return '';
    const type = selection.type === 'directory' ? 'directory' : 'file';
    return `${type}:${selection.relativePath}`;
  }

  async function loadStoredSelection() {
    try {
      const stored = await api.storage.get(STORAGE_KEYS.currentSelection);
      if (!stored || typeof stored !== 'object' || typeof stored.relativePath !== 'string') return;
      const key = getSelectionKey(stored);
      const updatedAt = typeof stored.updatedAt === 'number' ? stored.updatedAt : 0;
      if (!key || (key === activeSelectionKey && updatedAt <= activeSelectionUpdatedAt)) return;
      await applySelection(stored);
    } catch (_) {
      // Ignore storage sync failures in the viewer.
    }
  }

  async function applySelection(selection) {
    if (!selection || typeof selection.relativePath !== 'string') return;

    const normalized = {
      type: selection.type === 'directory' ? 'directory' : 'file',
      relativePath: selection.relativePath,
      name: selection.name || getFileName(selection.relativePath),
    };

    const key = getSelectionKey(normalized);
    if (!key) return;

    // ── Instant feedback ───────────────────────────────────────────
    // Show the overlay BEFORE cleanup/async work so the user sees an
    // immediate response, even when Three.js disposal blocks the thread.
    showLoadingOverlay(normalized.name);
    // Only yield a frame when tearing down a 3D scene (heavy GPU disposal).
    // For everything else, proceed immediately — the host now notifies us
    // before the disk write, so every millisecond counts.
    if (viewerMode === '3d') {
      await new Promise(r => requestAnimationFrame(r));
    }

    activeSelectionKey = key;
    activeSelectionUpdatedAt = typeof selection.updatedAt === 'number' ? selection.updatedAt : Date.now();
    selectionVersion++;
    const myVersion = selectionVersion;

    if (normalized.type === 'directory') {
      flatMode = false;
      await showFolderView(normalized.relativePath, normalized.name, myVersion);
    } else {
      // If currently browsing folders/flat, save state so Back works
      if (viewerMode === 'folder') {
        pushNavHistory();
      }
      await loadAsset(normalized.relativePath, normalized.name);
    }
  }

  async function updateCurrentSelection(selection) {
    const normalized = {
      type: selection.type === 'directory' ? 'directory' : 'file',
      relativePath: selection.relativePath,
      name: selection.name || getFileName(selection.relativePath),
      updatedAt: Date.now(),
    };
    activeSelectionKey = getSelectionKey(normalized);
    activeSelectionUpdatedAt = normalized.updatedAt;
    await api.storage.set(STORAGE_KEYS.currentSelection, normalized);
  }

  /* ================================================================ */
  /*  Load Asset                                                      */
  /* ================================================================ */

  async function loadAsset(relativePath, name) {
    showLoading(name);

    try {
      console.log('[Media Vault] Loading asset:', relativePath);
      const result = await api.workspace.readBinaryFile(relativePath);
      console.log('[Media Vault] readBinaryFile returned:', result.name, result.size, 'bytes, mime:', result.mimeType);
      currentFile = {
        relativePath,
        name: name || result.name,
        data: result.data,
        size: result.size,
        mimeType: result.mimeType,
      };

      const ext = getFileExtension(currentFile.name);

      // Route to appropriate viewer
      if (isNativeImageFile(currentFile.name)) {
        await showImageViewer(currentFile);
      } else if (ext === '.tga') {
        await showTgaViewer(currentFile);
      } else if (ext === '.dds') {
        await showDdsViewer(currentFile);
      } else if (is3DFile(currentFile.name)) {
        await show3DViewer(currentFile);
      } else {
        showError('Unsupported format', `Cannot preview "${ext}" files yet.`);
      }

      // Always build info panel after asset loads
      buildMetadataPanel();
    } catch (e) {
      console.error('[Media Vault] loadAsset failed:', e);
      showError('Failed to load asset', e.message || 'Unknown error');
    }
  }

  /* ================================================================ */
  /*  Folder View                                                     */
  /* ================================================================ */

  async function showFolderView(relativePath, name, version) {
    cleanup();
    viewerMode = 'folder';
    currentFile = null;
    folderRelPath = relativePath;
    folderEntries = [];

    $welcomeScreen.style.display = 'none';
    $imageContainer.style.display = 'none';
    $metadataPanel.classList.remove('visible');
    $metadataPanel.innerHTML = '';
    $statsOverlay.classList.remove('visible');
    $viewport.className = 'viewport';
    renderFolderChrome(true);

    // Show loading
    $viewport.innerHTML = '';
    $viewport.appendChild($welcomeScreen);
    $viewport.appendChild($imageContainer);
    const loadEl = document.createElement('div');
    loadEl.className = 'loading-container';
    loadEl.innerHTML = `<div class="loading-spinner">${ICONS.refresh}</div><div class="loading-text">Loading folder...</div>`;
    $viewport.appendChild(loadEl);

    try {
      const nextFolderEntries = await readFolderEntries(relativePath);

      // If a newer selection arrived while we were loading, abandon this render
      if (version != null && version !== selectionVersion) {
        console.log('[Media Vault] Stale folder load abandoned:', relativePath);
        return;
      }

      folderEntries = nextFolderEntries;

      loadEl.remove();
      renderFolderChrome(false);
      renderFolderView();
    } catch (e) {
      loadEl.remove();
      renderFolderChrome(false);
      showError('Failed to load folder', e.message || 'Unknown error');
    }
  }

  /* ================================================================ */
  /*  Flat View — all assets across all subfolders                    */
  /* ================================================================ */

  async function showFlatView() {
    cleanup();
    viewerMode = 'folder';
    flatMode = true;
    currentFile = null;
    folderRelPath = '';
    folderEntries = [];

    $welcomeScreen.style.display = 'none';
    $imageContainer.style.display = 'none';
    $metadataPanel.classList.remove('visible');
    $metadataPanel.innerHTML = '';
    $statsOverlay.classList.remove('visible');
    $viewport.className = 'viewport';
    renderFolderChrome(true);

    // Show loading
    $viewport.innerHTML = '';
    $viewport.appendChild($welcomeScreen);
    $viewport.appendChild($imageContainer);
    const loadEl = document.createElement('div');
    loadEl.className = 'loading-container';
    loadEl.innerHTML = `<div class="loading-spinner">${ICONS.refresh}</div><div class="loading-text">Loading all assets\u2026</div>`;
    $viewport.appendChild(loadEl);

    try {
      const allFiles = await getCachedFileList();
      // Flat mode: only files, no directories
      folderEntries = (allFiles || [])
        .filter(f => f.type !== 'directory')
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

      loadEl.remove();
      renderFolderChrome(false);
      renderFolderView();
    } catch (e) {
      loadEl.remove();
      renderFolderChrome(false);
      showError('Failed to load assets', e.message || 'Unknown error');
    }
  }

  function renderFolderView() {
    resetFolderThumbnailLoader();
    folderRenderVersion += 1;
    const renderVersion = folderRenderVersion;

    // Clear viewport (keep hidden elements)
    const keep = [$welcomeScreen, $imageContainer, $statsOverlay];
    Array.from($viewport.children).forEach(c => {
      if (!keep.includes(c)) c.remove();
    });

    const browser = document.createElement('div');
    browser.className = 'folder-browser';

    if (folderViewMode === 'list') {
      browser.appendChild(buildFolderListHeader());
    }

    const scroll = document.createElement('div');
    scroll.className = 'folder-scroll';

    if (folderEntries.length === 0) {
      const emptyTitle = flatMode ? 'No assets found' : 'Folder is empty';
      const emptySubtitle = flatMode
        ? 'No supported asset files were found in this workspace.'
        : 'No subfolders or supported asset files were found here.';
      const empty = document.createElement('div');
      empty.className = 'welcome-screen';
      empty.innerHTML = `
        <div class="welcome-icon">${ICONS.folder.replace(/width="16"/g, 'width="48"').replace(/height="16"/g, 'height="48"')}</div>
        <div class="welcome-title">${emptyTitle}</div>
        <div class="welcome-subtitle">${emptySubtitle}</div>
      `;
      scroll.appendChild(empty);
    } else if (folderViewMode === 'grid') {
      renderFolderGrid(scroll, renderVersion);
    } else {
      renderFolderList(scroll);
    }

    browser.appendChild(scroll);
    $viewport.appendChild(browser);
  }

  function getFolderNameForPath(relativePath) {
    const folderPath = getDirectory(relativePath || '');
    return getFileName(folderPath) || 'Workspace';
  }

  function setHeaderContent(title, badge, meta) {
    $viewerHeader.style.display = '';
    $filename.textContent = title || 'No file loaded';

    if (badge) {
      $formatBadge.textContent = badge;
      $formatBadge.style.display = '';
    } else {
      $formatBadge.textContent = '';
      $formatBadge.style.display = 'none';
    }

    $headerMeta.textContent = meta || '';
    $headerMeta.title = meta || '';
  }

  function renderFolderChrome(isLoadingState) {
    // Hide the header — everything goes in one toolbar row, matching Files tab density
    $viewerHeader.style.display = 'none';

    const itemCount = isLoadingState
      ? ''
      : `${folderEntries.length} item${folderEntries.length === 1 ? '' : 's'}`;

    const pathLabel = flatMode
      ? 'All Assets'
      : escapeHtml(getFileName(folderRelPath) || 'Workspace');

    // Single toolbar row: view toggles | flat | nav | path label | spacer | item count
    $toolbarCenter.innerHTML = `
      <button class="viewer-btn ${folderViewMode === 'list' ? 'active' : ''}" id="btnFolderList" title="List view">${ICONS.list}</button>
      <button class="viewer-btn ${folderViewMode === 'grid' ? 'active' : ''}" id="btnFolderGrid" title="Grid view">${ICONS.gridView}</button>
      <div class="viewer-separator"></div>
      <button class="viewer-btn ${flatMode ? 'active' : ''}" id="btnFlatToggle" title="Flat mode — show all assets">${ICONS.layers}</button>
      <button class="viewer-btn" id="btnFolderUp" title="${flatMode ? 'Exit flat mode' : 'Back'}">${ICONS.chevronLeft}</button>
      <button class="viewer-btn ${isLoadingState ? 'spinning' : ''}" id="btnFolderRefresh" title="Refresh">${ICONS.refresh}</button>
      <div class="viewer-separator"></div>
      <span class="folder-path-label" title="${escapeHtml(folderRelPath || '/')}">${pathLabel}</span>
    `;

    $toolbarRight.innerHTML = itemCount
      ? `<span class="folder-item-count">${itemCount}</span>`
      : '';

    $toolbarCenter.querySelector('#btnFolderList').addEventListener('click', () => {
      folderViewMode = 'list';
      renderFolderChrome(false);
      renderFolderView();
    });

    $toolbarCenter.querySelector('#btnFolderGrid').addEventListener('click', () => {
      folderViewMode = 'grid';
      renderFolderChrome(false);
      renderFolderView();
    });

    $toolbarCenter.querySelector('#btnFlatToggle').addEventListener('click', () => {
      if (flatMode) {
        // Exit flat mode → go to workspace root
        void navigateToFolder('');
      } else {
        void showFlatView();
      }
    });

    const btnUp = $toolbarCenter.querySelector('#btnFolderUp');
    if (flatMode) {
      // In flat mode, back exits to workspace root
      btnUp.disabled = false;
      btnUp.addEventListener('click', () => void navigateToFolder(''));
    } else if (canGoBack()) {
      btnUp.disabled = false;
      btnUp.addEventListener('click', () => void navigateBack());
    } else {
      btnUp.disabled = !folderRelPath;
      btnUp.addEventListener('click', () => {
        if (!folderRelPath) return;
        void navigateToFolder(getParentRelativePath(folderRelPath));
      });
    }

    $toolbarCenter.querySelector('#btnFolderRefresh').addEventListener('click', () => {
      invalidateFileListCache();
      if (flatMode) {
        void showFlatView();
      } else {
        void showFolderView(folderRelPath, getFileName(folderRelPath) || 'Workspace');
      }
    });
  }

  function renderFolderGrid(container, renderVersion) {
    const grid = document.createElement('div');
    grid.className = 'folder-grid';

    for (const entry of folderEntries) {
      const card = document.createElement('div');
      card.className = 'folder-card';

      const thumb = document.createElement('div');
      thumb.className = 'folder-thumb';

      if (entry.type === 'directory') {
        thumb.innerHTML = `<div style="opacity:0.7">${ICONS.folder.replace(/width="16"/g, 'width="40"').replace(/height="16"/g, 'height="40"')}</div>`;
      } else if (isNativeImageFile(entry.name)) {
        queueFolderThumbnail(entry, thumb, renderVersion);
      } else {
        thumb.innerHTML = `<div style="opacity:0.5">${getEntryIconSvg(entry).replace(/width="16"/g, 'width="40"').replace(/height="16"/g, 'height="40"')}</div>`;
      }
      card.appendChild(thumb);

      const nameEl = document.createElement('div');
      nameEl.className = 'folder-name';
      nameEl.textContent = entry.name;
      nameEl.title = entry.relativePath;
      card.appendChild(nameEl);

      const badge = document.createElement('div');
      badge.className = 'folder-subtitle';
      badge.textContent = flatMode
        ? (getDirectory(entry.relativePath) || 'Root')
        : getFolderEntryTypeLabel(entry);
      card.appendChild(badge);

      card.addEventListener('click', () => {
        void openFolderEntry(entry);
      });

      grid.appendChild(card);
    }

    container.appendChild(grid);
  }

  function renderFolderList(container) {
    const table = document.createElement('div');
    table.className = 'folder-list';

    for (const entry of folderEntries) {
      const row = document.createElement('div');
      row.className = 'folder-row';

      const typeOrPath = flatMode
        ? escapeHtml(getDirectory(entry.relativePath) || 'Root')
        : escapeHtml(getFolderEntryTypeLabel(entry));
      row.innerHTML = `
        <div class="folder-col-name">
          <span style="flex-shrink:0">${getEntryIconSvg(entry)}</span>
          <span class="folder-entry-name" title="${escapeHtml(entry.relativePath)}">${escapeHtml(entry.name)}</span>
        </div>
        <div class="folder-col-type">${typeOrPath}</div>
        <div class="folder-col-size">${escapeHtml(getFolderEntrySizeLabel(entry))}</div>
      `;

      row.addEventListener('click', () => {
        void openFolderEntry(entry);
      });

      table.appendChild(row);
    }

    container.appendChild(table);
  }

  function resetFolderThumbnailLoader() {
    if (folderThumbObserver) {
      folderThumbObserver.disconnect();
      folderThumbObserver = null;
    }
    folderThumbQueue = [];
    folderThumbLoadsInFlight = 0;
  }

  function enqueueFolderThumbnailLoad(thumbEl) {
    if (!thumbEl || !thumbEl.isConnected) return;
    if (thumbEl.dataset.thumbState && thumbEl.dataset.thumbState !== 'pending') return;
    const payload = folderThumbTargets.get(thumbEl);
    if (!payload) return;

    thumbEl.dataset.thumbState = 'queued';
    folderThumbQueue.push(payload);
    processFolderThumbnailQueue();
  }

  function processFolderThumbnailQueue() {
    while (folderThumbLoadsInFlight < MAX_FOLDER_THUMB_LOADS && folderThumbQueue.length > 0) {
      const next = folderThumbQueue.shift();
      if (!next?.thumbEl?.isConnected) continue;

      folderThumbLoadsInFlight += 1;
      next.thumbEl.dataset.thumbState = 'loading';
      loadFolderThumbnail(next.file, next.thumbEl, next.renderVersion)
        .finally(() => {
          folderThumbLoadsInFlight = Math.max(0, folderThumbLoadsInFlight - 1);
          processFolderThumbnailQueue();
        });
    }
  }

  function queueFolderThumbnail(file, thumbEl, renderVersion) {
    thumbEl.innerHTML = `<div style="opacity:0.35">${ICONS.image.replace(/width="16"/g, 'width="32"').replace(/height="16"/g, 'height="32"')}</div>`;
    thumbEl.dataset.thumbState = 'pending';

    const payload = { file, thumbEl, renderVersion };
    folderThumbTargets.set(thumbEl, payload);

    if (typeof IntersectionObserver === 'undefined') {
      enqueueFolderThumbnailLoad(thumbEl);
      return;
    }

    if (!folderThumbObserver) {
      folderThumbObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          folderThumbObserver?.unobserve(entry.target);
          enqueueFolderThumbnailLoad(entry.target);
        }
      }, {
        root: null,
        rootMargin: '240px 0px',
      });
    }

    folderThumbObserver.observe(thumbEl);
  }

  async function loadFolderThumbnail(file, thumbEl, renderVersion) {
    try {
      const result = await api.workspace.readBinaryFile(file.relativePath);
      if (!thumbEl.isConnected || renderVersion !== folderRenderVersion) return;
      const dataUrl = `data:${result.mimeType};base64,${result.data}`;
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = file.name;
      img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
      thumbEl.innerHTML = '';
      thumbEl.appendChild(img);
      thumbEl.dataset.thumbState = 'done';
    } catch (_) {
      if (thumbEl.isConnected) {
        thumbEl.dataset.thumbState = 'error';
      }
    }
  }

  function buildFolderListHeader() {
    const header = document.createElement('div');
    header.className = 'folder-list-header';
    header.innerHTML = `
      <div class="folder-col-name">Name</div>
      <div class="folder-col-type">Type</div>
      <div class="folder-col-size">Size</div>
    `;
    return header;
  }

  function getParentRelativePath(path) {
    if (!path) return '';
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
  }

  function getFolderEntryTypeLabel(entry) {
    if (entry.type === 'directory') return 'Folder';
    const ext = getFileExtension(entry.name).replace('.', '').toUpperCase();
    return ext || 'File';
  }

  function getFolderEntrySizeLabel(entry) {
    if (entry.type === 'directory') return '--';
    return typeof entry.size === 'number' ? formatFileSize(entry.size) : '--';
  }

  function getEntryIconSvg(entry) {
    if (entry.type === 'directory') return ICONS.folder;
    const cat = getAssetCategory(entry.name);
    const iconName = cat === '3d' ? 'cube' : cat === 'texture' ? 'grid' : 'image';
    const iconColor = cat === '3d' ? '#c27ba0' : cat === 'texture' ? '#ab47bc' : '#c27ba0';
    return icon(iconName, iconColor);
  }

  /** Save current browse state so Back can restore it. */
  function pushNavHistory() {
    navHistory.push({
      mode: flatMode ? 'flat' : 'folder',
      folderRelPath,
      folderViewMode,
    });
  }

  /** Navigate back to the previous folder / flat view. */
  async function navigateBack() {
    const prev = navHistory.pop();
    if (!prev) return;
    showLoadingOverlay(prev.mode === 'flat' ? 'All Assets' : (getFileName(prev.folderRelPath) || 'Workspace'));
    folderViewMode = prev.folderViewMode || folderViewMode;
    if (prev.mode === 'flat') {
      await showFlatView();
    } else {
      flatMode = false;
      const name = prev.folderRelPath ? getFileName(prev.folderRelPath) : 'Workspace';
      await showFolderView(prev.folderRelPath, name);
    }
  }

  /** Has back-navigable history? */
  function canGoBack() {
    return navHistory.length > 0;
  }

  async function navigateToFolder(relativePath) {
    flatMode = false;
    const name = relativePath ? getFileName(relativePath) : 'Workspace';
    showLoadingOverlay(name);
    await updateCurrentSelection({
      type: 'directory',
      relativePath,
      name,
    });
    await showFolderView(relativePath, name);
  }

  async function openFolderEntry(entry) {
    if (entry.type === 'directory') {
      await navigateToFolder(entry.relativePath);
      return;
    }

    // Save browse state so Back returns here
    pushNavHistory();

    showLoadingOverlay(entry.name);
    await updateCurrentSelection({
      type: 'file',
      relativePath: entry.relativePath,
      name: entry.name,
    });
    await loadAsset(entry.relativePath, entry.name);
  }

  /* ================================================================ */
  /*  Instant Loading Overlay                                         */
  /* ================================================================ */

  /**
   * Instantly display a loading overlay on top of whatever is currently
   * showing.  This is called at the very start of applySelection() —
   * BEFORE cleanup() or any async work — so the user gets sub-frame
   * visual feedback on every sidebar click.
   */
  function showLoadingOverlay(name) {
    removeLoadingOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.innerHTML =
      `<div class="loading-spinner">${ICONS.refresh}</div>` +
      `<div class="loading-text">Loading ${escapeHtml(name || 'asset')}\u2026</div>`;
    $viewport.appendChild(overlay);
    setHeaderContent(name || 'Loading\u2026', '', '');
  }

  function removeLoadingOverlay() {
    const el = $viewport.querySelector('.loading-overlay');
    if (el) el.remove();
  }

  /* ================================================================ */
  /*  Loading / Error / Welcome states                                */
  /* ================================================================ */

  function showLoading(name) {
    cleanup();
    $welcomeScreen.style.display = 'none';
    $imageContainer.style.display = 'none';
    $viewport.innerHTML = '';
    $viewport.className = 'viewport';

    // Re-add persistent containers (innerHTML='' detaches them)
    $viewport.appendChild($welcomeScreen);
    $viewport.appendChild($imageContainer);
    $viewport.appendChild($statsOverlay);

    const el = document.createElement('div');
    el.className = 'loading-container';
    el.innerHTML = `<div class="loading-spinner">${ICONS.refresh}</div><div class="loading-text">Loading ${escapeHtml(name || 'asset')}...</div>`;
    $viewport.appendChild(el);

    setHeaderContent(name || 'Loading...', '', '');
    $toolbarCenter.innerHTML = '';
    $toolbarRight.innerHTML = '';
  }

  function showError(title, message) {
    console.error('[Media Vault]', title + ':', message);
    cleanup();
    $welcomeScreen.style.display = 'none';
    $imageContainer.style.display = 'none';
    setHeaderContent(title, '', '');

    // Remove loading container if present
    const loading = $viewport.querySelector('.loading-container');
    if (loading) loading.remove();

    const el = document.createElement('div');
    el.className = 'error-container';
    el.innerHTML = `<div class="error-title">${escapeHtml(title)}</div><div class="error-message">${escapeHtml(message)}</div>`;
    $viewport.appendChild(el);
  }

  function escapeHtml(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  }

  function cleanup() {
    resetFolderThumbnailLoader();

    if (cleanupImageInteractions) {
      cleanupImageInteractions();
      cleanupImageInteractions = null;
    }

    // Dispose three.js if active
    if (threeRenderer) {
      threeRenderer.dispose();
      threeRenderer = null;
    }
    if (threeControls) {
      threeControls.dispose();
      threeControls = null;
    }

    // Dispose Three.js scene objects (geometries, materials, textures)
    if (threeScene) {
      threeScene.traverse((child) => {
        if (child.isMesh) {
          if (child.geometry) child.geometry.dispose();
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const m of mats) {
            if (!m) continue;
            for (const key of Object.keys(m)) {
              if (m[key] && m[key].isTexture) m[key].dispose();
            }
            m.dispose();
          }
        }
      });
      threeScene = null;
    }

    threeMixer = null;
    threeAnimations = [];
    threeModel = null;
    cachedModelStats = null;
    rotStepX = 0; rotStepY = 0; rotStepZ = 0;
    currentFbxRelativePath = null;
    siblingTextureMatches = null;
    preloadedBlobUrls.forEach(u => URL.revokeObjectURL(u));
    preloadedBlobUrls = [];

    // Clear texture and material caches
    loadedTextures.clear();
    originalMaterials.clear();
    meshMaterialEdits.clear();

    if (threeResizeObserver) {
      threeResizeObserver.disconnect();
      threeResizeObserver = null;
    }
    if (imageResizeObserver) {
      imageResizeObserver.disconnect();
      imageResizeObserver = null;
    }

    $animControls.classList.remove('visible');
    $statsOverlay.classList.remove('visible');
    // Keep info panel visible — always show when an asset is loaded
    metadataPanelVisible = true;
    viewerMode = 'none';
    ddsData = null;
  }

  /* ================================================================ */
  /*  IMAGE VIEWER                                                    */
  /* ================================================================ */

  async function showImageViewer(file) {
    viewerMode = 'image';

    // Remove loading
    const loading = $viewport.querySelector('.loading-container');
    if (loading) loading.remove();

    $welcomeScreen.style.display = 'none';
    $viewport.className = 'viewport checkerboard';
    $imageContainer.style.display = '';
    $imageContainer.innerHTML = '';

    const dataUrl = `data:${file.mimeType};base64,${file.data}`;
    const img = new Image();

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = dataUrl;
    });

    imgNaturalW = img.naturalWidth;
    imgNaturalH = img.naturalHeight;

    $imageContainer.appendChild(img);

    // Fit to view
    await fitElementToViewport(img);

    // Build toolbar
    buildImageToolbar();
    updateMetadataBar({
      Dimensions: `${imgNaturalW} × ${imgNaturalH}`,
      Size: formatFileSize(file.size),
      Format: getFileExtension(file.name).toUpperCase().replace('.', ''),
    });

    setHeaderContent(
      file.name,
      getFileExtension(file.name).replace('.', '').toUpperCase(),
      getFolderNameForPath(file.relativePath)
    );

    // Zoom/pan handlers
    setupImageInteractions(img);
  }

  function fitToView() {
    const vw = $viewport.clientWidth;
    const vh = $viewport.clientHeight;
    if (!imgNaturalW || !imgNaturalH || vw <= 0 || vh <= 0) return false;

    const scaleX = vw / imgNaturalW;
    const scaleY = vh / imgNaturalH;
    imgZoom = Math.min(scaleX, scaleY, 1) * 0.95; // slight padding
    imgPanX = (vw - imgNaturalW * imgZoom) / 2;
    imgPanY = (vh - imgNaturalH * imgZoom) / 2;
    return true;
  }

  function waitForNextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function observe2DViewport(el) {
    if (imageResizeObserver) {
      imageResizeObserver.disconnect();
      imageResizeObserver = null;
    }

    imageResizeObserver = new ResizeObserver(() => {
      if (viewerMode !== 'image' && viewerMode !== 'dds') return;
      if (!$imageContainer.contains(el)) return;
      if (!fitToView()) return;
      applyImageTransform(el);
    });
    imageResizeObserver.observe($viewport);
  }

  async function fitElementToViewport(el) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (fitToView()) {
        applyImageTransform(el);
        observe2DViewport(el);
        return true;
      }
      await waitForNextFrame();
    }

    applyImageTransform(el);
    observe2DViewport(el);
    return false;
  }

  function applyImageTransform(el) {
    el.style.transform = `translate(${imgPanX}px, ${imgPanY}px) scale(${imgZoom})`;
    el.classList.toggle('pixelated', imgZoom >= 4);
    updateZoomLabel();
  }

  function updateZoomLabel() {
    const label = $toolbarCenter.querySelector('.zoom-label');
    if (label) label.textContent = Math.round(imgZoom * 100) + '%';
  }

  function setupImageInteractions(el) {
    if (cleanupImageInteractions) {
      cleanupImageInteractions();
      cleanupImageInteractions = null;
    }

    if ('draggable' in el) {
      el.draggable = false;
    }

    const handleWheel = (e) => {
      e.preventDefault();
      const rect = $viewport.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const oldZoom = imgZoom;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      imgZoom = Math.max(0.01, Math.min(100, imgZoom * factor));

      // Zoom toward cursor
      imgPanX = mx - (mx - imgPanX) * (imgZoom / oldZoom);
      imgPanY = my - (my - imgPanY) * (imgZoom / oldZoom);

      applyImageTransform(el);
    };

    const handleMouseDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      imgDragging = true;
      imgDragStart = { x: e.clientX, y: e.clientY, panX: imgPanX, panY: imgPanY };
      $imageContainer.classList.add('dragging');
    };

    const handleMouseMove = (e) => {
      if (!imgDragging) return;
      imgPanX = imgDragStart.panX + (e.clientX - imgDragStart.x);
      imgPanY = imgDragStart.panY + (e.clientY - imgDragStart.y);
      applyImageTransform(el);
    };

    const handleMouseUp = () => {
      imgDragging = false;
      $imageContainer.classList.remove('dragging');
    };

    const handleDragStart = (e) => {
      e.preventDefault();
    };

    // Mouse wheel zoom
    $imageContainer.addEventListener('wheel', handleWheel, { passive: false });

    // Pan
    $imageContainer.addEventListener('mousedown', handleMouseDown);
    el.addEventListener('dragstart', handleDragStart);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    cleanupImageInteractions = () => {
      $imageContainer.removeEventListener('wheel', handleWheel);
      $imageContainer.removeEventListener('mousedown', handleMouseDown);
      el.removeEventListener('dragstart', handleDragStart);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      imgDragging = false;
      $imageContainer.classList.remove('dragging');
    };
  }

  /** Back button HTML for asset viewer toolbars. Only shown when there's history. */
  function backButtonHtml() {
    if (!canGoBack()) return '';
    return `<button class="viewer-btn" id="btnBack" title="Back">${ICONS.chevronLeft}</button><div class="viewer-separator"></div>`;
  }

  /** Wire the back button click handler (call after setting innerHTML). */
  function wireBackButton(container) {
    const btn = (container || $toolbarCenter).querySelector('#btnBack');
    if (btn) btn.addEventListener('click', () => void navigateBack());
  }

  function buildImageToolbar() {
    $toolbarCenter.innerHTML = `
      ${backButtonHtml()}
      <button class="viewer-btn" id="btnZoomOut" title="Zoom out">${ICONS.zoomOut}</button>
      <span class="zoom-label">${Math.round(imgZoom * 100)}%</span>
      <button class="viewer-btn" id="btnZoomIn" title="Zoom in">${ICONS.zoomIn}</button>
      <button class="viewer-btn" id="btnFitView" title="Fit to view (F)">${ICONS.maximize}</button>
    `;

    $toolbarRight.innerHTML = `
      <button class="viewer-btn" id="btnToggleInfo" title="Toggle info panel">${ICONS.info}</button>
    `;

    wireBackButton();
    $toolbarCenter.querySelector('#btnZoomIn').addEventListener('click', () => {
      zoomImage(1.25);
    });
    $toolbarCenter.querySelector('#btnZoomOut').addEventListener('click', () => {
      zoomImage(1 / 1.25);
    });
    $toolbarCenter.querySelector('#btnFitView').addEventListener('click', () => {
      const el = $imageContainer.querySelector('img, canvas');
      if (!el) return;
      void fitElementToViewport(el);
    });
    $toolbarRight.querySelector('#btnToggleInfo').addEventListener('click', toggleMetadataPanel);
  }

  function zoomImage(factor) {
    const el = $imageContainer.querySelector('img, canvas');
    if (!el) return;
    const vw = $viewport.clientWidth;
    const vh = $viewport.clientHeight;

    const oldZoom = imgZoom;
    imgZoom = Math.max(0.01, Math.min(100, imgZoom * factor));

    // Zoom toward center
    imgPanX = vw / 2 - (vw / 2 - imgPanX) * (imgZoom / oldZoom);
    imgPanY = vh / 2 - (vh / 2 - imgPanY) * (imgZoom / oldZoom);

    applyImageTransform(el);
  }

  /* ================================================================ */
  /*  TGA VIEWER                                                      */
  /* ================================================================ */

  async function showTgaViewer(file) {
    const bytes = base64ToUint8(file.data);
    const { width, height, rgba } = decodeTGA(bytes);

    viewerMode = 'image';

    const loading = $viewport.querySelector('.loading-container');
    if (loading) loading.remove();

    $welcomeScreen.style.display = 'none';
    $viewport.className = 'viewport checkerboard';
    $imageContainer.style.display = '';
    $imageContainer.innerHTML = '';

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(rgba);
    ctx.putImageData(imageData, 0, 0);

    imgNaturalW = width;
    imgNaturalH = height;

    $imageContainer.appendChild(canvas);
    await fitElementToViewport(canvas);
    buildImageToolbar();
    updateMetadataBar({
      Dimensions: `${width} × ${height}`,
      Size: formatFileSize(file.size),
      Format: 'TGA',
    });
    setHeaderContent(file.name, 'TGA', getFolderNameForPath(file.relativePath));
    setupImageInteractions(canvas);
  }

  /* ================================================================ */
  /*  DDS VIEWER                                                      */
  /* ================================================================ */

  async function showDdsViewer(file) {
    viewerMode = 'dds';

    const bytes = base64ToUint8(file.data);
    ddsData = decodeDDS(bytes);

    if (!ddsData) {
      showError('Invalid DDS', 'Failed to parse DDS file.');
      return;
    }

    ddsMipLevel = 0;
    ddsChannel = 'rgb';
    ddsTiling = false;

    const loading = $viewport.querySelector('.loading-container');
    if (loading) loading.remove();

    $welcomeScreen.style.display = 'none';
    $viewport.className = 'viewport checkerboard';
    $imageContainer.style.display = '';
    $imageContainer.innerHTML = '';

    const mip = ddsData.mipmaps[0];
    imgNaturalW = mip.width;
    imgNaturalH = mip.height;

    renderDdsToCanvas();
    buildDdsToolbar();
    updateMetadataBar({
      Dimensions: `${mip.width} × ${mip.height}`,
      Size: formatFileSize(file.size),
      Format: ddsData.formatName,
      Mipmaps: String(ddsData.mipmaps.length),
    });
    setHeaderContent(file.name, 'DDS', getFolderNameForPath(file.relativePath));
  }

  function renderDdsToCanvas() {
    if (!ddsData) return;

    const mip = ddsData.mipmaps[ddsMipLevel] || ddsData.mipmaps[0];
    const { width, height, rgba } = mip;
    imgNaturalW = width;
    imgNaturalH = height;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);

    // Apply channel isolation
    for (let i = 0; i < rgba.length; i += 4) {
      if (ddsChannel === 'rgb') {
        imageData.data[i]     = rgba[i];
        imageData.data[i + 1] = rgba[i + 1];
        imageData.data[i + 2] = rgba[i + 2];
        imageData.data[i + 3] = rgba[i + 3];
      } else if (ddsChannel === 'r') {
        imageData.data[i] = imageData.data[i + 1] = imageData.data[i + 2] = rgba[i];
        imageData.data[i + 3] = 255;
      } else if (ddsChannel === 'g') {
        imageData.data[i] = imageData.data[i + 1] = imageData.data[i + 2] = rgba[i + 1];
        imageData.data[i + 3] = 255;
      } else if (ddsChannel === 'b') {
        imageData.data[i] = imageData.data[i + 1] = imageData.data[i + 2] = rgba[i + 2];
        imageData.data[i + 3] = 255;
      } else if (ddsChannel === 'a') {
        imageData.data[i] = imageData.data[i + 1] = imageData.data[i + 2] = rgba[i + 3];
        imageData.data[i + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // If tiling, create 2x2 repeat
    let displayCanvas = canvas;
    if (ddsTiling) {
      displayCanvas = document.createElement('canvas');
      displayCanvas.width = width * 2;
      displayCanvas.height = height * 2;
      const tCtx = displayCanvas.getContext('2d');
      tCtx.drawImage(canvas, 0, 0);
      tCtx.drawImage(canvas, width, 0);
      tCtx.drawImage(canvas, 0, height);
      tCtx.drawImage(canvas, width, height);
      imgNaturalW = width * 2;
      imgNaturalH = height * 2;
    }

    $imageContainer.innerHTML = '';
    $imageContainer.appendChild(displayCanvas);
    void fitElementToViewport(displayCanvas);
    setupImageInteractions(displayCanvas);
  }

  function buildDdsToolbar() {
    const mipOptions = ddsData.mipmaps.map((m, i) =>
      `<option value="${i}" ${i === ddsMipLevel ? 'selected' : ''}>Mip ${i} (${m.width}×${m.height})</option>`
    ).join('');

    $toolbarCenter.innerHTML = `
      ${backButtonHtml()}
      <div class="channel-btns">
        <button class="channel-btn ${ddsChannel === 'rgb' ? 'active' : ''}" data-ch="rgb">RGB</button>
        <button class="channel-btn ${ddsChannel === 'r' ? 'active' : ''}" data-ch="r">R</button>
        <button class="channel-btn ${ddsChannel === 'g' ? 'active' : ''}" data-ch="g">G</button>
        <button class="channel-btn ${ddsChannel === 'b' ? 'active' : ''}" data-ch="b">B</button>
        <button class="channel-btn ${ddsChannel === 'a' ? 'active' : ''}" data-ch="a">A</button>
      </div>
      <div class="viewer-separator"></div>
      <select class="mip-select" id="mipSelect">${mipOptions}</select>
      <div class="viewer-separator"></div>
      <button class="viewer-btn ${ddsTiling ? 'active' : ''}" id="btnTile" title="Toggle tiling (T)">${ICONS.gridView}</button>
      <div class="viewer-separator"></div>
      <button class="viewer-btn" id="btnZoomOut" title="Zoom out">${ICONS.zoomOut}</button>
      <span class="zoom-label">${Math.round(imgZoom * 100)}%</span>
      <button class="viewer-btn" id="btnZoomIn" title="Zoom in">${ICONS.zoomIn}</button>
      <button class="viewer-btn" id="btnFitView" title="Fit to view (F)">${ICONS.maximize}</button>
    `;

    $toolbarRight.innerHTML = `
      <button class="viewer-btn" id="btnToggleInfo" title="Toggle info panel">${ICONS.info}</button>
    `;

    wireBackButton();
    // Channel buttons
    $toolbarCenter.querySelectorAll('.channel-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        ddsChannel = btn.dataset.ch;
        $toolbarCenter.querySelectorAll('.channel-btn').forEach(b => b.classList.toggle('active', b.dataset.ch === ddsChannel));
        renderDdsToCanvas();
      });
    });

    // Mip select
    $toolbarCenter.querySelector('#mipSelect').addEventListener('change', (e) => {
      ddsMipLevel = parseInt(e.target.value);
      renderDdsToCanvas();
      const mip = ddsData.mipmaps[ddsMipLevel];
      updateMetadataBar({
        Dimensions: `${mip.width} × ${mip.height}`,
        Size: formatFileSize(currentFile.size),
        Format: ddsData.formatName,
        Mipmaps: String(ddsData.mipmaps.length),
        'Current Mip': `${ddsMipLevel}`,
      });
    });

    // Tile toggle
    $toolbarCenter.querySelector('#btnTile').addEventListener('click', () => {
      ddsTiling = !ddsTiling;
      $toolbarCenter.querySelector('#btnTile').classList.toggle('active', ddsTiling);
      renderDdsToCanvas();
    });

    // Zoom
    $toolbarCenter.querySelector('#btnZoomIn').addEventListener('click', () => zoomImage(1.25));
    $toolbarCenter.querySelector('#btnZoomOut').addEventListener('click', () => zoomImage(1 / 1.25));
    $toolbarCenter.querySelector('#btnFitView').addEventListener('click', () => {
      const el = $imageContainer.querySelector('canvas');
      if (!el) return;
      void fitElementToViewport(el);
    });

    $toolbarRight.querySelector('#btnToggleInfo').addEventListener('click', toggleMetadataPanel);
  }

  /* ================================================================ */
  /*  3D VIEWER (three.js)                                            */
  /* ================================================================ */

  async function show3DViewer(file) {
    viewerMode = '3d';

    // Keep loading spinner visible until model is ready
    const loading = $viewport.querySelector('.loading-container');

    $welcomeScreen.style.display = 'none';
    $imageContainer.style.display = 'none';
    $viewport.className = 'viewport viewport-3d';

    // three.js libraries are loaded statically from viewer.html so the
    // extension asset URLs are rewritten correctly by the host.
    if (typeof THREE === 'undefined') {
      console.error('[Media Vault] THREE is undefined — three.min.js did not load');
      showError('three.js not available', 'The 3D viewer libraries failed to load in this extension tab.');
      return;
    }

    const ext = getFileExtension(file.name);

    // Diagnose which libraries loaded
    const libStatus = {
      THREE: typeof THREE !== 'undefined',
      OrbitControls: typeof THREE !== 'undefined' && typeof THREE.OrbitControls !== 'undefined',
      FBXLoader: typeof THREE !== 'undefined' && typeof THREE.FBXLoader !== 'undefined',
      OBJLoader: typeof THREE !== 'undefined' && typeof THREE.OBJLoader !== 'undefined',
      GLTFLoader: typeof THREE !== 'undefined' && typeof THREE.GLTFLoader !== 'undefined',
      fflate: typeof fflate !== 'undefined',
      WebGL: !!document.createElement('canvas').getContext('webgl2') || !!document.createElement('canvas').getContext('webgl'),
    };
    console.log('[Media Vault] 3D library status:', libStatus);

    if (!libStatus.OrbitControls) {
      showError('OrbitControls missing', 'The bundled OrbitControls script did not load.');
      return;
    }
    if (ext === '.fbx' && (!libStatus.fflate || !libStatus.FBXLoader)) {
      const missing = [];
      if (!libStatus.fflate) missing.push('fflate');
      if (!libStatus.FBXLoader) missing.push('FBXLoader');
      showError('FBX loader missing', `Missing: ${missing.join(', ')}. Check DevTools console for script load errors.`);
      return;
    }
    if (ext === '.obj' && !libStatus.OBJLoader) {
      showError('OBJ loader missing', 'The bundled OBJ loader script did not load.');
      return;
    }
    if ((ext === '.gltf' || ext === '.glb') && !libStatus.GLTFLoader) {
      showError('GLTF loader missing', 'The bundled GLTF loader script did not load.');
      return;
    }

    // Setup scene
    try {
      initThreeScene();
    } catch (e) {
      console.error('[Media Vault] initThreeScene failed:', e);
      showError('3D scene init failed', e.message || 'WebGL may not be available in this context.');
      return;
    }

    // Decode binary data
    console.log('[Media Vault] Decoding base64 data:', file.name, '(' + (file.data?.length || 0) + ' chars base64)');
    let bytes;
    try {
      bytes = base64ToUint8(file.data);
      console.log('[Media Vault] Decoded to', bytes.length, 'bytes');
    } catch (e) {
      console.error('[Media Vault] base64 decode failed:', e);
      showError('Failed to decode file', 'Could not decode the base64 data: ' + (e.message || 'unknown error'));
      return;
    }

    let objectUrl = null;

    try {
      let model;
      if (ext === '.fbx') {
        console.log('[Media Vault] Parsing FBX...');
        // Parse FBX immediately without waiting for sibling textures
        model = await loadFBX(bytes);
        console.log('[Media Vault] FBX parsed successfully');
        currentFbxRelativePath = file.relativePath;
        // Scan for sibling textures in the background (non-blocking)
        scanSiblingTextures(file.relativePath).then(matches => {
          siblingTextureMatches = matches;
          console.log('[Media Vault] Found', matches.size, 'sibling texture matches');
          if (metadataPanelVisible) buildMetadataPanel();
        }).catch(e => {
          console.warn('[Media Vault] Sibling texture scan failed:', e);
          siblingTextureMatches = new Map();
        });
      } else if (ext === '.obj') {
        objectUrl = URL.createObjectURL(new Blob([bytes]));
        model = await loadOBJ(objectUrl);
      } else if (ext === '.gltf' || ext === '.glb') {
        objectUrl = URL.createObjectURL(new Blob([bytes]));
        model = await loadGLTF(objectUrl, bytes);
      }

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }

      if (!model) {
        console.error('[Media Vault] Loader returned null/undefined model');
        showError('Failed to load model', 'The 3D loader returned no geometry.');
        return;
      }

      threeModel = model;

      // Ensure all meshes are double-sided and visible
      model.traverse((child) => {
        if (child.isMesh) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const m of mats) {
            if (m) m.side = THREE.DoubleSide;
          }
        }
      });

      threeScene.add(model);

      // Remove loading spinner now that model is in scene
      const loadingEl = $viewport.querySelector('.loading-container');
      if (loadingEl) loadingEl.remove();

      // Auto-frame
      autoFrameCamera(model);

      // Setup animations
      if (threeAnimations.length > 0) {
        setupAnimations();
      }

      // Stats (cache for reuse in buildMetadataPanel)
      const stats = countModelStats(model);
      cachedModelStats = stats;

      // Detect models with no renderable geometry (e.g. NURBS-only FBX files)
      if (stats.vertices === 0 && stats.faces === 0) {
        showError(
          'No renderable geometry',
          'This file was parsed successfully but contains no polygon mesh data. It may use unsupported geometry types (NURBS curves, splines, etc.).'
        );
        return;
      }

      updateStatsOverlay(stats);
      $statsOverlay.classList.add('visible');

      // Toolbar
      build3DToolbar();
      updateMetadataBar({
        Vertices: stats.vertices.toLocaleString(),
        Faces: stats.faces.toLocaleString(),
        Materials: String(stats.materials),
        Animations: String(threeAnimations.length),
        Format: ext.toUpperCase().replace('.', ''),
      });

      setHeaderContent(file.name, ext.replace('.', '').toUpperCase(), getFolderNameForPath(file.relativePath));

      console.log('[Media Vault] 3D viewer ready:', stats.vertices, 'verts,', stats.faces, 'faces');

      // Start render loop
      animate3D();
    } catch (e) {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      console.error('[Media Vault] 3D load failed:', e);
      showError('Failed to parse model', (e.message || 'Unknown error') + ' (see DevTools console for stack trace)');
    }
  }

  function initThreeScene() {
    threeScene = new THREE.Scene();
    threeScene.background = new THREE.Color(sceneSettings.bgColor);

    // Camera
    threeCamera = new THREE.PerspectiveCamera(sceneSettings.fov, $viewport.clientWidth / $viewport.clientHeight, 0.01, 10000);
    threeCamera.position.set(3, 2, 5);

    // Renderer
    threeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    threeRenderer.setSize($viewport.clientWidth, $viewport.clientHeight);
    threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    threeRenderer.setClearColor(sceneSettings.bgColor);
    threeRenderer.shadowMap.enabled = true;
    threeRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
    threeRenderer.outputEncoding = THREE.sRGBEncoding;
    applyToneMapping();

    const canvas = threeRenderer.domElement;
    canvas.className = 'three-canvas';
    $viewport.appendChild(canvas);

    // Lighting — stored for runtime adjustment
    lightAmbient = new THREE.AmbientLight(0xffffff, sceneSettings.ambientIntensity);
    threeScene.add(lightAmbient);

    lightKey = new THREE.DirectionalLight(new THREE.Color(sceneSettings.keyColor), sceneSettings.keyIntensity);
    lightKey.position.set(5, 10, 7);
    lightKey.castShadow = sceneSettings.groundShadow;
    lightKey.shadow.mapSize.width = 1024;
    lightKey.shadow.mapSize.height = 1024;
    threeScene.add(lightKey);

    lightFill = new THREE.DirectionalLight(0xffffff, sceneSettings.fillIntensity);
    lightFill.position.set(-5, 3, -5);
    threeScene.add(lightFill);

    lightHemi = new THREE.HemisphereLight(
      new THREE.Color(sceneSettings.hemiSkyColor),
      new THREE.Color(sceneSettings.hemiGroundColor),
      sceneSettings.hemiIntensity
    );
    threeScene.add(lightHemi);

    // Grid
    threeGridHelper = new THREE.GridHelper(10, 10, 0x333333, 0x333333);
    threeGridHelper.visible = sceneSettings.showGrid;
    threeScene.add(threeGridHelper);

    // Orbit controls
    threeControls = new THREE.OrbitControls(threeCamera, canvas);
    threeControls.enableDamping = true;
    threeControls.dampingFactor = 0.08;
    threeControls.screenSpacePanning = true;
    threeControls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };

    // Clock
    threeClock = new THREE.Clock();

    // Handle resize
    threeResizeObserver = new ResizeObserver(() => {
      const w = $viewport.clientWidth;
      const h = $viewport.clientHeight;
      threeCamera.aspect = w / h;
      threeCamera.updateProjectionMatrix();
      threeRenderer.setSize(w, h);
    });
    threeResizeObserver.observe($viewport);

    // Enable mesh selection via raycasting
    initRaycastListeners();
  }

  /* ---------------------------------------------------------------- */
  /*  Lighting Presets                                                 */
  /* ---------------------------------------------------------------- */

  const LIGHT_PRESETS = {
    studio:   { ambient: 0.4,  key: 0.7, fill: 0.2, hemi: 0.0,  keyColor: '#ffffff', hemiSky: '#87ceeb', hemiGnd: '#362907', bg: '#1a1a2e' },
    outdoor:  { ambient: 0.25, key: 0.9, fill: 0.1, hemi: 0.5,  keyColor: '#fffbe6', hemiSky: '#87ceeb', hemiGnd: '#5c4023', bg: '#4a6fa5' },
    dramatic: { ambient: 0.1,  key: 1.2, fill: 0.0, hemi: 0.0,  keyColor: '#ffd4a0', hemiSky: '#87ceeb', hemiGnd: '#362907', bg: '#0d0d0d' },
    neutral:  { ambient: 0.5,  key: 0.5, fill: 0.3, hemi: 0.15, keyColor: '#ffffff', hemiSky: '#ffffff', hemiGnd: '#444444', bg: '#2a2a2a' },
    warm:     { ambient: 0.35, key: 0.8, fill: 0.15,hemi: 0.2,  keyColor: '#ffccaa', hemiSky: '#ffe0c0', hemiGnd: '#3a2510', bg: '#1e1510' },
    cool:     { ambient: 0.35, key: 0.7, fill: 0.2, hemi: 0.25, keyColor: '#cce0ff', hemiSky: '#a0c0e8', hemiGnd: '#1a2030', bg: '#101828' },
  };

  function applyLightPreset(name) {
    const p = LIGHT_PRESETS[name];
    if (!p) return;
    sceneSettings.preset = name;
    sceneSettings.ambientIntensity = p.ambient;
    sceneSettings.keyIntensity = p.key;
    sceneSettings.keyColor = p.keyColor;
    sceneSettings.fillIntensity = p.fill;
    sceneSettings.hemiIntensity = p.hemi;
    sceneSettings.hemiSkyColor = p.hemiSky;
    sceneSettings.hemiGroundColor = p.hemiGnd;
    sceneSettings.bgColor = p.bg;
    syncSceneFromSettings();
  }

  function syncSceneFromSettings() {
    if (!threeRenderer) return;

    // Lights
    if (lightAmbient) lightAmbient.intensity = sceneSettings.ambientIntensity;
    if (lightKey) {
      lightKey.intensity = sceneSettings.keyIntensity;
      lightKey.color.set(sceneSettings.keyColor);
      lightKey.castShadow = sceneSettings.groundShadow;
    }
    if (lightFill) lightFill.intensity = sceneSettings.fillIntensity;
    if (lightHemi) {
      lightHemi.intensity = sceneSettings.hemiIntensity;
      lightHemi.color.set(sceneSettings.hemiSkyColor);
      lightHemi.groundColor.set(sceneSettings.hemiGroundColor);
    }

    // Background
    const bgCol = new THREE.Color(sceneSettings.bgColor);
    threeScene.background = bgCol;
    threeRenderer.setClearColor(bgCol);

    // Grid
    if (threeGridHelper) threeGridHelper.visible = sceneSettings.showGrid;

    // Axes
    if (sceneSettings.showAxes && !threeAxesHelper) {
      threeAxesHelper = new THREE.AxesHelper(5);
      threeScene.add(threeAxesHelper);
    } else if (!sceneSettings.showAxes && threeAxesHelper) {
      threeScene.remove(threeAxesHelper);
      threeAxesHelper.dispose();
      threeAxesHelper = null;
    }

    // Bounding box
    if (sceneSettings.showBBox && threeModel && !threeBBoxHelper) {
      threeBBoxHelper = new THREE.BoxHelper(threeModel, 0x00ff00);
      threeScene.add(threeBBoxHelper);
    } else if (!sceneSettings.showBBox && threeBBoxHelper) {
      threeScene.remove(threeBBoxHelper);
      threeBBoxHelper.dispose();
      threeBBoxHelper = null;
    }

    // Camera FOV
    if (threeCamera.isPerspectiveCamera) {
      threeCamera.fov = sceneSettings.fov;
      threeCamera.updateProjectionMatrix();
    }

    // Tone mapping
    applyToneMapping();

    // Refresh the settings UI if visible
    if (metadataPanelVisible && viewerMode === '3d') {
      buildMetadataPanel();
    }
  }

  function applyToneMapping() {
    if (!threeRenderer) return;
    const map = {
      'None': THREE.NoToneMapping,
      'Linear': THREE.LinearToneMapping,
      'Reinhard': THREE.ReinhardToneMapping,
      'ACES': THREE.ACESFilmicToneMapping,
    };
    threeRenderer.toneMapping = map[sceneSettings.toneMapping] || THREE.ACESFilmicToneMapping;
    threeRenderer.toneMappingExposure = sceneSettings.exposure;
  }

  // Store original materials for override restore
  const originalMaterials = new Map();

  function applyMaterialOverride() {
    if (!threeModel) return;

    threeModel.traverse((child) => {
      if (!child.isMesh) return;

      if (sceneSettings.materialOverride === 'none') {
        // Restore original
        if (originalMaterials.has(child.uuid)) {
          child.material = originalMaterials.get(child.uuid);
          originalMaterials.delete(child.uuid);
        }
      } else {
        // Save original if not saved
        if (!originalMaterials.has(child.uuid)) {
          originalMaterials.set(child.uuid, child.material);
        }

        switch (sceneSettings.materialOverride) {
          case 'normals':
            child.material = new THREE.MeshNormalMaterial();
            break;
          case 'flat-white':
            child.material = new THREE.MeshBasicMaterial({ color: 0xffffff });
            break;
          case 'matcap-clay':
            child.material = new THREE.MeshStandardMaterial({
              color: 0xb08060, roughness: 0.85, metalness: 0.0
            });
            break;
          case 'wireframe-colored':
            child.material = new THREE.MeshBasicMaterial({
              color: 0x00ff88, wireframe: true
            });
            break;
        }
      }
    });
  }

  /* ================================================================ */
  /*  Material Preset Library                                         */
  /* ================================================================ */

  const MATERIAL_PRESETS = {
    // Metals
    'polished-steel':  { label: 'Polished Steel',  cat: 'Metals', color: '#8a8a8a', roughness: 0.15, metalness: 1.0, clearcoat: 0.0 },
    'brushed-steel':   { label: 'Brushed Steel',   cat: 'Metals', color: '#7a7a7a', roughness: 0.4,  metalness: 1.0, clearcoat: 0.0 },
    'gold':            { label: 'Gold',            cat: 'Metals', color: '#d4a017', roughness: 0.2,  metalness: 1.0, clearcoat: 0.0 },
    'copper':          { label: 'Copper',          cat: 'Metals', color: '#b87333', roughness: 0.3,  metalness: 1.0, clearcoat: 0.0 },
    'chrome':          { label: 'Chrome',          cat: 'Metals', color: '#c0c0c0', roughness: 0.05, metalness: 1.0, clearcoat: 0.0 },
    'brass':           { label: 'Brass',           cat: 'Metals', color: '#c9a84c', roughness: 0.25, metalness: 1.0, clearcoat: 0.0 },
    'iron':            { label: 'Iron',            cat: 'Metals', color: '#48453e', roughness: 0.6,  metalness: 0.9, clearcoat: 0.0 },
    'titanium':        { label: 'Titanium',        cat: 'Metals', color: '#878681', roughness: 0.3,  metalness: 1.0, clearcoat: 0.0 },
    'aluminum':        { label: 'Aluminum',        cat: 'Metals', color: '#a8a9ad', roughness: 0.35, metalness: 1.0, clearcoat: 0.0 },
    // Plastics
    'glossy-red':      { label: 'Glossy Red',      cat: 'Plastics', color: '#cc2222', roughness: 0.1,  metalness: 0.0, clearcoat: 0.8 },
    'glossy-blue':     { label: 'Glossy Blue',     cat: 'Plastics', color: '#2255cc', roughness: 0.1,  metalness: 0.0, clearcoat: 0.8 },
    'matte-black':     { label: 'Matte Black',     cat: 'Plastics', color: '#1a1a1a', roughness: 0.9,  metalness: 0.0, clearcoat: 0.0 },
    'matte-white':     { label: 'Matte White',     cat: 'Plastics', color: '#f0f0f0', roughness: 0.85, metalness: 0.0, clearcoat: 0.0 },
    'rubber':          { label: 'Rubber',          cat: 'Plastics', color: '#222222', roughness: 0.95, metalness: 0.0, clearcoat: 0.0 },
    'translucent':     { label: 'Translucent',     cat: 'Plastics', color: '#ddddee', roughness: 0.3,  metalness: 0.0, clearcoat: 0.0, opacity: 0.5 },
    // Natural
    'oak':             { label: 'Oak',             cat: 'Natural', color: '#a0783c', roughness: 0.7,  metalness: 0.0, clearcoat: 0.1 },
    'walnut':          { label: 'Walnut',          cat: 'Natural', color: '#5c3a1e', roughness: 0.65, metalness: 0.0, clearcoat: 0.1 },
    'marble-white':    { label: 'White Marble',    cat: 'Natural', color: '#e8e0d8', roughness: 0.2,  metalness: 0.0, clearcoat: 0.3 },
    'concrete':        { label: 'Concrete',        cat: 'Natural', color: '#8a8a80', roughness: 0.95, metalness: 0.0, clearcoat: 0.0 },
    'terracotta':      { label: 'Terracotta',      cat: 'Natural', color: '#c4663a', roughness: 0.8,  metalness: 0.0, clearcoat: 0.0 },
    // Glass
    'clear-glass':     { label: 'Clear Glass',     cat: 'Glass', color: '#ffffff', roughness: 0.0,  metalness: 0.0, clearcoat: 1.0, opacity: 0.2 },
    'frosted-glass':   { label: 'Frosted Glass',   cat: 'Glass', color: '#e8eef0', roughness: 0.6,  metalness: 0.0, clearcoat: 0.5, opacity: 0.4 },
    'tinted-glass':    { label: 'Tinted Glass',    cat: 'Glass', color: '#334455', roughness: 0.05, metalness: 0.0, clearcoat: 1.0, opacity: 0.3 },
    // Special
    'emissive-white':  { label: 'Emissive White',  cat: 'Special', color: '#ffffff', roughness: 1.0,  metalness: 0.0, clearcoat: 0.0, emissive: '#ffffff', emissiveIntensity: 1.0 },
    'emissive-neon':   { label: 'Neon Green',      cat: 'Special', color: '#000000', roughness: 0.5,  metalness: 0.0, clearcoat: 0.0, emissive: '#00ff66', emissiveIntensity: 2.0 },
    'porcelain':       { label: 'Porcelain',       cat: 'Special', color: '#f5f0e8', roughness: 0.15, metalness: 0.0, clearcoat: 0.6 },
  };

  function ensurePhysicalMaterial(mesh) {
    // Handle multi-material: convert first material but keep array structure
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map(m =>
        m && m.isMeshPhysicalMaterial ? m : convertToPhysical(m)
      );
      // Save original if not saved
      if (!originalMaterials.has(mesh.uuid)) {
        originalMaterials.set(mesh.uuid, mesh.material);
      }
      return mesh.material[0];
    }

    if (mesh.material && mesh.material.isMeshPhysicalMaterial) return mesh.material;

    // Save original if not saved
    if (!originalMaterials.has(mesh.uuid)) {
      originalMaterials.set(mesh.uuid, mesh.material);
    }

    const mat = convertToPhysical(mesh.material);
    mesh.material = mat;
    return mat;
  }

  function convertToPhysical(old) {
    const mat = new THREE.MeshPhysicalMaterial({
      color: old?.color ? old.color.clone() : new THREE.Color(0xcccccc),
      roughness: old?.roughness ?? 0.5,
      metalness: old?.metalness ?? 0.0,
      clearcoat: 0,
      clearcoatRoughness: 0,
      transparent: old?.transparent ?? false,
      opacity: old?.opacity ?? 1.0,
    });

    // Preserve render state
    mat.side = old?.side ?? THREE.FrontSide;
    mat.alphaTest = old?.alphaTest ?? 0;
    mat.depthWrite = old?.depthWrite ?? true;
    mat.name = old?.name ?? '';
    if (old?.vertexColors) mat.vertexColors = old.vertexColors;
    if (old?.normalScale) mat.normalScale.copy(old.normalScale);

    // Copy maps if present
    if (old?.map) mat.map = old.map;
    if (old?.normalMap) mat.normalMap = old.normalMap;
    if (old?.roughnessMap) mat.roughnessMap = old.roughnessMap;
    if (old?.metalnessMap) mat.metalnessMap = old.metalnessMap;
    if (old?.emissiveMap) mat.emissiveMap = old.emissiveMap;
    if (old?.alphaMap) mat.alphaMap = old.alphaMap;
    if (old?.emissive) mat.emissive.copy(old.emissive);
    mat.emissiveIntensity = old?.emissiveIntensity ?? 0;

    return mat;
  }

  function applyPresetToMesh(mesh, presetKey) {
    const p = MATERIAL_PRESETS[presetKey];
    if (!p) return;

    const mat = ensurePhysicalMaterial(mesh);
    mat.color.set(p.color);
    mat.roughness = p.roughness;
    mat.metalness = p.metalness;
    mat.clearcoat = p.clearcoat || 0;
    mat.clearcoatRoughness = 0;
    mat.emissive.set(p.emissive || '#000000');
    mat.emissiveIntensity = p.emissiveIntensity || 0;
    mat.opacity = p.opacity ?? 1.0;
    mat.transparent = (p.opacity ?? 1.0) < 1.0;
    mat.needsUpdate = true;
  }

  function applyPresetGlobally(presetKey) {
    if (!threeModel) return;
    threeModel.traverse((child) => {
      if (child.isMesh && child.name !== '__wireframeOverlay') {
        applyPresetToMesh(child, presetKey);
      }
    });
  }

  /* ================================================================ */
  /*  Mesh Selection (Raycasting)                                     */
  /* ================================================================ */

  function initRaycastListeners() {
    if (!threeRenderer) return;
    const canvas = threeRenderer.domElement;
    raycaster = new THREE.Raycaster();
    mouseNDC = new THREE.Vector2();

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // Only left-click selects meshes
      pointerDownPos.x = e.clientX;
      pointerDownPos.y = e.clientY;
      isPointerDownForSelect = true;
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!isPointerDownForSelect) return;
      const dx = e.clientX - pointerDownPos.x;
      const dy = e.clientY - pointerDownPos.y;
      if (dx * dx + dy * dy > 16) { // 4px threshold
        isPointerDownForSelect = false;
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      if (!isPointerDownForSelect) return;
      isPointerDownForSelect = false;
      performRaycast(e);
    });
  }

  function performRaycast(event) {
    if (!threeModel || !raycaster || !threeCamera) return;

    const canvas = threeRenderer.domElement;
    const rect = canvas.getBoundingClientRect();
    mouseNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouseNDC.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouseNDC, threeCamera);
    const intersects = raycaster.intersectObject(threeModel, true);

    // Filter out wireframe overlays and selection highlights
    const hit = intersects.find(i =>
      i.object.isMesh &&
      i.object.name !== '__wireframeOverlay' &&
      i.object !== selectionOutline
    );

    if (hit) {
      if (hit.object === selectedMesh) {
        deselectMesh();
      } else {
        selectMesh(hit.object);
      }
    } else {
      deselectMesh();
    }
  }

  function selectMesh(mesh) {
    deselectMesh();
    selectedMesh = mesh;
    createSelectionHighlight(mesh);

    // Show info panel and rebuild with per-mesh editor
    if (!metadataPanelVisible) {
      metadataPanelVisible = true;
      $metadataPanel.classList.add('visible');
    }
    buildMetadataPanel();
  }

  function deselectMesh() {
    if (!selectedMesh) return;
    removeSelectionHighlight();
    selectedMesh = null;

    if (metadataPanelVisible) {
      buildMetadataPanel();
    }
  }

  function createSelectionHighlight(mesh) {
    removeSelectionHighlight();
    try {
      const edges = new THREE.EdgesGeometry(mesh.geometry, 30);
      selectionOutline = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0xa3e635, linewidth: 2, transparent: true, opacity: 0.8 })
      );
      selectionOutline.name = '__selectionHighlight';
      selectionOutline.raycast = () => {}; // not selectable
      mesh.add(selectionOutline);
    } catch (_) {
      // Silently fail if edges can't be computed
    }
  }

  function removeSelectionHighlight() {
    if (selectionOutline && selectionOutline.parent) {
      selectionOutline.parent.remove(selectionOutline);
      selectionOutline.geometry.dispose();
      selectionOutline.material.dispose();
    }
    selectionOutline = null;
  }

  /* ================================================================ */
  /*  PBR Material Editor (per-mesh)                                  */
  /* ================================================================ */

  function getMeshMaterialProps(mesh) {
    const mat = mesh.material;
    return {
      color: '#' + (mat.color ? mat.color.getHexString() : 'cccccc'),
      roughness: mat.roughness ?? 0.5,
      metalness: mat.metalness ?? 0.0,
      emissive: '#' + (mat.emissive ? mat.emissive.getHexString() : '000000'),
      emissiveIntensity: mat.emissiveIntensity ?? 0,
      clearcoat: mat.clearcoat ?? 0,
      clearcoatRoughness: mat.clearcoatRoughness ?? 0,
      opacity: mat.opacity ?? 1.0,
    };
  }

  function buildMaterialSectionHTML() {
    if (selectedMesh) {
      return buildPerMeshEditorHTML(selectedMesh);
    }
    return buildGlobalMaterialHTML();
  }

  function buildGlobalMaterialHTML() {
    const presetOpts = buildPresetOptionsHTML();
    const overrideOptions = [
      ['none', 'Original'],
      ['normals', 'Normals'],
      ['matcap-clay', 'Clay'],
      ['flat-white', 'Flat White'],
      ['wireframe-colored', 'Wireframe (Color)'],
    ].map(([v, l]) =>
      `<option value="${v}" ${sceneSettings.materialOverride === v ? 'selected' : ''}>${l}</option>`
    ).join('');

    // List materials found in the model
    let matListHTML = '';
    if (threeModel) {
      const matSet = new Map();
      threeModel.traverse((child) => {
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (m && !matSet.has(m.uuid)) {
            matSet.set(m.uuid, {
              name: m.name || '(unnamed)',
              type: m.type || 'Unknown',
              color: m.color ? '#' + m.color.getHexString() : null,
              hasMap: !!m.map,
              hasNormal: !!m.normalMap,
            });
          }
        }
      });
      if (matSet.size > 0) {
        matListHTML = '<div class="mat-list-header">Model Materials</div>';
        for (const [uuid, info] of matSet) {
          const swatch = info.color ? `<span class="mat-swatch" style="background:${info.color}"></span>` : '';
          const texBadge = info.hasMap ? ' <span class="mat-badge">TEX</span>' : '';
          const normBadge = info.hasNormal ? ' <span class="mat-badge">NRM</span>' : '';
          matListHTML += `<div class="mat-list-item mat-list-clickable" data-mat-uuid="${uuid}">${swatch}<span class="mat-list-name">${escapeHtml(info.name)}</span><span class="mat-list-type">${info.type.replace('Mesh', '').replace('Material', '')}${texBadge}${normBadge}</span></div>`;
        }
      }
    }

    return `
      <div class="scene-row">
        <label>Override</label>
        <select class="scene-select" id="scMaterial">${overrideOptions}</select>
      </div>
      <div class="scene-row">
        <label>Preset</label>
        <select class="scene-select" id="scPresetMat"><option value="">— Pick —</option>${presetOpts}</select>
      </div>
      ${matListHTML}
      <div class="material-tip">Click a mesh in the viewport to edit individually</div>
    `;
  }

  function buildPerMeshEditorHTML(mesh) {
    const p = getMeshMaterialProps(mesh);
    const meshName = mesh.name || 'Unnamed Mesh';
    const presetOpts = buildPresetOptionsHTML();

    const textureSlots = ['albedo', 'normal', 'roughness', 'metalness', 'emissive'];
    const mapKeys = { albedo: 'map', normal: 'normalMap', roughness: 'roughnessMap', metalness: 'metalnessMap', emissive: 'emissiveMap' };
    const slotLabels = { albedo: 'Color', normal: 'Normal', roughness: 'Roughness', metalness: 'Metalness', emissive: 'Emissive' };
    const textureHTML = textureSlots.map(slot => {
      const tex = mesh.material[mapKeys[slot]];
      const hasTexture = !!tex;
      const thumbStyle = hasTexture ? 'background: var(--accent); opacity: 0.6;' : '';
      return `
        <div class="texture-slot-row">
          <span class="texture-slot-label">${slotLabels[slot] || slot}</span>
          <span class="texture-thumb" style="${thumbStyle}">${hasTexture ? '✓' : ''}</span>
          <button class="texture-browse-btn" data-slot="${slot}" title="Browse workspace for texture">Browse</button>
          ${hasTexture ? `<button class="texture-clear-btn" data-slot="${slot}" title="Clear texture">✕</button>` : ''}
        </div>
      `;
    }).join('');

    return `
      <div class="material-selected-header">
        <span class="material-mesh-name" title="${escapeHtml(meshName)}">${escapeHtml(meshName)}</span>
        <button class="mat-deselect-btn" id="btnDeselectMesh" title="Deselect">✕</button>
      </div>
      <div class="scene-row">
        <label>Preset</label>
        <select class="scene-select" id="scMeshPreset"><option value="">— Pick —</option>${presetOpts}</select>
      </div>
      <div class="scene-row">
        <label>Color</label>
        <input type="color" class="scene-color" id="matColor" value="${p.color}">
      </div>
      <div class="scene-row">
        <label>Roughness</label>
        <input type="range" class="scene-slider" id="matRoughness" min="0" max="1" step="0.01" value="${p.roughness}">
        <span class="scene-val" id="matRoughnessVal">${p.roughness.toFixed(2)}</span>
      </div>
      <div class="scene-row">
        <label>Metalness</label>
        <input type="range" class="scene-slider" id="matMetalness" min="0" max="1" step="0.01" value="${p.metalness}">
        <span class="scene-val" id="matMetalnessVal">${p.metalness.toFixed(2)}</span>
      </div>
      <div class="scene-row">
        <label>Emissive</label>
        <input type="color" class="scene-color" id="matEmissive" value="${p.emissive}">
      </div>
      <div class="scene-row">
        <label>Emissive Int.</label>
        <input type="range" class="scene-slider" id="matEmissiveInt" min="0" max="5" step="0.05" value="${p.emissiveIntensity}">
        <span class="scene-val" id="matEmissiveIntVal">${p.emissiveIntensity.toFixed(2)}</span>
      </div>
      <div class="scene-row">
        <label>Clearcoat</label>
        <input type="range" class="scene-slider" id="matClearcoat" min="0" max="1" step="0.01" value="${p.clearcoat}">
        <span class="scene-val" id="matClearcoatVal">${p.clearcoat.toFixed(2)}</span>
      </div>
      <div class="scene-row">
        <label>Opacity</label>
        <input type="range" class="scene-slider" id="matOpacity" min="0" max="1" step="0.01" value="${p.opacity}">
        <span class="scene-val" id="matOpacityVal">${p.opacity.toFixed(2)}</span>
      </div>

      <h3 class="scene-section-toggle" data-section="textures">Textures</h3>
      <div class="scene-section" id="sec-textures">
        ${textureHTML}
      </div>

      <button class="mat-action-btn mat-reset-btn" id="btnResetMat">Reset to Original</button>
    `;
  }

  function buildPresetOptionsHTML() {
    const cats = {};
    for (const [key, p] of Object.entries(MATERIAL_PRESETS)) {
      if (!cats[p.cat]) cats[p.cat] = [];
      cats[p.cat].push({ key, label: p.label });
    }
    return Object.entries(cats).map(([cat, items]) =>
      `<optgroup label="${cat}">${items.map(i => `<option value="${i.key}">${i.label}</option>`).join('')}</optgroup>`
    ).join('');
  }

  function bindMaterialSectionEvents() {
    if (selectedMesh) {
      bindPerMeshEditorEvents(selectedMesh);
    } else {
      bindGlobalMaterialEvents();
    }
  }

  function bindGlobalMaterialEvents() {
    const matEl = document.getElementById('scMaterial');
    if (matEl) {
      const applyOverride = () => {
        sceneSettings.materialOverride = matEl.value;
        applyMaterialOverride();
      };
      matEl.addEventListener('change', applyOverride);
    }

    const presetEl = document.getElementById('scPresetMat');
    if (presetEl) {
      const applyPreset = () => {
        if (!presetEl.value) return;
        // Reset override so preset is visible
        sceneSettings.materialOverride = 'none';
        if (matEl) matEl.value = 'none';
        applyMaterialOverride();
        applyPresetGlobally(presetEl.value);
      };
      presetEl.addEventListener('change', applyPreset);
    }

    const btnApplyChecked = document.getElementById('btnApplyCheckedTex');
    if (btnApplyChecked) {
      btnApplyChecked.addEventListener('click', async () => {
        if (!threeModel) return;
        const checks = $metadataPanel.querySelectorAll('.stc-check:checked');
        const slots = Array.from(checks).map(c => c.dataset.slot);
        if (slots.length === 0) return;
        btnApplyChecked.disabled = true;
        btnApplyChecked.textContent = 'Loading...';
        try {
          await applySelectedTextures(threeModel, slots);
          buildMetadataPanel();
        } catch (e) {
          console.error('[Media Vault] Apply selected textures failed:', e);
        }
      });
    }

    // Material list click — select first mesh using that material
    $metadataPanel.querySelectorAll('.mat-list-clickable').forEach(item => {
      item.addEventListener('click', () => {
        const matUuid = item.dataset.matUuid;
        if (!threeModel || !matUuid) return;
        let found = null;
        threeModel.traverse((child) => {
          if (found || !child.isMesh) return;
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          if (mats.some(m => m && m.uuid === matUuid)) found = child;
        });
        if (found) selectMesh(found);
      });
    });
  }

  function bindPerMeshEditorEvents(mesh) {
    // Deselect
    const btnDeselect = document.getElementById('btnDeselectMesh');
    if (btnDeselect) btnDeselect.addEventListener('click', deselectMesh);

    // Preset
    const presetEl = document.getElementById('scMeshPreset');
    if (presetEl) presetEl.addEventListener('change', () => {
      if (presetEl.value) {
        applyPresetToMesh(mesh, presetEl.value);
        buildMetadataPanel(); // refresh sliders to reflect preset values
      }
    });

    // PBR sliders
    const mat = ensurePhysicalMaterial(mesh);

    function bindMatSlider(id, valId, prop, fmt) {
      const el = document.getElementById(id);
      const valEl = document.getElementById(valId);
      if (!el) return;
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        mat[prop] = v;
        if (prop === 'opacity') mat.transparent = v < 1.0;
        mat.needsUpdate = true;
        if (valEl) valEl.textContent = fmt ? fmt(v) : v.toFixed(2);
      });
    }

    bindMatSlider('matRoughness', 'matRoughnessVal', 'roughness');
    bindMatSlider('matMetalness', 'matMetalnessVal', 'metalness');
    bindMatSlider('matEmissiveInt', 'matEmissiveIntVal', 'emissiveIntensity');
    bindMatSlider('matClearcoat', 'matClearcoatVal', 'clearcoat');
    bindMatSlider('matOpacity', 'matOpacityVal', 'opacity');

    // Colors
    const colorEl = document.getElementById('matColor');
    if (colorEl) colorEl.addEventListener('input', () => {
      mat.color.set(colorEl.value);
      mat.needsUpdate = true;
    });

    const emissiveEl = document.getElementById('matEmissive');
    if (emissiveEl) emissiveEl.addEventListener('input', () => {
      mat.emissive.set(emissiveEl.value);
      mat.needsUpdate = true;
    });

    // Reset
    const resetBtn = document.getElementById('btnResetMat');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      if (originalMaterials.has(mesh.uuid)) {
        mesh.material = originalMaterials.get(mesh.uuid);
        originalMaterials.delete(mesh.uuid);
      }
      meshMaterialEdits.delete(mesh.uuid);
      buildMetadataPanel();
    });

    // Texture browse buttons
    $metadataPanel.querySelectorAll('.texture-browse-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        openTexturePicker(btn.dataset.slot, mesh);
      });
    });

    // Texture clear buttons
    $metadataPanel.querySelectorAll('.texture-clear-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        clearTextureSlot(mesh, btn.dataset.slot);
        buildMetadataPanel();
      });
    });

    // Texture section toggle
    const texToggle = $metadataPanel.querySelector('.scene-section-toggle[data-section="textures"]');
    if (texToggle) {
      texToggle.addEventListener('click', () => {
        const sec = document.getElementById('sec-textures');
        if (sec) {
          sec.classList.toggle('collapsed');
          texToggle.classList.toggle('collapsed');
        }
      });
    }
  }

  /* ================================================================ */
  /*  Texture Loading from Workspace                                  */
  /* ================================================================ */

  const TEX_MAP_KEYS = {
    albedo: 'map', normal: 'normalMap', roughness: 'roughnessMap',
    metalness: 'metalnessMap', emissive: 'emissiveMap',
  };

  const TEX_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tga', '.dds'];

  async function openTexturePicker(slot, mesh) {
    // Fetch workspace image files if not cached
    if (!workspaceImageFiles) {
      try {
        const allFiles = await getCachedFileList();
        workspaceImageFiles = allFiles.filter(f =>
          f.type !== 'directory' && TEX_IMAGE_EXTS.includes(getFileExtension(f.name))
        );
      } catch (e) {
        console.error('[Media Vault] Failed to list workspace files for texture picker:', e);
        workspaceImageFiles = [];
      }
    }

    showTexturePickerModal(slot, mesh);
  }

  function showTexturePickerModal(slot, mesh) {
    // Remove existing modal
    dismissTexturePickerModal();

    const modal = document.createElement('div');
    modal.className = 'texture-picker-modal';
    modal.id = 'texturePickerModal';

    // Determine the FBX's directory to prioritize sibling files
    let fbxDir = '';
    if (currentFile && currentFile.relativePath) {
      const lastSlash = currentFile.relativePath.lastIndexOf('/');
      fbxDir = lastSlash >= 0 ? currentFile.relativePath.substring(0, lastSlash) : '';
    }
    const fbxPrefix = fbxDir ? fbxDir + '/' : '';

    // Sort: sibling files first, then everything else
    const sorted = [...workspaceImageFiles].sort((a, b) => {
      const aLocal = fbxPrefix ? a.relativePath.startsWith(fbxPrefix) : false;
      const bLocal = fbxPrefix ? b.relativePath.startsWith(fbxPrefix) : false;
      if (aLocal && !bLocal) return -1;
      if (!aLocal && bLocal) return 1;
      return a.name.localeCompare(b.name);
    });

    const slotLabel = slot.charAt(0).toUpperCase() + slot.slice(1);
    let html = `
      <div class="texture-picker-header">
        <span>Pick ${slotLabel} Texture</span>
        <button class="mat-deselect-btn" id="btnCloseTexPicker" title="Close">✕</button>
      </div>
      <input type="text" class="texture-picker-search" id="texPickerSearch" placeholder="Filter files..." value="${escapeHtml(fbxDir)}">
      <div class="texture-picker-list" id="texPickerList">
    `;

    if (sorted.length === 0) {
      html += '<div class="texture-picker-empty">No image files found in workspace</div>';
    } else {
      for (const f of sorted) {
        const isLocal = fbxPrefix && f.relativePath.startsWith(fbxPrefix);
        html += `<div class="texture-picker-item${isLocal ? ' tpi-local' : ''}" data-path="${escapeHtml(f.relativePath)}" title="${escapeHtml(f.relativePath)}" style="${!fbxPrefix || isLocal ? '' : 'display:none'}">
          <span class="tpi-icon">${ICONS.image}</span>
          <span class="tpi-name">${escapeHtml(f.name)}</span>
          <span class="tpi-path">${escapeHtml(getDirectory(f.relativePath))}</span>
        </div>`;
      }
    }

    html += '</div>';
    modal.innerHTML = html;
    $viewport.appendChild(modal);

    // Close button
    document.getElementById('btnCloseTexPicker').addEventListener('click', dismissTexturePickerModal);

    // Search filter
    const searchEl = document.getElementById('texPickerSearch');
    searchEl.addEventListener('input', () => {
      const q = searchEl.value.toLowerCase();
      document.querySelectorAll('.texture-picker-item').forEach(item => {
        item.style.display = (item.dataset.path.toLowerCase().includes(q) || !q) ? '' : 'none';
      });
    });

    // Item clicks
    document.querySelectorAll('.texture-picker-item').forEach(item => {
      item.addEventListener('click', async () => {
        const path = item.dataset.path;
        dismissTexturePickerModal();

        try {
          const texture = await loadTextureFromWorkspace(path, slot);
          assignTextureToSlot(mesh, slot, texture, path);
          buildMetadataPanel();
        } catch (e) {
          console.error('[Media Vault] Failed to load texture:', e);
        }
      });
    });

    searchEl.focus();
  }

  function dismissTexturePickerModal() {
    const existing = document.getElementById('texturePickerModal');
    if (existing) existing.remove();
  }

  async function loadTextureFromWorkspace(filePath, slot) {
    // Check cache
    if (loadedTextures.has(filePath)) return loadedTextures.get(filePath);

    const file = await api.workspace.readBinaryFile(filePath);
    const bytes = base64ToUint8(file.data);
    const ext = getFileExtension(filePath);

    let texture;

    if (ext === '.dds') {
      // Decode DDS → RGBA → canvas texture
      const dds = decodeDDS(bytes);
      if (!dds || dds.mipmaps.length === 0) throw new Error('Failed to decode DDS');
      const mip = dds.mipmaps[0];
      const canvas = document.createElement('canvas');
      canvas.width = mip.width;
      canvas.height = mip.height;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.createImageData(mip.width, mip.height);
      imgData.data.set(mip.rgba);
      ctx.putImageData(imgData, 0, 0);
      texture = new THREE.Texture(canvas);
    } else if (ext === '.tga') {
      // Decode TGA → RGBA → canvas texture
      const tga = decodeTGA(bytes);
      if (!tga) throw new Error('Failed to decode TGA');
      const canvas = document.createElement('canvas');
      canvas.width = tga.width;
      canvas.height = tga.height;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.createImageData(tga.width, tga.height);
      imgData.data.set(tga.rgba);
      ctx.putImageData(imgData, 0, 0);
      texture = new THREE.Texture(canvas);
    } else {
      // Standard web image (PNG, JPG, etc.)
      const dataUrl = `data:${file.mimeType || 'image/png'};base64,${file.data}`;
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Failed to decode texture image'));
        img.src = dataUrl;
      });
      texture = new THREE.Texture(img);
    }

    texture.needsUpdate = true;

    // sRGB for color data (albedo, emissive), linear for data channels
    if (slot === 'albedo' || slot === 'emissive') {
      texture.encoding = THREE.sRGBEncoding;
    } else {
      texture.encoding = THREE.LinearEncoding;
    }

    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;

    loadedTextures.set(filePath, texture);
    return texture;
  }

  function assignTextureToSlot(mesh, slot, texture, filePath) {
    ensurePhysicalMaterial(mesh);
    const mapKey = TEX_MAP_KEYS[slot];
    if (!mapKey) return;

    // Handle multi-material meshes
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      mat[mapKey] = texture;
      mat.needsUpdate = true;
    }

    // Track edit
    if (!meshMaterialEdits.has(mesh.uuid)) {
      meshMaterialEdits.set(mesh.uuid, { textures: {} });
    }
    const edits = meshMaterialEdits.get(mesh.uuid);
    if (!edits.textures) edits.textures = {};
    edits.textures[slot] = filePath;
  }

  /**
   * Auto-assign sibling textures by naming convention when the FBX
   * has no embedded texture references. Matches patterns like:
   *   *_Color.DDS → albedo, *_Normal.DDS → normal, *_Emissive.DDS → emissive, *_Alpha.DDS → alpha
   */
  /** Scan sibling texture files and match by naming convention. Returns Map<slot, file>. */
  async function scanSiblingTextures(fbxRelativePath) {
    const lastSlash = fbxRelativePath.lastIndexOf('/');
    const dir = lastSlash >= 0 ? fbxRelativePath.substring(0, lastSlash) : '';
    const prefix = dir ? dir + '/' : '';

    const allFiles = await getCachedFileList();
    const TEX_EXTS = ['.dds', '.tga', '.png', '.jpg', '.jpeg'];
    const siblings = allFiles.filter(f => {
      if (f.type === 'directory') return false;
      if (!f.relativePath.startsWith(prefix)) return false;
      const rest = f.relativePath.substring(prefix.length);
      if (rest.includes('/')) return false;
      return TEX_EXTS.includes(getFileExtension(f.name));
    });

    const CONVENTION_MAP = {
      color: 'albedo', diffuse: 'albedo', albedo: 'albedo',
      normal: 'normal', nrm: 'normal',
      emissive: 'emissive', emission: 'emissive', glow: 'emissive',
      alpha: 'alpha', opacity: 'alpha', transparency: 'alpha',
      property: 'property',
    };

    const matched = new Map();
    for (const sib of siblings) {
      const nameLower = sib.name.toLowerCase();
      for (const [pattern, slot] of Object.entries(CONVENTION_MAP)) {
        if (nameLower.includes('_' + pattern + '.') || nameLower.includes('_' + pattern + '_')) {
          if (!matched.has(slot)) {
            matched.set(slot, sib);
          }
        }
      }
    }
    return matched;
  }

  /** Apply selected texture slots to all meshes on the model. */
  async function applySelectedTextures(model, slots) {
    if (!model || !siblingTextureMatches) return;
    for (const slot of slots) {
      const sib = siblingTextureMatches.get(slot);
      if (!sib) continue;
      try {
        const texture = await loadTextureFromWorkspace(sib.relativePath, slot);
        model.traverse((child) => {
          if (!child.isMesh || child.name === '__wireframeOverlay') return;
          assignTextureToSlot(child, slot, texture, sib.relativePath);
        });
        console.log('[Media Vault] Applied', slot, ':', sib.name);
      } catch (e) {
        console.warn('[Media Vault] Failed to apply', slot, ':', e);
      }
    }
  }

  function clearTextureSlot(mesh, slot) {
    const mapKey = TEX_MAP_KEYS[slot];
    if (!mapKey || !mesh.material) return;

    if (mesh.material[mapKey]) {
      mesh.material[mapKey] = null;
      mesh.material.needsUpdate = true;
    }

    const edits = meshMaterialEdits.get(mesh.uuid);
    if (edits?.textures) delete edits.textures[slot];
  }

  function autoFrameCamera(object) {
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 1.5;

    // Adjust near/far planes to fit the model regardless of scale
    // (FBX files can be in mm, cm, m, or arbitrary units)
    threeCamera.near = Math.max(maxDim * 0.0001, 0.001);
    threeCamera.far = Math.max(maxDim * 100, 10000);
    threeCamera.updateProjectionMatrix();

    threeCamera.position.set(center.x + dist * 0.5, center.y + dist * 0.4, center.z + dist * 0.5);
    threeCamera.lookAt(center);
    threeControls.target.copy(center);
    threeControls.update();

    // Adjust grid to model scale
    threeGridHelper.scale.set(maxDim / 5, 1, maxDim / 5);
    threeGridHelper.position.y = box.min.y;
  }

  function animate3D() {
    if (viewerMode !== '3d' || !threeRenderer) return;
    requestAnimationFrame(animate3D);

    const delta = threeClock.getDelta();
    if (threeMixer && threeAnimPlaying) {
      threeMixer.update(delta);
      updateAnimTimeline();
    }

    threeControls.update();
    threeRenderer.render(threeScene, threeCamera);
  }

  /* ---------------------------------------------------------------- */
  /*  3D Loaders                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * DDS texture handler for Three.js LoadingManager.
   * Fetches a DDS blob URL, decodes via our software decoder, and creates
   * a canvas-backed THREE.Texture. Registered with manager.addHandler(/\.dds$/i, ...).
   */
  function createDDSTextureHandler(manager) {
    return {
      path: '',
      setPath(p) { this.path = p; return this; },
      load(url, onLoad, onProgress, onError) {
        // Apply the manager's URL modifier (maps filename → blob URL)
        const resolvedUrl = manager.resolveURL(url);
        const texture = new THREE.Texture();

        fetch(resolvedUrl)
          .then(r => r.arrayBuffer())
          .then(buffer => {
            const bytes = new Uint8Array(buffer);
            const dds = decodeDDS(bytes);
            if (!dds || dds.mipmaps.length === 0) {
              console.warn('[Media Vault] DDS decode failed for', url);
              if (onError) onError(new Error('DDS decode failed'));
              return;
            }
            const mip = dds.mipmaps[0];
            const canvas = document.createElement('canvas');
            canvas.width = mip.width;
            canvas.height = mip.height;
            const ctx = canvas.getContext('2d');
            const imgData = ctx.createImageData(mip.width, mip.height);
            imgData.data.set(mip.rgba);
            ctx.putImageData(imgData, 0, 0);

            texture.image = canvas;
            texture.needsUpdate = true;
            if (onLoad) onLoad(texture);
          })
          .catch(err => {
            console.warn('[Media Vault] DDS handler fetch failed:', err);
            if (onError) onError(err);
          });

        return texture;
      }
    };
  }

  /**
   * TGA texture handler for Three.js LoadingManager.
   * Same pattern as DDS — fetches blob URL, decodes via our TGA decoder.
   */
  function createTGATextureHandler(manager) {
    return {
      path: '',
      setPath(p) { this.path = p; return this; },
      load(url, onLoad, onProgress, onError) {
        const resolvedUrl = manager.resolveURL(url);
        const texture = new THREE.Texture();

        fetch(resolvedUrl)
          .then(r => r.arrayBuffer())
          .then(buffer => {
            const bytes = new Uint8Array(buffer);
            const tga = decodeTGA(bytes);
            if (!tga) {
              console.warn('[Media Vault] TGA decode failed for', url);
              if (onError) onError(new Error('TGA decode failed'));
              return;
            }
            const canvas = document.createElement('canvas');
            canvas.width = tga.width;
            canvas.height = tga.height;
            const ctx = canvas.getContext('2d');
            const imgData = ctx.createImageData(tga.width, tga.height);
            imgData.data.set(tga.rgba);
            ctx.putImageData(imgData, 0, 0);

            texture.image = canvas;
            texture.needsUpdate = true;
            if (onLoad) onLoad(texture);
          })
          .catch(err => {
            console.warn('[Media Vault] TGA handler fetch failed:', err);
            if (onError) onError(err);
          });

        return texture;
      }
    };
  }

  function loadFBX(bytes, textureBlobMap) {
    return new Promise((resolve, reject) => {
      try {
        const buffer = toArrayBuffer(bytes);

        // Quick format check before handing to loader
        const header = new Uint8Array(buffer, 0, Math.min(20, buffer.byteLength));
        const headerStr = String.fromCharCode.apply(null, header);
        const isBinary = headerStr.startsWith('Kaydara FBX Binary');
        console.log('[Media Vault] FBX format:', isBinary ? 'Binary' : 'ASCII',
          '| size:', buffer.byteLength, 'bytes');

        let loader;
        if (textureBlobMap && textureBlobMap.size > 0) {
          const manager = new THREE.LoadingManager();
          manager.setURLModifier((url) => {
            if (url.startsWith('data:') || url.startsWith('blob:')) return url;
            const filename = url.split('/').pop().split('\\').pop().toLowerCase();
            if (textureBlobMap.has(filename)) {
              console.log('[Media Vault] Resolved texture:', filename);
              return textureBlobMap.get(filename);
            }
            return url;
          });
          // Register format handlers — FBXLoader delegates to these for non-web formats
          manager.addHandler(/\.dds$/i, createDDSTextureHandler(manager));
          manager.addHandler(/\.tga$/i, createTGATextureHandler(manager));
          loader = new THREE.FBXLoader(manager);
        } else {
          loader = new THREE.FBXLoader();
        }

        const object = loader.parse(buffer, '');
        if (object.animations && object.animations.length > 0) {
          threeAnimations = object.animations;
        }
        resolve(object);
      } catch (error) {
        console.error('[Media Vault] FBX parse error:', error);
        reject(error);
      }
    });
  }

  function loadOBJ(url) {
    return new Promise((resolve, reject) => {
      const loader = new THREE.OBJLoader();
      loader.load(url, resolve, undefined, reject);
    });
  }

  function loadGLTF(url, bytes) {
    return new Promise((resolve, reject) => {
      const loader = new THREE.GLTFLoader();
      // For .glb, load from arraybuffer
      if (currentFile && getFileExtension(currentFile.name) === '.glb') {
        loader.parse(bytes.buffer, '', (gltf) => {
          if (gltf.animations && gltf.animations.length > 0) {
            threeAnimations = gltf.animations;
          }
          resolve(gltf.scene);
        }, reject);
      } else {
        loader.load(url, (gltf) => {
          if (gltf.animations && gltf.animations.length > 0) {
            threeAnimations = gltf.animations;
          }
          resolve(gltf.scene);
        }, undefined, reject);
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /*  3D Animations                                                   */
  /* ---------------------------------------------------------------- */

  function setupAnimations() {
    if (!threeModel || threeAnimations.length === 0) return;

    threeMixer = new THREE.AnimationMixer(threeModel);
    threeAnimPlaying = true;

    // Populate select
    $animSelect.innerHTML = threeAnimations.map((a, i) =>
      `<option value="${i}">${a.name || `Animation ${i}`}</option>`
    ).join('');

    // Play first
    const action = threeMixer.clipAction(threeAnimations[0]);
    action.play();

    $btnPlayPause.innerHTML = ICONS.pause;
    $animControls.classList.add('visible');

    $btnPlayPause.addEventListener('click', () => {
      threeAnimPlaying = !threeAnimPlaying;
      $btnPlayPause.innerHTML = threeAnimPlaying ? ICONS.pause : ICONS.play;
    });

    $animSelect.addEventListener('change', () => {
      const idx = parseInt($animSelect.value);
      threeMixer.stopAllAction();
      const a = threeMixer.clipAction(threeAnimations[idx]);
      a.play();
    });

    $animTimeline.addEventListener('input', () => {
      const idx = parseInt($animSelect.value);
      const clip = threeAnimations[idx];
      if (clip && threeMixer) {
        const time = (parseInt($animTimeline.value) / 100) * clip.duration;
        threeMixer.setTime(time);
      }
    });
  }

  function updateAnimTimeline() {
    const idx = parseInt($animSelect.value);
    const clip = threeAnimations[idx];
    if (!clip || !threeMixer) return;

    const action = threeMixer.existingAction(clip);
    if (!action) return;

    const t = action.time % clip.duration;
    $animTimeline.value = (t / clip.duration) * 100;
    const secs = Math.floor(t);
    const ms = Math.floor((t - secs) * 100);
    $animTimeLabel.textContent = `${secs}:${String(ms).padStart(2, '0')} / ${clip.duration.toFixed(1)}s`;
  }

  /* ---------------------------------------------------------------- */
  /*  3D Stats                                                        */
  /* ---------------------------------------------------------------- */

  function countModelStats(object) {
    let vertices = 0, triangles = 0, materials = new Set(), bones = 0;

    object.traverse((child) => {
      if (child.isMesh) {
        const geo = child.geometry;
        if (geo.attributes.position) vertices += geo.attributes.position.count;
        if (geo.index) triangles += geo.index.count / 3;
        else if (geo.attributes.position) triangles += geo.attributes.position.count / 3;

        if (Array.isArray(child.material)) {
          child.material.forEach(m => materials.add(m));
        } else if (child.material) {
          materials.add(child.material);
        }
      }
      if (child.isBone) bones++;
    });

    return { vertices, triangles: Math.floor(triangles), faces: Math.floor(triangles), materials: materials.size, bones, animations: threeAnimations.length };
  }

  function updateStatsOverlay(stats) {
    const isFBX = currentFile && getFileExtension(currentFile.name) === '.fbx';
    $statsOverlay.innerHTML = `
      <div class="stat-row"><span class="stat-label">Vertices</span><span class="stat-value">${stats.vertices.toLocaleString()}</span></div>
      ${isFBX ? `<div class="stat-row"><span class="stat-label">Triangles</span><span class="stat-value">${stats.triangles.toLocaleString()}</span></div>` : ''}
      <div class="stat-row"><span class="stat-label">Faces</span><span class="stat-value">${stats.faces.toLocaleString()}</span></div>
      <div class="stat-row"><span class="stat-label">Materials</span><span class="stat-value">${stats.materials}</span></div>
      ${stats.bones > 0 ? `<div class="stat-row"><span class="stat-label">Bones</span><span class="stat-value">${stats.bones}</span></div>` : ''}
      ${stats.animations > 0 ? `<div class="stat-row"><span class="stat-label">Animations</span><span class="stat-value">${stats.animations}</span></div>` : ''}
    `;
  }

  /* ---------------------------------------------------------------- */
  /*  3D Toolbar                                                      */
  /* ---------------------------------------------------------------- */

  function build3DToolbar() {
    $toolbarCenter.innerHTML = `
      ${backButtonHtml()}
      <div class="view-mode-btns">
        <button class="view-mode-btn ${threeViewMode === 'solid' ? 'active' : ''}" data-mode="solid">Solid</button>
        <button class="view-mode-btn ${threeViewMode === 'wireframe' ? 'active' : ''}" data-mode="wireframe">Wire</button>
        <button class="view-mode-btn ${threeViewMode === 'both' ? 'active' : ''}" data-mode="both">Both</button>
      </div>
      <div class="viewer-separator"></div>
      <button class="viewer-btn" id="btnResetCamera" title="Reset camera (F)">${ICONS.maximize}</button>
      <button class="viewer-btn ${threeGridHelper?.visible ? 'active' : ''}" id="btnToggleGrid" title="Toggle grid (G)">${ICONS.gridView}</button>
      <div class="viewer-separator"></div>
      <div class="orient-btns" title="Rotate model 90° per click">
        <button class="viewer-btn orient-btn ${rotStepX ? 'active' : ''}" id="btnRotX" title="Rotate around X (${rotStepX * 90}°)">X</button>
        <button class="viewer-btn orient-btn ${rotStepY ? 'active' : ''}" id="btnRotY" title="Rotate around Y (${rotStepY * 90}°)">Y</button>
        <button class="viewer-btn orient-btn ${rotStepZ ? 'active' : ''}" id="btnRotZ" title="Rotate around Z (${rotStepZ * 90}°)">Z</button>
      </div>
    `;

    $toolbarRight.innerHTML = `
      <button class="viewer-btn" id="btnToggleInfo" title="Toggle info panel">${ICONS.info}</button>
    `;

    wireBackButton();
    // View mode
    $toolbarCenter.querySelectorAll('.view-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        threeViewMode = btn.dataset.mode;
        $toolbarCenter.querySelectorAll('.view-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === threeViewMode));
        applyThreeViewMode();
      });
    });

    // Reset camera
    $toolbarCenter.querySelector('#btnResetCamera').addEventListener('click', () => {
      if (threeModel) autoFrameCamera(threeModel);
    });

    // Toggle grid
    $toolbarCenter.querySelector('#btnToggleGrid').addEventListener('click', () => {
      threeGridHelper.visible = !threeGridHelper.visible;
      $toolbarCenter.querySelector('#btnToggleGrid').classList.toggle('active', threeGridHelper.visible);
    });

    // Orientation buttons — rotate 90° per click
    ['X', 'Y', 'Z'].forEach(axis => {
      const btn = $toolbarCenter.querySelector('#btnRot' + axis);
      if (!btn) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (axis === 'X') rotStepX = (rotStepX + 1) % 4;
        else if (axis === 'Y') rotStepY = (rotStepY + 1) % 4;
        else rotStepZ = (rotStepZ + 1) % 4;
        applyModelOrientation();
        btn.classList.toggle('active', axis === 'X' ? rotStepX !== 0 : axis === 'Y' ? rotStepY !== 0 : rotStepZ !== 0);
        btn.title = `Rotate around ${axis} (${(axis === 'X' ? rotStepX : axis === 'Y' ? rotStepY : rotStepZ) * 90}°)`;
      });
    });

    $toolbarRight.querySelector('#btnToggleInfo').addEventListener('click', toggleMetadataPanel);
  }

  function applyModelOrientation() {
    if (!threeModel) return;
    threeModel.rotation.set(
      rotStepX * Math.PI / 2,
      rotStepY * Math.PI / 2,
      rotStepZ * Math.PI / 2
    );
  }

  function applyThreeViewMode() {
    if (!threeModel) return;
    threeModel.traverse((child) => {
      if (child.isMesh) {
        if (threeViewMode === 'wireframe') {
          child.material.wireframe = true;
        } else if (threeViewMode === 'solid') {
          child.material.wireframe = false;
        } else {
          // Both — we can't do both with a single material easily,
          // so we set wireframe off and add a wireframe overlay
          child.material.wireframe = false;
        }
      }
    });

    // For "both" mode, add/remove wireframe overlay
    if (threeViewMode === 'both') {
      threeModel.traverse((child) => {
        if (child.isMesh && !child._wireframeOverlay) {
          const wireGeo = child.geometry;
          const wireMat = new THREE.MeshBasicMaterial({
            color: 0x000000,
            wireframe: true,
            transparent: true,
            opacity: 0.15,
          });
          const wireObj = new THREE.Mesh(wireGeo, wireMat);
          wireObj.name = '__wireframeOverlay';
          child._wireframeOverlay = wireObj;
          child.add(wireObj);
        }
      });
    } else {
      // Remove overlays
      threeModel.traverse((child) => {
        if (child.isMesh && child._wireframeOverlay) {
          child.remove(child._wireframeOverlay);
          child._wireframeOverlay.material.dispose();
          child._wireframeOverlay = null;
        }
      });
    }
  }

  /* ================================================================ */
  /*  Metadata Bar & Panel                                            */
  /* ================================================================ */

  function updateMetadataBar(data) {
    void data;
  }

  function toggleMetadataPanel() {
    metadataPanelVisible = !metadataPanelVisible;
    $metadataPanel.classList.toggle('visible', metadataPanelVisible);

    if (metadataPanelVisible && currentFile) {
      buildMetadataPanel();
    }

    // Persist preference
    api.storage.set('infoPanelVisible', metadataPanelVisible).catch(() => {});
  }

  // Restore persisted panel visibility on load
  async function restoreInfoPanelState() {
    try {
      const saved = await api.storage.get('infoPanelVisible');
      if (saved === false) {
        metadataPanelVisible = false;
      } else {
        metadataPanelVisible = true; // default on
      }
      $metadataPanel.classList.toggle('visible', metadataPanelVisible);
    } catch (_) {
      // Default stays true
    }
  }

  function buildMetadataPanel() {
    if (!currentFile) return;
    metadataPanelVisible = true;
    $metadataPanel.classList.add('visible');

    const ext = getFileExtension(currentFile.name);
    let html = '<h3>File</h3>';
    html += metaRow('Name', currentFile.name);
    html += metaRow('Path', currentFile.relativePath);
    html += metaRow('Size', formatFileSize(currentFile.size));
    html += metaRow('Format', ext.toUpperCase().replace('.', ''));

    if (viewerMode === 'image' || viewerMode === 'dds') {
      html += '<h3>Dimensions</h3>';
      html += metaRow('Width', imgNaturalW + ' px');
      html += metaRow('Height', imgNaturalH + ' px');
      html += metaRow('Pixels', (imgNaturalW * imgNaturalH).toLocaleString());
    }

    if (viewerMode === 'dds' && ddsData) {
      html += '<h3>DDS Format</h3>';
      html += metaRow('Compression', ddsData.formatName);
      html += metaRow('Mipmaps', String(ddsData.mipmaps.length));
    }

    if (viewerMode === '3d' && threeModel) {
      const stats = cachedModelStats || countModelStats(threeModel);
      const isFBX = currentFile && getFileExtension(currentFile.name) === '.fbx';
      html += '<h3>Geometry</h3>';
      html += metaRow('Vertices', stats.vertices.toLocaleString());
      if (isFBX) html += metaRow('Triangles', stats.triangles.toLocaleString());
      html += metaRow('Faces', stats.faces.toLocaleString());
      html += metaRow('Materials', String(stats.materials));
      if (stats.bones > 0) html += metaRow('Bones', String(stats.bones));
      if (stats.animations > 0) html += metaRow('Animations', String(stats.animations));

      // Bounding box dimensions
      const box = new THREE.Box3().setFromObject(threeModel);
      const sz = box.getSize(new THREE.Vector3());
      html += metaRow('Bounds', `${sz.x.toFixed(1)} × ${sz.y.toFixed(1)} × ${sz.z.toFixed(1)}`);

      // --- Scene Settings ---
      html += buildSceneSettingsHTML();
    }

    $metadataPanel.innerHTML = html;

    // Bind scene control events if in 3D mode
    if (viewerMode === '3d') {
      bindSceneSettingsEvents();
    }
  }

  function buildSiblingTextureChecklist() {
    if (!siblingTextureMatches || siblingTextureMatches.size === 0) return '';

    const SLOT_LABELS = {
      albedo: 'Color', normal: 'Normal', emissive: 'Emissive',
      alpha: 'Alpha', property: 'Property',
    };
    const SLOT_WARNINGS = {
      alpha: 'May cause visibility issues',
      property: 'Engine-specific packed data',
    };

    let rows = '';
    for (const [slot, sib] of siblingTextureMatches) {
      const label = SLOT_LABELS[slot] || slot;
      const warn = SLOT_WARNINGS[slot] || '';
      const defaultChecked = slot !== 'alpha' && slot !== 'property';
      rows += `<label class="stc-row">
        <input type="checkbox" class="stc-check" data-slot="${slot}" ${defaultChecked ? 'checked' : ''}>
        <span class="stc-slot">${label}</span>
        <span class="stc-file" title="${escapeHtml(sib.name)}">${escapeHtml(sib.name)}</span>
        ${warn ? `<span class="stc-warn">${warn}</span>` : ''}
      </label>`;
    }

    return `
      <h3 class="scene-section-toggle" data-section="sibtex">Sibling Textures</h3>
      <div class="scene-section" id="sec-sibtex">
        ${rows}
        <button class="mat-action-btn" id="btnApplyCheckedTex">Apply Selected</button>
      </div>
    `;
  }

  function buildSceneSettingsHTML() {
    const s = sceneSettings;
    const presetOptions = Object.keys(LIGHT_PRESETS).map(k =>
      `<option value="${k}" ${s.preset === k ? 'selected' : ''}>${k.charAt(0).toUpperCase() + k.slice(1)}</option>`
    ).join('');

    const toneMappingOptions = ['None', 'Linear', 'Reinhard', 'ACES'].map(k =>
      `<option value="${k}" ${s.toneMapping === k ? 'selected' : ''}>${k}</option>`
    ).join('');

    // materialOptions moved to buildMaterialSectionHTML()

    return `
      <h3 class="scene-section-toggle" data-section="lighting">Lighting</h3>
      <div class="scene-section" id="sec-lighting">
        <div class="scene-row">
          <label>Preset</label>
          <select class="scene-select" id="scPreset">${presetOptions}</select>
        </div>
        <div class="scene-row">
          <label>Ambient</label>
          <input type="range" class="scene-slider" id="scAmbient" min="0" max="2" step="0.05" value="${s.ambientIntensity}">
          <span class="scene-val" id="scAmbientVal">${s.ambientIntensity.toFixed(2)}</span>
        </div>
        <div class="scene-row">
          <label>Key Light</label>
          <input type="range" class="scene-slider" id="scKey" min="0" max="3" step="0.05" value="${s.keyIntensity}">
          <span class="scene-val" id="scKeyVal">${s.keyIntensity.toFixed(2)}</span>
        </div>
        <div class="scene-row">
          <label>Key Color</label>
          <input type="color" class="scene-color" id="scKeyColor" value="${s.keyColor}">
        </div>
        <div class="scene-row">
          <label>Fill Light</label>
          <input type="range" class="scene-slider" id="scFill" min="0" max="2" step="0.05" value="${s.fillIntensity}">
          <span class="scene-val" id="scFillVal">${s.fillIntensity.toFixed(2)}</span>
        </div>
        <div class="scene-row">
          <label>Hemisphere</label>
          <input type="range" class="scene-slider" id="scHemi" min="0" max="2" step="0.05" value="${s.hemiIntensity}">
          <span class="scene-val" id="scHemiVal">${s.hemiIntensity.toFixed(2)}</span>
        </div>
      </div>

      <h3 class="scene-section-toggle" data-section="environment">Environment</h3>
      <div class="scene-section" id="sec-environment">
        <div class="scene-row">
          <label>Background</label>
          <input type="color" class="scene-color" id="scBgColor" value="${s.bgColor}">
        </div>
        <div class="scene-row">
          <label>Grid</label>
          <input type="checkbox" class="scene-check" id="scGrid" ${s.showGrid ? 'checked' : ''}>
        </div>
        <div class="scene-row">
          <label>Axes Helper</label>
          <input type="checkbox" class="scene-check" id="scAxes" ${s.showAxes ? 'checked' : ''}>
        </div>
        <div class="scene-row">
          <label>Bounding Box</label>
          <input type="checkbox" class="scene-check" id="scBBox" ${s.showBBox ? 'checked' : ''}>
        </div>
        <div class="scene-row">
          <label>Shadows</label>
          <input type="checkbox" class="scene-check" id="scShadow" ${s.groundShadow ? 'checked' : ''}>
        </div>
      </div>

      <h3 class="scene-section-toggle" data-section="camera">Camera</h3>
      <div class="scene-section" id="sec-camera">
        <div class="scene-row">
          <label>FOV</label>
          <input type="range" class="scene-slider" id="scFov" min="15" max="120" step="1" value="${s.fov}">
          <span class="scene-val" id="scFovVal">${s.fov}&deg;</span>
        </div>
        <div class="scene-row">
          <label>Tone Mapping</label>
          <select class="scene-select" id="scToneMap">${toneMappingOptions}</select>
        </div>
        <div class="scene-row">
          <label>Exposure</label>
          <input type="range" class="scene-slider" id="scExposure" min="0.1" max="4" step="0.05" value="${s.exposure}">
          <span class="scene-val" id="scExpVal">${s.exposure.toFixed(2)}</span>
        </div>
      </div>

      <h3 class="scene-section-toggle" data-section="material">Material</h3>
      <div class="scene-section" id="sec-material">
        ${buildMaterialSectionHTML()}
      </div>

      ${buildSiblingTextureChecklist()}
      <button class="mat-action-btn" id="btnResetAllDefaults">Reset All to Defaults</button>
    `;
  }

  function bindSceneSettingsEvents() {
    // Section toggles
    $metadataPanel.querySelectorAll('.scene-section-toggle').forEach(toggle => {
      toggle.addEventListener('click', () => {
        const sec = document.getElementById('sec-' + toggle.dataset.section);
        if (sec) {
          sec.classList.toggle('collapsed');
          toggle.classList.toggle('collapsed');
        }
      });
    });

    // Helper to bind a slider
    function bindSlider(id, valId, settingsKey, fmt) {
      const el = document.getElementById(id);
      const valEl = document.getElementById(valId);
      if (!el) return;
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        sceneSettings[settingsKey] = v;
        if (valEl) valEl.textContent = fmt ? fmt(v) : v.toFixed(2);
        sceneSettings.preset = 'custom';
        syncSceneFromSettingsQuiet();
      });
    }

    // Preset
    const presetEl = document.getElementById('scPreset');
    if (presetEl) presetEl.addEventListener('change', () => {
      applyLightPreset(presetEl.value);
    });

    // Sliders
    bindSlider('scAmbient', 'scAmbientVal', 'ambientIntensity');
    bindSlider('scKey', 'scKeyVal', 'keyIntensity');
    bindSlider('scFill', 'scFillVal', 'fillIntensity');
    bindSlider('scHemi', 'scHemiVal', 'hemiIntensity');
    bindSlider('scFov', 'scFovVal', 'fov', v => v + '\u00B0');
    bindSlider('scExposure', 'scExpVal', 'exposure');

    // Colors
    const keyColorEl = document.getElementById('scKeyColor');
    if (keyColorEl) keyColorEl.addEventListener('input', () => {
      sceneSettings.keyColor = keyColorEl.value;
      syncSceneFromSettingsQuiet();
    });

    const bgColorEl = document.getElementById('scBgColor');
    if (bgColorEl) bgColorEl.addEventListener('input', () => {
      sceneSettings.bgColor = bgColorEl.value;
      syncSceneFromSettingsQuiet();
    });

    // Checkboxes
    function bindCheck(id, settingsKey) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        sceneSettings[settingsKey] = el.checked;
        syncSceneFromSettingsQuiet();
      });
    }
    bindCheck('scGrid', 'showGrid');
    bindCheck('scAxes', 'showAxes');
    bindCheck('scBBox', 'showBBox');
    bindCheck('scShadow', 'groundShadow');

    // Selects
    const toneEl = document.getElementById('scToneMap');
    if (toneEl) toneEl.addEventListener('change', () => {
      sceneSettings.toneMapping = toneEl.value;
      syncSceneFromSettingsQuiet();
    });

    // Material section events (delegated to material editor system)
    bindMaterialSectionEvents();

    // Reset all to defaults
    const resetAllBtn = document.getElementById('btnResetAllDefaults');
    if (resetAllBtn) resetAllBtn.addEventListener('click', resetAllToDefaults);
  }

  function resetAllToDefaults() {
    // Restore all original materials
    if (threeModel) {
      threeModel.traverse((child) => {
        if (child.isMesh && originalMaterials.has(child.uuid)) {
          child.material = originalMaterials.get(child.uuid);
          originalMaterials.delete(child.uuid);
        }
      });
    }
    meshMaterialEdits.clear();
    deselectMesh();

    // Reset scene settings to defaults
    sceneSettings.materialOverride = 'none';
    applyLightPreset('studio');

    // Reset camera/tone
    sceneSettings.fov = 50;
    sceneSettings.toneMapping = 'ACES';
    sceneSettings.exposure = 1.0;
    sceneSettings.showAxes = false;
    sceneSettings.showBBox = false;
    sceneSettings.showGrid = true;
    sceneSettings.groundShadow = true;

    syncSceneFromSettings();

    // Re-frame camera
    if (threeModel) autoFrameCamera(threeModel);
  }

  // Sync without rebuilding the panel (avoids infinite loop)
  function syncSceneFromSettingsQuiet() {
    if (!threeRenderer) return;
    if (lightAmbient) lightAmbient.intensity = sceneSettings.ambientIntensity;
    if (lightKey) {
      lightKey.intensity = sceneSettings.keyIntensity;
      lightKey.color.set(sceneSettings.keyColor);
      lightKey.castShadow = sceneSettings.groundShadow;
    }
    if (lightFill) lightFill.intensity = sceneSettings.fillIntensity;
    if (lightHemi) {
      lightHemi.intensity = sceneSettings.hemiIntensity;
      lightHemi.color.set(sceneSettings.hemiSkyColor);
      lightHemi.groundColor.set(sceneSettings.hemiGroundColor);
    }

    const bgCol = new THREE.Color(sceneSettings.bgColor);
    threeScene.background = bgCol;
    threeRenderer.setClearColor(bgCol);

    if (threeGridHelper) threeGridHelper.visible = sceneSettings.showGrid;

    if (sceneSettings.showAxes && !threeAxesHelper) {
      const axSize = threeModel ? new THREE.Box3().setFromObject(threeModel).getSize(new THREE.Vector3()).length() * 0.5 : 5;
      threeAxesHelper = new THREE.AxesHelper(axSize);
      threeScene.add(threeAxesHelper);
    } else if (!sceneSettings.showAxes && threeAxesHelper) {
      threeScene.remove(threeAxesHelper);
      threeAxesHelper.dispose();
      threeAxesHelper = null;
    }

    if (sceneSettings.showBBox && threeModel && !threeBBoxHelper) {
      threeBBoxHelper = new THREE.BoxHelper(threeModel, 0x00ff00);
      threeScene.add(threeBBoxHelper);
    } else if (!sceneSettings.showBBox && threeBBoxHelper) {
      threeScene.remove(threeBBoxHelper);
      threeBBoxHelper.dispose();
      threeBBoxHelper = null;
    }

    if (threeCamera.isPerspectiveCamera) {
      threeCamera.fov = sceneSettings.fov;
      threeCamera.updateProjectionMatrix();
    }

    applyToneMapping();
  }

  function metaRow(label, value) {
    return `<div class="meta-row"><span class="label">${escapeHtml(label)}</span><span class="value" title="${escapeHtml(value)}">${escapeHtml(value)}</span></div>`;
  }

  /* ================================================================ */
  /*  Keyboard Shortcuts                                              */
  /* ================================================================ */

  document.addEventListener('keydown', (e) => {
    // Don't handle if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    switch (e.key.toLowerCase()) {
      case 'escape':
        if (selectedMesh) {
          e.preventDefault();
          deselectMesh();
          dismissTexturePickerModal();
        }
        break;

      case 'f':
        e.preventDefault();
        if (viewerMode === 'image' || viewerMode === 'dds') {
          fitToView();
          applyImageTransform($imageContainer.querySelector('img, canvas'));
        } else if (viewerMode === '3d' && threeModel) {
          autoFrameCamera(threeModel);
        }
        break;

      case '1':
        if (viewerMode === 'dds') {
          ddsChannel = 'rgb';
          $toolbarCenter.querySelectorAll('.channel-btn').forEach(b => b.classList.toggle('active', b.dataset.ch === 'rgb'));
          renderDdsToCanvas();
        }
        break;
      case '2':
        if (viewerMode === 'dds') {
          ddsChannel = 'r';
          $toolbarCenter.querySelectorAll('.channel-btn').forEach(b => b.classList.toggle('active', b.dataset.ch === 'r'));
          renderDdsToCanvas();
        }
        break;
      case '3':
        if (viewerMode === 'dds') {
          ddsChannel = 'g';
          $toolbarCenter.querySelectorAll('.channel-btn').forEach(b => b.classList.toggle('active', b.dataset.ch === 'g'));
          renderDdsToCanvas();
        }
        break;
      case '4':
        if (viewerMode === 'dds') {
          ddsChannel = 'a';
          $toolbarCenter.querySelectorAll('.channel-btn').forEach(b => b.classList.toggle('active', b.dataset.ch === 'a'));
          renderDdsToCanvas();
        }
        break;

      case 'w':
        if (viewerMode === '3d') {
          e.preventDefault();
          threeViewMode = threeViewMode === 'wireframe' ? 'solid' : 'wireframe';
          $toolbarCenter.querySelectorAll('.view-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === threeViewMode));
          applyThreeViewMode();
        }
        break;

      case 'g':
        if (viewerMode === '3d') {
          e.preventDefault();
          threeGridHelper.visible = !threeGridHelper.visible;
          const gridBtn = $toolbarCenter.querySelector('#btnToggleGrid');
          if (gridBtn) gridBtn.classList.toggle('active', threeGridHelper.visible);
        }
        break;

      case 't':
        if (viewerMode === 'dds') {
          e.preventDefault();
          ddsTiling = !ddsTiling;
          const tileBtn = $toolbarCenter.querySelector('#btnTile');
          if (tileBtn) tileBtn.classList.toggle('active', ddsTiling);
          renderDdsToCanvas();
        }
        break;

      case ' ':
        if (viewerMode === '3d' && threeAnimations.length > 0) {
          e.preventDefault();
          threeAnimPlaying = !threeAnimPlaying;
          $btnPlayPause.innerHTML = threeAnimPlaying ? ICONS.pause : ICONS.play;
        }
        break;
    }
  });

  /* ================================================================ */
  /*  DDS Decoder                                                     */
  /* ================================================================ */

  function decodeDDS(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Magic: "DDS " = 0x20534444
    if (view.getUint32(0, true) !== 0x20534444) return null;

    const height = view.getUint32(12, true);
    const width = view.getUint32(16, true);
    const mipCount = Math.max(1, view.getUint32(28, true));
    const pfFlags = view.getUint32(80, true);
    const fourCC = view.getUint32(84, true);

    let formatName = 'Unknown';
    let blockSize = 8;
    let decompressFn = null;
    let isUncompressed = false;

    // Check FourCC
    const fourCCStr = String.fromCharCode(fourCC & 0xff, (fourCC >> 8) & 0xff, (fourCC >> 16) & 0xff, (fourCC >> 24) & 0xff);

    let headerSize = 128;

    if (fourCCStr === 'DX10') {
      // DX10 extended header: 20 bytes after standard 128-byte header
      const dxgiFormat = view.getUint32(128, true);
      headerSize = 148;

      // DXGI_FORMAT enum values
      if (dxgiFormat === 71 || dxgiFormat === 72) {
        // DXGI_FORMAT_BC1_UNORM (71), DXGI_FORMAT_BC1_UNORM_SRGB (72)
        formatName = 'BC1 (DX10)';
        blockSize = 8;
        decompressFn = decompressDXT1;
      } else if (dxgiFormat === 74 || dxgiFormat === 75) {
        // DXGI_FORMAT_BC2_UNORM (74), DXGI_FORMAT_BC2_UNORM_SRGB (75)
        formatName = 'BC2 (DX10)';
        blockSize = 16;
        decompressFn = decompressDXT3;
      } else if (dxgiFormat === 77 || dxgiFormat === 78) {
        // DXGI_FORMAT_BC3_UNORM (77), DXGI_FORMAT_BC3_UNORM_SRGB (78)
        formatName = 'BC3 (DX10)';
        blockSize = 16;
        decompressFn = decompressDXT5;
      } else if (dxgiFormat === 80 || dxgiFormat === 81) {
        // DXGI_FORMAT_BC4_UNORM (80), DXGI_FORMAT_BC4_SNORM (81)
        formatName = dxgiFormat === 81 ? 'BC4 SNORM' : 'BC4';
        blockSize = 8;
        decompressFn = dxgiFormat === 81
          ? (d, w, h) => remapSNORM(decompressBC4(d, w, h))
          : decompressBC4;
      } else if (dxgiFormat === 83 || dxgiFormat === 84) {
        // DXGI_FORMAT_BC5_UNORM (83), DXGI_FORMAT_BC5_SNORM (84)
        formatName = dxgiFormat === 84 ? 'BC5 SNORM' : 'BC5';
        blockSize = 16;
        decompressFn = dxgiFormat === 84
          ? (d, w, h) => remapSNORM(decompressBC5(d, w, h))
          : decompressBC5;
      } else if (dxgiFormat === 95 || dxgiFormat === 96 || dxgiFormat === 98 || dxgiFormat === 99) {
        // DXGI_FORMAT_BC7_UNORM (98), DXGI_FORMAT_BC7_UNORM_SRGB (99)
        // DXGI_FORMAT_BC6H_UF16 (95), DXGI_FORMAT_BC6H_SF16 (96) — not decoded, use BC7 display
        if (dxgiFormat === 98 || dxgiFormat === 99) {
          formatName = 'BC7 (BPTC)';
          blockSize = 16;
          decompressFn = decompressBC7;
        } else {
          formatName = `BC6H (DXGI ${dxgiFormat})`;
          blockSize = 16;
          decompressFn = null; // BC6H (HDR) not yet supported
        }
      } else {
        formatName = `DXGI Format ${dxgiFormat}`;
        blockSize = 16;
        decompressFn = null;
      }
    } else if (fourCCStr === 'DXT1') {
      formatName = 'DXT1 (BC1)';
      blockSize = 8;
      decompressFn = decompressDXT1;
    } else if (fourCCStr === 'DXT3') {
      formatName = 'DXT3 (BC2)';
      blockSize = 16;
      decompressFn = decompressDXT3;
    } else if (fourCCStr === 'DXT5') {
      formatName = 'DXT5 (BC3)';
      blockSize = 16;
      decompressFn = decompressDXT5;
    } else if (fourCCStr === 'ATI1' || fourCCStr === 'BC4U' || fourCCStr === 'BC4S') {
      const isSigned = fourCCStr === 'BC4S';
      formatName = isSigned ? 'BC4 SNORM' : 'BC4';
      blockSize = 8;
      decompressFn = isSigned ? (d, w, h) => remapSNORM(decompressBC4(d, w, h)) : decompressBC4;
    } else if (fourCCStr === 'ATI2' || fourCCStr === 'BC5U' || fourCCStr === 'BC5S') {
      const isSigned = fourCCStr === 'BC5S';
      formatName = isSigned ? 'BC5 SNORM' : 'BC5';
      blockSize = 16;
      decompressFn = isSigned ? (d, w, h) => remapSNORM(decompressBC5(d, w, h)) : decompressBC5;
    } else if (pfFlags & 0x40) {
      // Uncompressed RGBA
      formatName = 'Uncompressed RGBA';
      isUncompressed = true;
    } else {
      formatName = `FourCC: ${fourCCStr}`;
      // Attempt DXT5 as fallback for unknown compressed formats
      blockSize = 16;
      decompressFn = decompressDXT5;
    }

    let offset = headerSize;

    const mipmaps = [];
    let mipW = width, mipH = height;

    for (let i = 0; i < mipCount; i++) {
      if (mipW === 0 || mipH === 0) break;

      let rgba;
      let dataLen;

      if (decompressFn) {
        const blocksX = Math.max(1, Math.ceil(mipW / 4));
        const blocksY = Math.max(1, Math.ceil(mipH / 4));
        dataLen = blocksX * blocksY * blockSize;

        if (offset + dataLen > bytes.length) break;

        const compressedData = bytes.subarray(offset, offset + dataLen);
        rgba = decompressFn(compressedData, mipW, mipH);
      } else if (isUncompressed) {
        // Uncompressed RGBA
        dataLen = mipW * mipH * 4;
        if (offset + dataLen > bytes.length) break;
        rgba = new Uint8Array(bytes.buffer, bytes.byteOffset + offset, dataLen);
        rgba = new Uint8Array(rgba); // copy
      } else {
        // Unsupported compressed format — skip
        break;
      }

      mipmaps.push({ width: mipW, height: mipH, rgba });
      offset += dataLen;
      mipW = Math.max(1, mipW >> 1);
      mipH = Math.max(1, mipH >> 1);
    }

    if (mipmaps.length === 0) return null;

    return { formatName, mipmaps };
  }

  /* ---------------------------------------------------------------- */
  /*  DXT1 (BC1) Decoder                                              */
  /* ---------------------------------------------------------------- */

  function decompressDXT1(data, width, height) {
    const rgba = new Uint8Array(width * height * 4);
    const blocksX = Math.max(1, Math.ceil(width / 4));
    let offset = 0;

    for (let by = 0; by < Math.ceil(height / 4); by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        const c0 = data[offset] | (data[offset + 1] << 8);
        const c1 = data[offset + 2] | (data[offset + 3] << 8);
        offset += 4;

        const colors = decodeRGB565Colors(c0, c1, c0 <= c1);

        const lookupBits = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24);
        offset += 4;

        for (let row = 0; row < 4; row++) {
          for (let col = 0; col < 4; col++) {
            const px = bx * 4 + col;
            const py = by * 4 + row;
            if (px >= width || py >= height) continue;

            const idx = ((row * 4 + col) * 2);
            const ci = (lookupBits >> idx) & 3;
            const c = colors[ci];
            const dst = (py * width + px) * 4;
            rgba[dst] = c[0]; rgba[dst + 1] = c[1]; rgba[dst + 2] = c[2]; rgba[dst + 3] = c[3];
          }
        }
      }
    }
    return rgba;
  }

  /* ---------------------------------------------------------------- */
  /*  DXT3 (BC2) Decoder                                              */
  /* ---------------------------------------------------------------- */

  function decompressDXT3(data, width, height) {
    const rgba = new Uint8Array(width * height * 4);
    const blocksX = Math.max(1, Math.ceil(width / 4));
    let offset = 0;

    for (let by = 0; by < Math.ceil(height / 4); by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        // 8 bytes of explicit alpha
        const alphaData = new Uint8Array(16);
        for (let i = 0; i < 4; i++) {
          const row = data[offset + i * 2] | (data[offset + i * 2 + 1] << 8);
          for (let j = 0; j < 4; j++) {
            alphaData[i * 4 + j] = ((row >> (j * 4)) & 0xf) * 17;
          }
        }
        offset += 8;

        // Color block (same as DXT1)
        const c0 = data[offset] | (data[offset + 1] << 8);
        const c1 = data[offset + 2] | (data[offset + 3] << 8);
        offset += 4;

        const colors = decodeRGB565Colors(c0, c1, false);

        const lookupBits = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24);
        offset += 4;

        for (let row = 0; row < 4; row++) {
          for (let col = 0; col < 4; col++) {
            const px = bx * 4 + col;
            const py = by * 4 + row;
            if (px >= width || py >= height) continue;

            const idx = ((row * 4 + col) * 2);
            const ci = (lookupBits >> idx) & 3;
            const c = colors[ci];
            const dst = (py * width + px) * 4;
            rgba[dst] = c[0]; rgba[dst + 1] = c[1]; rgba[dst + 2] = c[2];
            rgba[dst + 3] = alphaData[row * 4 + col];
          }
        }
      }
    }
    return rgba;
  }

  /* ---------------------------------------------------------------- */
  /*  DXT5 (BC3) Decoder                                              */
  /* ---------------------------------------------------------------- */

  function decompressDXT5(data, width, height) {
    const rgba = new Uint8Array(width * height * 4);
    const blocksX = Math.max(1, Math.ceil(width / 4));
    let offset = 0;

    for (let by = 0; by < Math.ceil(height / 4); by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        // Interpolated alpha block
        const a0 = data[offset];
        const a1 = data[offset + 1];
        offset += 2;

        // 6 bytes = 48 bits of alpha indices (3 bits each for 16 pixels)
        let alphaBits = 0n;
        for (let i = 0; i < 6; i++) {
          alphaBits |= BigInt(data[offset + i]) << BigInt(i * 8);
        }
        offset += 6;

        const alphaTable = interpolateAlpha(a0, a1);
        const alphaValues = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
          const ai = Number((alphaBits >> BigInt(i * 3)) & 7n);
          alphaValues[i] = alphaTable[ai];
        }

        // Color block
        const c0 = data[offset] | (data[offset + 1] << 8);
        const c1 = data[offset + 2] | (data[offset + 3] << 8);
        offset += 4;

        const colors = decodeRGB565Colors(c0, c1, false);

        const lookupBits = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24);
        offset += 4;

        for (let row = 0; row < 4; row++) {
          for (let col = 0; col < 4; col++) {
            const px = bx * 4 + col;
            const py = by * 4 + row;
            if (px >= width || py >= height) continue;

            const idx = ((row * 4 + col) * 2);
            const ci = (lookupBits >> idx) & 3;
            const c = colors[ci];
            const dst = (py * width + px) * 4;
            rgba[dst] = c[0]; rgba[dst + 1] = c[1]; rgba[dst + 2] = c[2];
            rgba[dst + 3] = alphaValues[row * 4 + col];
          }
        }
      }
    }
    return rgba;
  }

  /* ---------------------------------------------------------------- */
  /*  DDS Shared Helpers                                              */
  /* ---------------------------------------------------------------- */

  function decodeRGB565(c) {
    return [
      ((c >> 11) & 0x1f) * 255 / 31 | 0,
      ((c >> 5) & 0x3f) * 255 / 63 | 0,
      (c & 0x1f) * 255 / 31 | 0,
    ];
  }

  function decodeRGB565Colors(c0, c1, hasTransparent) {
    const r0 = decodeRGB565(c0);
    const r1 = decodeRGB565(c1);

    if (!hasTransparent) {
      return [
        [r0[0], r0[1], r0[2], 255],
        [r1[0], r1[1], r1[2], 255],
        [((2 * r0[0] + r1[0]) / 3) | 0, ((2 * r0[1] + r1[1]) / 3) | 0, ((2 * r0[2] + r1[2]) / 3) | 0, 255],
        [((r0[0] + 2 * r1[0]) / 3) | 0, ((r0[1] + 2 * r1[1]) / 3) | 0, ((r0[2] + 2 * r1[2]) / 3) | 0, 255],
      ];
    } else {
      return [
        [r0[0], r0[1], r0[2], 255],
        [r1[0], r1[1], r1[2], 255],
        [((r0[0] + r1[0]) / 2) | 0, ((r0[1] + r1[1]) / 2) | 0, ((r0[2] + r1[2]) / 2) | 0, 255],
        [0, 0, 0, 0], // transparent
      ];
    }
  }

  function interpolateAlpha(a0, a1) {
    const table = new Uint8Array(8);
    table[0] = a0;
    table[1] = a1;

    if (a0 > a1) {
      table[2] = ((6 * a0 + 1 * a1) / 7) | 0;
      table[3] = ((5 * a0 + 2 * a1) / 7) | 0;
      table[4] = ((4 * a0 + 3 * a1) / 7) | 0;
      table[5] = ((3 * a0 + 4 * a1) / 7) | 0;
      table[6] = ((2 * a0 + 5 * a1) / 7) | 0;
      table[7] = ((1 * a0 + 6 * a1) / 7) | 0;
    } else {
      table[2] = ((4 * a0 + 1 * a1) / 5) | 0;
      table[3] = ((3 * a0 + 2 * a1) / 5) | 0;
      table[4] = ((2 * a0 + 3 * a1) / 5) | 0;
      table[5] = ((1 * a0 + 4 * a1) / 5) | 0;
      table[6] = 0;
      table[7] = 255;
    }
    return table;
  }

  /** Remap SNORM decoded RGBA: treat byte values as signed (-128..127) and map to 0..255 for display. */
  function remapSNORM(rgba) {
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i]     = ((rgba[i]     ^ 128) & 0xFF);     // R
      rgba[i + 1] = ((rgba[i + 1] ^ 128) & 0xFF);     // G
      rgba[i + 2] = ((rgba[i + 2] ^ 128) & 0xFF);     // B
      // leave alpha as-is
    }
    return rgba;
  }

  /* ---------------------------------------------------------------- */
  /*  BC4 (ATI1 / 3Dc+) Decoder — single channel                     */
  /* ---------------------------------------------------------------- */

  function decompressBC4(data, width, height) {
    const rgba = new Uint8Array(width * height * 4);
    const blocksX = Math.max(1, Math.ceil(width / 4));
    const blocksY = Math.max(1, Math.ceil(height / 4));
    let offset = 0;

    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        const a0 = data[offset];
        const a1 = data[offset + 1];
        const table = interpolateAlpha(a0, a1);

        // 6 bytes = 48 bits of 3-bit indices for 16 pixels
        const b0 = data[offset + 2], b1 = data[offset + 3], b2 = data[offset + 4];
        const b3 = data[offset + 5], b4 = data[offset + 6], b5 = data[offset + 7];
        const lo = b0 | (b1 << 8) | (b2 << 16);
        const hi = b3 | (b4 << 8) | (b5 << 16);
        offset += 8;

        for (let row = 0; row < 4; row++) {
          for (let col = 0; col < 4; col++) {
            const px = bx * 4 + col;
            const py = by * 4 + row;
            if (px >= width || py >= height) continue;
            const pix = row * 4 + col;
            const bits = pix < 8 ? lo : hi;
            const shift = (pix < 8 ? pix : pix - 8) * 3;
            const idx = (bits >> shift) & 7;
            const v = table[idx];
            const dst = (py * width + px) * 4;
            rgba[dst] = v; rgba[dst + 1] = v; rgba[dst + 2] = v; rgba[dst + 3] = 255;
          }
        }
      }
    }
    return rgba;
  }

  /* ---------------------------------------------------------------- */
  /*  BC5 (ATI2 / 3Dc) Decoder — two channels (RG)                   */
  /* ---------------------------------------------------------------- */

  function decompressBC5(data, width, height) {
    const rgba = new Uint8Array(width * height * 4);
    const blocksX = Math.max(1, Math.ceil(width / 4));
    const blocksY = Math.max(1, Math.ceil(height / 4));
    let offset = 0;

    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        // Channel 1 (Red)
        const r0 = data[offset], r1 = data[offset + 1];
        const rTable = interpolateAlpha(r0, r1);
        const rb0 = data[offset + 2], rb1 = data[offset + 3], rb2 = data[offset + 4];
        const rb3 = data[offset + 5], rb4 = data[offset + 6], rb5 = data[offset + 7];
        const rLo = rb0 | (rb1 << 8) | (rb2 << 16);
        const rHi = rb3 | (rb4 << 8) | (rb5 << 16);
        offset += 8;

        // Channel 2 (Green)
        const g0 = data[offset], g1 = data[offset + 1];
        const gTable = interpolateAlpha(g0, g1);
        const gb0 = data[offset + 2], gb1 = data[offset + 3], gb2 = data[offset + 4];
        const gb3 = data[offset + 5], gb4 = data[offset + 6], gb5 = data[offset + 7];
        const gLo = gb0 | (gb1 << 8) | (gb2 << 16);
        const gHi = gb3 | (gb4 << 8) | (gb5 << 16);
        offset += 8;

        for (let row = 0; row < 4; row++) {
          for (let col = 0; col < 4; col++) {
            const px = bx * 4 + col;
            const py = by * 4 + row;
            if (px >= width || py >= height) continue;
            const pix = row * 4 + col;
            const bits = pix < 8 ? rLo : rHi;
            const gbits = pix < 8 ? gLo : gHi;
            const shift = (pix < 8 ? pix : pix - 8) * 3;
            const rIdx = (bits >> shift) & 7;
            const gIdx = (gbits >> shift) & 7;
            const dst = (py * width + px) * 4;
            rgba[dst] = rTable[rIdx]; rgba[dst + 1] = gTable[gIdx]; rgba[dst + 2] = 0; rgba[dst + 3] = 255;
          }
        }
      }
    }
    return rgba;
  }

  /* ---------------------------------------------------------------- */
  /*  BC7 (BPTC) Decoder — all 8 modes                               */
  /* ---------------------------------------------------------------- */

  function decompressBC7(data, width, height) {
    const rgba = new Uint8Array(width * height * 4);
    const blocksX = Math.max(1, Math.ceil(width / 4));
    const blocksY = Math.max(1, Math.ceil(height / 4));

    // Partition tables: 2-subset (64 entries, 16 values each)
    const P2 = [
      [0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1],[0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1],
      [0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1],[0,0,0,1,0,0,1,1,0,0,1,1,0,1,1,1],
      [0,0,0,0,0,0,0,1,0,0,0,1,0,0,1,1],[0,0,1,1,0,1,1,1,0,1,1,1,1,1,1,1],
      [0,0,0,1,0,0,1,1,0,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,1,0,0,1,1,0,1,1,1],
      [0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1],[0,0,1,1,0,1,1,1,1,1,1,1,1,1,1,1],
      [0,0,0,0,0,0,0,1,0,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,0,0,0,1,0,1,1,1],
      [0,0,0,1,0,1,1,1,1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1],
      [0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1],
      [0,0,0,0,1,0,0,0,1,1,1,0,1,1,1,1],[0,1,1,1,0,0,0,1,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0,1,0,0,0,1,1,1,0],[0,1,1,1,0,0,1,1,0,0,0,1,0,0,0,0],
      [0,0,1,1,0,0,0,1,0,0,0,0,0,0,0,0],[0,0,0,0,1,0,0,0,1,1,0,0,1,1,1,0],
      [0,0,0,0,0,0,0,0,1,0,0,0,1,1,0,0],[0,1,1,1,0,0,1,1,0,0,1,1,0,0,0,1],
      [0,0,1,1,0,0,0,1,0,0,0,1,0,0,0,0],[0,0,0,0,0,0,0,0,1,0,0,0,1,0,0,0],
      [0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0],[0,0,1,1,0,1,1,0,0,1,1,0,1,1,0,0],
      [0,0,0,1,0,1,1,1,1,1,1,0,1,0,0,0],[0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
      [0,1,1,1,0,0,0,1,1,0,0,0,1,1,1,0],[0,0,1,1,1,0,0,1,1,0,0,1,1,1,0,0],
      [0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1],[0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1],
      [0,1,0,1,1,0,1,0,0,1,0,1,1,0,1,0],[0,0,1,1,0,0,1,1,1,1,0,0,1,1,0,0],
      [0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0],[0,1,0,1,0,1,0,1,1,0,1,0,1,0,1,0],
      [0,1,1,0,1,0,0,1,0,1,1,0,1,0,0,1],[0,1,0,1,1,0,1,0,1,0,1,0,0,1,0,1],
      [0,1,1,1,0,0,1,1,1,1,0,0,1,1,1,0],[0,0,0,1,0,0,1,1,1,1,0,0,1,0,0,0],
      [0,0,1,1,0,0,1,0,0,1,0,0,1,1,0,0],[0,0,1,1,1,0,1,1,1,1,0,1,1,1,0,0],
      [0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0],[0,0,1,1,1,1,0,0,1,1,0,0,0,0,1,1],
      [0,1,1,0,0,1,1,0,1,0,0,1,1,0,0,1],[0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0],
      [0,1,0,0,1,1,1,0,0,1,0,0,0,0,0,0],[0,0,1,0,0,1,1,1,0,0,1,0,0,0,0,0],
      [0,0,0,0,0,0,1,0,0,1,1,1,0,0,1,0],[0,0,0,0,0,1,0,0,1,1,1,0,0,1,0,0],
      [0,1,1,0,1,1,0,0,1,0,0,1,0,0,1,1],[0,0,1,1,0,1,1,0,1,1,0,0,1,0,0,1],
      [0,1,1,0,0,0,1,1,1,0,0,1,1,1,0,0],[0,0,1,1,1,0,0,1,1,1,0,0,0,1,1,0],
      [0,1,1,0,1,1,0,0,1,1,0,0,1,0,0,1],[0,1,1,0,0,0,1,1,0,0,1,1,1,0,0,1],
      [0,1,1,1,1,1,1,0,1,0,0,0,0,0,0,1],[0,0,0,1,1,0,0,0,1,1,1,0,0,1,1,1],
      [0,0,0,0,1,1,1,1,0,0,1,1,0,0,1,1],[0,0,1,1,0,0,1,1,1,1,1,1,0,0,0,0],
      [0,0,1,0,0,0,1,0,1,1,1,0,1,1,1,0],[0,1,0,0,0,1,0,0,0,1,1,1,0,1,1,1],
    ];

    // Partition tables: 3-subset (64 entries, 16 values each)
    const P3 = [
      [0,0,1,1,0,0,1,1,0,2,2,1,2,2,2,2],[0,0,0,1,0,0,1,1,2,2,1,1,2,2,2,1],
      [0,0,0,0,2,0,0,1,2,2,1,1,2,2,1,1],[0,2,2,2,0,0,2,2,0,0,1,1,0,1,1,1],
      [0,0,0,0,0,0,0,0,1,1,2,2,1,1,2,2],[0,0,1,1,0,0,1,1,0,0,2,2,0,0,2,2],
      [0,0,2,2,0,0,2,2,1,1,1,1,1,1,1,1],[0,0,1,1,0,0,1,1,2,2,1,1,2,2,1,1],
      [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2],[0,0,0,0,1,1,1,1,1,1,1,1,2,2,2,2],
      [0,0,0,0,1,1,1,1,2,2,2,2,2,2,2,2],[0,0,1,2,0,0,1,2,0,0,1,2,0,0,1,2],
      [0,1,1,2,0,1,1,2,0,1,1,2,0,1,1,2],[0,1,2,2,0,1,2,2,0,1,2,2,0,1,2,2],
      [0,0,1,1,0,1,1,2,1,1,2,2,1,2,2,2],[0,0,1,1,2,0,0,1,2,2,0,0,2,2,2,0],
      [0,0,0,1,0,0,1,1,0,1,1,2,1,1,2,2],[0,1,1,1,0,0,1,1,2,0,0,1,2,2,0,0],
      [0,0,0,0,1,1,2,2,1,1,2,2,1,1,2,2],[0,0,2,2,0,0,2,2,0,0,2,2,1,1,1,1],
      [0,1,1,1,0,1,1,1,0,2,2,2,0,2,2,2],[0,0,0,1,0,0,0,1,2,2,2,1,2,2,2,1],
      [0,0,0,0,0,0,1,1,0,1,2,2,0,1,2,2],[0,0,0,0,1,1,0,0,2,2,1,0,2,2,1,0],
      [0,1,2,2,0,1,2,2,0,0,1,1,0,0,0,0],[0,0,1,2,0,0,1,2,1,1,2,2,2,2,2,2],
      [0,1,1,0,1,2,2,1,1,2,2,1,0,1,1,0],[0,0,0,0,0,1,1,0,1,2,2,1,1,2,2,1],
      [0,0,2,2,1,1,0,2,1,1,0,2,0,0,2,2],[0,1,1,0,0,1,1,0,2,0,0,2,2,2,2,2],
      [0,0,1,1,0,1,2,2,0,1,2,2,0,0,1,1],[0,0,0,0,2,0,0,0,2,2,1,1,2,2,2,1],
      [0,0,0,0,0,0,0,2,1,1,2,2,1,2,2,2],[0,2,2,2,0,0,2,2,0,0,1,2,0,0,1,1],
      [0,0,1,1,0,0,1,2,0,0,2,2,0,2,2,2],[0,1,2,0,0,1,2,0,0,1,2,0,0,1,2,0],
      [0,0,0,0,1,1,1,1,2,2,2,2,0,0,0,0],[0,1,2,0,1,2,0,1,2,0,1,2,0,1,2,0],
      [0,1,2,0,2,0,1,2,1,2,0,1,0,1,2,0],[0,0,1,1,2,2,0,0,1,1,2,2,0,0,1,1],
      [0,0,1,1,1,1,2,2,2,2,0,0,0,0,1,1],[0,1,0,1,0,1,0,1,2,2,2,2,2,2,2,2],
      [0,0,0,0,0,0,0,0,2,1,2,1,2,1,2,1],[0,0,2,2,1,1,2,2,0,0,2,2,1,1,2,2],
      [0,0,2,2,0,0,1,1,0,0,2,2,0,0,1,1],[0,2,2,0,1,2,2,1,0,2,2,0,1,2,2,1],
      [0,1,0,1,2,2,2,2,2,2,2,2,0,1,0,1],[0,0,0,0,2,1,2,1,2,1,2,1,2,1,2,1],
      [0,1,0,1,0,1,0,1,0,1,0,1,2,2,2,2],[0,2,2,2,0,1,1,1,0,2,2,2,0,1,1,1],
      [0,0,0,2,1,1,1,2,0,0,0,2,1,1,1,2],[0,0,0,0,2,1,1,2,2,1,1,2,2,1,1,2],
      [0,2,2,2,0,1,1,1,0,1,1,1,0,2,2,2],[0,0,0,2,1,1,1,2,1,1,1,2,0,0,0,2],
      [0,1,1,0,0,1,1,0,0,1,1,0,2,2,2,2],[0,0,0,0,0,0,0,0,2,1,1,2,2,1,1,2],
      [0,1,1,0,0,1,1,0,2,2,2,2,2,2,2,2],[0,0,2,2,0,0,1,1,0,0,1,1,0,0,2,2],
      [0,0,2,2,1,1,2,2,1,1,2,2,0,0,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,2,1,1,2],
      [0,0,0,2,0,0,0,1,0,0,0,2,0,0,0,1],[0,2,2,2,1,2,2,2,0,2,2,2,1,2,2,2],
      [0,1,0,1,2,2,2,2,2,2,2,2,2,2,2,2],[0,1,1,1,2,0,1,1,2,2,0,1,2,2,2,0],
    ];

    // Anchor index for second subset in 2-subset partitions
    const A2 = [
      15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,
      15, 2, 8, 2, 2, 8, 8,15, 2, 8, 2, 2, 8, 8, 2, 2,
       8, 2, 2, 8, 2, 2, 2, 8, 8, 2, 2, 2, 8, 8, 2, 8,
       2, 2, 8, 2, 2, 8, 2, 8, 2, 2, 2, 8, 2, 2, 2, 8,
    ];

    // Anchor indices for 3-subset partitions: second subset
    const A3a = [
       3, 3,15,15, 8, 3,15,15, 8, 8, 6, 6, 6, 5, 3, 3,
       3, 3, 8,15, 3, 3, 6,10, 5, 8, 8, 6, 8, 5,15,15,
       8,15, 3, 5, 6,10, 8,15,15, 3,15, 5,15,15,15,15,
       3,15, 5, 5, 5, 8, 5,10, 5,10, 8,13,15,12, 3, 3,
    ];

    // Anchor indices for 3-subset partitions: third subset
    const A3b = [
      15, 8, 8, 3,15,15, 3, 8,15,15,15,15,15,15,15, 8,
      15, 8,15, 3,15, 8,15, 8, 3,15, 6,10,15,15,10, 8,
      15, 3,15,10,10, 8, 9,10, 6,15, 8,15, 3, 6, 6, 8,
      15, 3,15,15,15,15,15,15,15,15,15,15, 3,15,15, 8,
    ];

    // Interpolation weight tables
    const W2 = [0, 21, 43, 64];
    const W3 = [0, 9, 18, 27, 37, 46, 55, 64];
    const W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

    // Mode definitions: [subsets, partBits, rotBits, idxSelBit, colorBits, alphaBits, epBits, spBits, idxBits, idx2Bits]
    const modeInfo = [
      [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],  // mode 0
      [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],  // mode 1
      [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],  // mode 2
      [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],  // mode 3
      [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],  // mode 4
      [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],  // mode 5
      [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],  // mode 6
      [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],  // mode 7
    ];

    // Bit reader for a 128-bit (16 byte) block — reads LSB first
    function makeBitReader(block, startByte) {
      let bytePos = 0;
      let bitPos = 0;
      return {
        read(n) {
          let val = 0;
          for (let i = 0; i < n; i++) {
            const byte = block[startByte + bytePos];
            val |= ((byte >> bitPos) & 1) << i;
            bitPos++;
            if (bitPos === 8) { bitPos = 0; bytePos++; }
          }
          return val;
        }
      };
    }

    // Unquantize an endpoint component from 'prec' bits to 8 bits using bit replication
    function unquant(val, prec) {
      if (prec >= 8) return val;
      // Bit replicate: shift up then fill low bits with top bits of val
      val = val << (8 - prec);
      val |= val >> prec;
      return val & 0xFF;
    }

    // Interpolate between two endpoint values using a weight (0..64)
    function interp(e0, e1, w) {
      return ((64 - w) * e0 + w * e1 + 32) >> 6;
    }

    let blockOffset = 0;
    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        const br = makeBitReader(data, blockOffset);

        // Determine mode: count leading zeros then read that bit
        let mode = -1;
        for (let m = 0; m < 8; m++) {
          if (br.read(1)) { mode = m; break; }
        }

        if (mode < 0) {
          // Reserved mode (all zeros) — output transparent black
          for (let row = 0; row < 4; row++) {
            for (let col = 0; col < 4; col++) {
              const px = bx * 4 + col;
              const py = by * 4 + row;
              if (px < width && py < height) {
                const dst = (py * width + px) * 4;
                rgba[dst] = 0; rgba[dst + 1] = 0; rgba[dst + 2] = 0; rgba[dst + 3] = 255;
              }
            }
          }
          blockOffset += 16;
          continue;
        }

        const mi = modeInfo[mode];
        const numSubsets = mi[0];
        const partBits = mi[1];
        const rotBits = mi[2];
        const hasIdxSel = mi[3];
        const colorPrec = mi[4];
        const alphaPrec = mi[5];
        const epBits = mi[6]; // per-endpoint p-bits
        const spBits = mi[7]; // shared p-bits
        const idxBits = mi[8];
        const idx2Bits = mi[9];

        // Read partition index
        const partIdx = partBits > 0 ? br.read(partBits) : 0;

        // Read rotation bits
        const rotation = rotBits > 0 ? br.read(rotBits) : 0;

        // Read index selection bit
        const idxSel = hasIdxSel ? br.read(1) : 0;

        // Number of endpoints = numSubsets * 2
        const numEndpoints = numSubsets * 2;

        // Read color endpoints
        const endpointsR = new Array(numEndpoints);
        const endpointsG = new Array(numEndpoints);
        const endpointsB = new Array(numEndpoints);
        const endpointsA = new Array(numEndpoints);

        // Color channels: R, G, B each 'colorPrec' bits per endpoint
        for (let i = 0; i < numEndpoints; i++) endpointsR[i] = br.read(colorPrec);
        for (let i = 0; i < numEndpoints; i++) endpointsG[i] = br.read(colorPrec);
        for (let i = 0; i < numEndpoints; i++) endpointsB[i] = br.read(colorPrec);

        // Alpha channel
        for (let i = 0; i < numEndpoints; i++) {
          endpointsA[i] = alphaPrec > 0 ? br.read(alphaPrec) : 255;
        }

        // P-bits: per-endpoint or shared
        const pBits = [];
        if (epBits) {
          for (let i = 0; i < numEndpoints; i++) pBits.push(br.read(1));
        } else if (spBits) {
          for (let i = 0; i < numSubsets; i++) {
            const bit = br.read(1);
            pBits.push(bit, bit); // shared between pair
          }
        }

        // Apply p-bits and unquantize endpoints
        const hasP = epBits || spBits;
        const cPrec = hasP ? colorPrec + 1 : colorPrec;
        const aPrec = hasP && alphaPrec > 0 ? alphaPrec + 1 : alphaPrec;

        for (let i = 0; i < numEndpoints; i++) {
          if (hasP) {
            endpointsR[i] = (endpointsR[i] << 1) | pBits[i];
            endpointsG[i] = (endpointsG[i] << 1) | pBits[i];
            endpointsB[i] = (endpointsB[i] << 1) | pBits[i];
            if (alphaPrec > 0) endpointsA[i] = (endpointsA[i] << 1) | pBits[i];
          }
          endpointsR[i] = unquant(endpointsR[i], cPrec);
          endpointsG[i] = unquant(endpointsG[i], cPrec);
          endpointsB[i] = unquant(endpointsB[i], cPrec);
          if (alphaPrec > 0) {
            endpointsA[i] = unquant(endpointsA[i], aPrec);
          }
        }

        // Get partition assignment and anchor indices
        const partitionTable = numSubsets === 3 ? P3[partIdx] : numSubsets === 2 ? P2[partIdx] : null;

        // Build per-subset anchor: anchor pixel for each subset (has one fewer index bit)
        const subsetAnchors = new Array(numSubsets);
        subsetAnchors[0] = 0;
        if (numSubsets >= 2) {
          if (numSubsets === 2) {
            subsetAnchors[1] = A2[partIdx];
          } else {
            subsetAnchors[1] = A3a[partIdx];
            subsetAnchors[2] = A3b[partIdx];
          }
        }

        // Read primary index bits
        const primaryIndices = new Array(16);
        for (let i = 0; i < 16; i++) {
          const subset = partitionTable ? partitionTable[i] : 0;
          // Anchor pixels have one fewer bit
          const isAnchor = (i === subsetAnchors[subset]);
          const bits = isAnchor ? idxBits - 1 : idxBits;
          primaryIndices[i] = br.read(bits);
        }

        // Read secondary index bits (modes 4, 5)
        const secondaryIndices = new Array(16);
        if (idx2Bits > 0) {
          for (let i = 0; i < 16; i++) {
            // Secondary index: anchor is always pixel 0 (single subset)
            const bits = i === 0 ? idx2Bits - 1 : idx2Bits;
            secondaryIndices[i] = br.read(bits);
          }
        }

        // Select weight tables for color and alpha
        let colorWeights, alphaWeights;
        if (idx2Bits > 0) {
          const primW = idxBits === 2 ? W2 : idxBits === 3 ? W3 : W4;
          const secW = idx2Bits === 2 ? W2 : idx2Bits === 3 ? W3 : W4;
          if (idxSel === 0) {
            // Primary for color, secondary for alpha
            colorWeights = primW;
            alphaWeights = secW;
          } else {
            // Primary for alpha, secondary for color
            colorWeights = secW;
            alphaWeights = primW;
          }
        } else {
          colorWeights = idxBits === 2 ? W2 : idxBits === 3 ? W3 : W4;
          alphaWeights = colorWeights;
        }

        // Decode pixels
        for (let row = 0; row < 4; row++) {
          for (let col = 0; col < 4; col++) {
            const px = bx * 4 + col;
            const py = by * 4 + row;
            if (px >= width || py >= height) continue;

            const pix = row * 4 + col;
            const subset = partitionTable ? partitionTable[pix] : 0;
            const ep0 = subset * 2;
            const ep1 = subset * 2 + 1;

            // Get color and alpha weights
            let cIdx, aIdx;
            if (idx2Bits > 0) {
              if (idxSel === 0) {
                cIdx = primaryIndices[pix];
                aIdx = secondaryIndices[pix];
              } else {
                cIdx = secondaryIndices[pix];
                aIdx = primaryIndices[pix];
              }
            } else {
              cIdx = primaryIndices[pix];
              aIdx = cIdx;
            }

            const cw = colorWeights[cIdx];
            const aw = alphaWeights[aIdx];

            let r = interp(endpointsR[ep0], endpointsR[ep1], cw);
            let g = interp(endpointsG[ep0], endpointsG[ep1], cw);
            let b = interp(endpointsB[ep0], endpointsB[ep1], cw);
            let a = alphaPrec > 0 ? interp(endpointsA[ep0], endpointsA[ep1], aw) : 255;

            // Apply rotation: swap alpha with the specified channel
            if (rotation === 1) { const t = a; a = r; r = t; }
            else if (rotation === 2) { const t = a; a = g; g = t; }
            else if (rotation === 3) { const t = a; a = b; b = t; }

            const dst = (py * width + px) * 4;
            rgba[dst] = r; rgba[dst + 1] = g; rgba[dst + 2] = b; rgba[dst + 3] = a;
          }
        }

        blockOffset += 16;
      }
    }
    return rgba;
  }

  /* ================================================================ */
  /*  TGA Decoder                                                     */
  /* ================================================================ */

  function decodeTGA(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const idLen = bytes[0];
    const colorMapType = bytes[1];
    const imageType = bytes[2];
    const width = view.getUint16(12, true);
    const height = view.getUint16(14, true);
    const bpp = bytes[16];
    const descriptor = bytes[17];
    const topToBottom = (descriptor & 0x20) !== 0;

    let offset = 18 + idLen;

    // Skip color map if present
    if (colorMapType === 1) {
      const cmLength = view.getUint16(5, true);
      const cmEntrySize = bytes[7];
      offset += cmLength * Math.ceil(cmEntrySize / 8);
    }

    const pixelCount = width * height;
    const rgba = new Uint8Array(pixelCount * 4);
    const bytesPerPixel = bpp / 8;

    const isRLE = imageType === 10 || imageType === 11;
    const isGray = imageType === 3 || imageType === 11;

    if (isRLE) {
      let pixIdx = 0;
      while (pixIdx < pixelCount && offset < bytes.length) {
        const header = bytes[offset++];
        const count = (header & 0x7f) + 1;
        if (header & 0x80) {
          // RLE run
          const pixel = readTGAPixel(bytes, offset, bytesPerPixel, isGray);
          offset += bytesPerPixel;
          for (let i = 0; i < count && pixIdx < pixelCount; i++, pixIdx++) {
            const dst = pixIdx * 4;
            rgba[dst] = pixel[0]; rgba[dst + 1] = pixel[1]; rgba[dst + 2] = pixel[2]; rgba[dst + 3] = pixel[3];
          }
        } else {
          // Raw run
          for (let i = 0; i < count && pixIdx < pixelCount; i++, pixIdx++) {
            const pixel = readTGAPixel(bytes, offset, bytesPerPixel, isGray);
            offset += bytesPerPixel;
            const dst = pixIdx * 4;
            rgba[dst] = pixel[0]; rgba[dst + 1] = pixel[1]; rgba[dst + 2] = pixel[2]; rgba[dst + 3] = pixel[3];
          }
        }
      }
    } else {
      // Uncompressed
      for (let i = 0; i < pixelCount; i++) {
        const pixel = readTGAPixel(bytes, offset, bytesPerPixel, isGray);
        offset += bytesPerPixel;
        const dst = i * 4;
        rgba[dst] = pixel[0]; rgba[dst + 1] = pixel[1]; rgba[dst + 2] = pixel[2]; rgba[dst + 3] = pixel[3];
      }
    }

    // Flip if bottom-to-top (default TGA orientation)
    if (!topToBottom) {
      for (let y = 0; y < Math.floor(height / 2); y++) {
        const topOff = y * width * 4;
        const botOff = (height - 1 - y) * width * 4;
        for (let x = 0; x < width * 4; x++) {
          const tmp = rgba[topOff + x];
          rgba[topOff + x] = rgba[botOff + x];
          rgba[botOff + x] = tmp;
        }
      }
    }

    return { width, height, rgba };
  }

  function readTGAPixel(bytes, offset, bytesPerPixel, isGray) {
    if (isGray) {
      const g = bytes[offset];
      const a = bytesPerPixel >= 2 ? bytes[offset + 1] : 255;
      return [g, g, g, a];
    }
    if (bytesPerPixel === 3) {
      return [bytes[offset + 2], bytes[offset + 1], bytes[offset], 255]; // BGR → RGB
    }
    if (bytesPerPixel === 4) {
      return [bytes[offset + 2], bytes[offset + 1], bytes[offset], bytes[offset + 3]]; // BGRA → RGBA
    }
    // 2 bytes: RGB555
    const val = bytes[offset] | (bytes[offset + 1] << 8);
    return [
      ((val >> 10) & 0x1f) * 255 / 31 | 0,
      ((val >> 5) & 0x1f) * 255 / 31 | 0,
      (val & 0x1f) * 255 / 31 | 0,
      255,
    ];
  }

  /* ================================================================ */
  /*  Utility                                                         */
  /* ================================================================ */

  function base64ToUint8(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function toArrayBuffer(bytes) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      return bytes.buffer;
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

})();
