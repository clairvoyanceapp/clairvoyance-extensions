/**
 * Media Vault — Shared Utilities
 * Common helpers used by both sidebar.html and viewer.html
 */

/* ------------------------------------------------------------------ */
/*  API Bridge                                                        */
/* ------------------------------------------------------------------ */

async function waitForApi(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (window.clairvoyance) return resolve(window.clairvoyance);

    const started = Date.now();
    const tryResolve = () => {
      if (!window.clairvoyance) return false;
      window.removeEventListener('clairvoyance-ready', onReady);
      window.removeEventListener('message', onMessage);
      resolve(window.clairvoyance);
      return true;
    };

    const onReady = () => tryResolve();
    const onMessage = (event) => {
      if (event?.data?.type === 'clairvoyance-ready') tryResolve();
    };

    window.addEventListener('clairvoyance-ready', onReady);
    window.addEventListener('message', onMessage);

    const tick = () => {
      if (tryResolve()) return;
      if (Date.now() - started > timeoutMs) {
        window.removeEventListener('clairvoyance-ready', onReady);
        window.removeEventListener('message', onMessage);
        reject(new Error('Timed out waiting for Clairvoyance API'));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/* ------------------------------------------------------------------ */
/*  Cross-Iframe Event Channel                                        */
/* ------------------------------------------------------------------ */

const EXTENSION_EVENT_CHANNEL_NAME = 'clairvoyance-media-vault-events';
let extensionEventChannel = undefined;

function getExtensionEventChannel() {
  if (extensionEventChannel !== undefined) return extensionEventChannel;
  extensionEventChannel = null;

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      extensionEventChannel = new BroadcastChannel(EXTENSION_EVENT_CHANNEL_NAME);
    }
  } catch (_) {
    extensionEventChannel = null;
  }

  return extensionEventChannel;
}

function broadcastExtensionEvent(type, payload) {
  const channel = getExtensionEventChannel();
  if (!channel || !type) return false;
  channel.postMessage({ type, payload, at: Date.now() });
  return true;
}

function onExtensionEvent(type, handler) {
  const channel = getExtensionEventChannel();
  if (!channel || !type || typeof handler !== 'function') {
    return () => {};
  }

  const wrapped = (event) => {
    if (event?.data?.type === type) {
      handler(event.data.payload);
    }
  };

  if (typeof channel.addEventListener === 'function') {
    channel.addEventListener('message', wrapped);
    return () => channel.removeEventListener('message', wrapped);
  }

  channel.onmessage = wrapped;
  return () => {
    if (channel.onmessage === wrapped) {
      channel.onmessage = null;
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Asset Type Definitions                                            */
/* ------------------------------------------------------------------ */

const ASSET_TYPES = {
  '3d':      { label: '3D Models',  extensions: ['.fbx', '.obj', '.gltf', '.glb'], color: '#c27ba0', icon: 'cube' },
  texture:   { label: 'Textures',   extensions: ['.dds', '.tga', '.hdr', '.exr'],   color: '#ab47bc', icon: 'grid' },
  image:     { label: 'Images',     extensions: ['.png', '.jpg', '.jpeg', '.bmp', '.svg', '.webp', '.gif', '.psd', '.ico'], color: '#c27ba0', icon: 'image' },
};

const ALL_ASSET_EXTENSIONS = Object.values(ASSET_TYPES).flatMap(t => t.extensions);

function getAssetCategory(filename) {
  const ext = getFileExtension(filename);
  for (const [category, def] of Object.entries(ASSET_TYPES)) {
    if (def.extensions.includes(ext)) return category;
  }
  return null;
}

function getAssetColor(filename) {
  const cat = getAssetCategory(filename);
  if (cat) return ASSET_TYPES[cat].color;
  return 'var(--text-muted)';
}

/* ------------------------------------------------------------------ */
/*  File Helpers                                                      */
/* ------------------------------------------------------------------ */

function getFileExtension(filename) {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.substring(dot).toLowerCase() : '';
}

function getFileName(path) {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || '';
}

function getDirectory(path) {
  const norm = path.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  return slash >= 0 ? norm.substring(0, slash) : '';
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function isImageFile(filename) {
  const ext = getFileExtension(filename);
  return ['.png', '.jpg', '.jpeg', '.bmp', '.svg', '.webp', '.gif', '.ico'].includes(ext);
}

function isNativeImageFile(filename) {
  // Formats the browser can display natively via <img> or data URI
  const ext = getFileExtension(filename);
  return ['.png', '.jpg', '.jpeg', '.bmp', '.svg', '.webp', '.gif', '.ico'].includes(ext);
}

function isTextureFile(filename) {
  const ext = getFileExtension(filename);
  return ['.dds', '.tga', '.hdr', '.exr'].includes(ext);
}

function is3DFile(filename) {
  const ext = getFileExtension(filename);
  return ['.fbx', '.obj', '.gltf', '.glb'].includes(ext);
}

function getMimeType(filename) {
  const ext = getFileExtension(filename);
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.tga': 'image/x-tga', '.dds': 'image/vnd-ms.dds',
    '.hdr': 'image/vnd.radiance', '.exr': 'image/x-exr',
    '.psd': 'image/vnd.adobe.photoshop',
    '.fbx': 'application/octet-stream', '.obj': 'model/obj',
    '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary',
  };
  return map[ext] || 'application/octet-stream';
}

/* ------------------------------------------------------------------ */
/*  SVG Icons (inline, Lucide-style 16px)                             */
/* ------------------------------------------------------------------ */

const ICONS = {
  chevronLeft: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  chevronRight: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  folder: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e8a838" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  folderOpen: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e8a838" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h4a2 2 0 0 1 2 2v1"/><path d="M20.27 9H7.73a1 1 0 0 0-.98.8L5 19h14l1.75-8.2a1 1 0 0 0-.98-1.2z"/></svg>`,
  file: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  image: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`,
  cube: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
  grid: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>`,
  filter: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`,
  list: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>`,
  gridView: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>`,
  search: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
  refresh: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>`,
  zoomIn: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/></svg>`,
  zoomOut: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/></svg>`,
  maximize: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`,
  info: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
  play: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>`,
  pause: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="4" height="16" x="6" y="4"/><rect width="4" height="16" x="14" y="4"/></svg>`,
  x: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  layers: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2.4a1.5 1.5 0 0 0-.72.18l-8.4 4.2A1 1 0 0 0 2.4 8a1 1 0 0 0 .48.82l8.4 4.2a1.5 1.5 0 0 0 1.44 0l8.4-4.2A1 1 0 0 0 21.6 8a1 1 0 0 0-.48-.82l-8.4-4.6A1.5 1.5 0 0 0 12 2.4Z" opacity=".9"/><path d="M3.16 11.4 12 15.8l8.84-4.4.88.44a1 1 0 0 1 0 1.76l-8.88 4.44a1.5 1.5 0 0 1-1.44 0L2.28 13.6a1 1 0 0 1 0-1.76Z" opacity=".6"/><path d="M3.16 15.4 12 19.8l8.84-4.4.88.44a1 1 0 0 1 0 1.76l-8.88 4.44a1.5 1.5 0 0 1-1.44 0L2.28 17.6a1 1 0 0 1 0-1.76Z" opacity=".35"/></svg>`,
};

function icon(name, color) {
  let svg = ICONS[name] || ICONS.file;
  if (color) {
    svg = svg.replace(/stroke="currentColor"/, `stroke="${color}"`);
  }
  return svg;
}

/* ------------------------------------------------------------------ */
/*  Storage Keys                                                      */
/* ------------------------------------------------------------------ */

const STORAGE_KEYS = {
  viewMode: 'media-vault:viewMode',
  filter: 'media-vault:filter',
  expandedFolders: 'media-vault:expandedFolders',
  assetIndexCache: 'media-vault:assetIndexCache',
  thumbnailCache: 'media-vault:thumbnails',
  currentSelection: 'media-vault:currentSelection',
  favorites: 'media-vault:favorites',
  recentFiles: 'media-vault:recentFiles',
  gridSize: 'media-vault:gridSize',
};

/* ------------------------------------------------------------------ */
/*  Tree Builder                                                      */
/* ------------------------------------------------------------------ */

/**
 * Convert a flat file list into a nested tree structure.
 * Each node: { name, path, relativePath, type, children?, depth }
 */
function buildFileTree(files) {
  const root = { name: '', path: '', relativePath: '', type: 'directory', children: [], depth: -1 };
  const dirMap = new Map();
  dirMap.set('', root);

  // Sort so directories come first, then alphabetical
  const sorted = [...files].sort((a, b) => {
    const aParts = a.relativePath.split('/');
    const bParts = b.relativePath.split('/');
    // Compare path segments to get natural directory order
    for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
      if (aParts[i] !== bParts[i]) return aParts[i].localeCompare(bParts[i]);
    }
    return aParts.length - bParts.length;
  });

  for (const file of sorted) {
    const parts = file.relativePath.split('/');
    // Ensure all parent directories exist
    let currentPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const parentPath = currentPath;
      currentPath = currentPath ? currentPath + '/' + parts[i] : parts[i];
      if (!dirMap.has(currentPath)) {
        const dirNode = {
          name: parts[i],
          path: file.path.substring(0, file.path.lastIndexOf(parts.slice(i + 1).join('/'))).replace(/[/\\]+$/, ''),
          relativePath: currentPath,
          type: 'directory',
          children: [],
          depth: i,
        };
        dirMap.set(currentPath, dirNode);
        const parent = dirMap.get(parentPath) || root;
        parent.children.push(dirNode);
      }
    }

    // Directories: register in dirMap so they're expandable (don't add as leaf)
    if (file.type === 'directory') {
      if (!dirMap.has(file.relativePath)) {
        const dirNode = {
          ...file,
          children: [],
          depth: parts.length - 1,
        };
        dirMap.set(file.relativePath, dirNode);
        const parentDirPath = parts.slice(0, -1).join('/');
        const parent = dirMap.get(parentDirPath) || root;
        parent.children.push(dirNode);
      }
      continue;
    }

    // Add file node
    const parentDirPath = parts.slice(0, -1).join('/');
    const parent = dirMap.get(parentDirPath) || root;
    parent.children.push({
      ...file,
      depth: parts.length - 1,
      children: undefined,
    });
  }

  // Sort each directory's children: folders first, then files, alphabetical within each group
  const sortChildren = (node) => {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    node.children.forEach(sortChildren);
  };
  sortChildren(root);

  return root.children;
}
