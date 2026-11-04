// Exposes a small, explicit native API to the renderer as window.spreadNative.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const paths = ipcRenderer.sendSync('get-paths');

contextBridge.exposeInMainWorld('spreadNative', {
  platform: process.platform,
  homeDir: paths.home,
  picturesDir: paths.pictures,
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  writeFile: (opts) => ipcRenderer.invoke('write-file', opts),
  openFile: (opts) => ipcRenderer.invoke('open-file', opts),
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  pickDirectory: (opts) => ipcRenderer.invoke('pick-directory', opts),
  listDir: (dir) => ipcRenderer.invoke('list-dir', dir),
  makeDir: (opts) => ipcRenderer.invoke('make-dir', opts),
  // Accepts writeFiles({ dir, files }) or writeFiles(dir, files).
  writeFiles: (dirOrOpts, files) =>
    ipcRenderer.invoke('write-files', typeof dirOrOpts === 'string' ? { dir: dirOrOpts, files } : dirOrOpts),
  listFiles: (paths, exts) => ipcRenderer.invoke('list-files', { paths, exts }),
  reveal: (path) => ipcRenderer.invoke('reveal', path),
  printPdf: (opts) => ipcRenderer.invoke('print-pdf', opts),
  setDirty: (v) => ipcRenderer.invoke('set-dirty', v),
  brandsList: () => ipcRenderer.invoke('brands-list'),
  brandSave: (opts) => ipcRenderer.invoke('brand-save', opts),
  brandWriteFont: (opts) => ipcRenderer.invoke('brand-write-font', opts),
  brandDelete: (id) => ipcRenderer.invoke('brand-delete', id),
  libraryList: (kind) => ipcRenderer.invoke('library-list', kind),
  librarySave: (opts) => ipcRenderer.invoke('library-save', opts),
  libraryDelete: (opts) => ipcRenderer.invoke('library-delete', opts),
  hostingStatus: () => ipcRenderer.invoke('hosting-status'),
  hostingConnect: (opts) => ipcRenderer.invoke('hosting-connect', opts),
  hostingDisconnect: () => ipcRenderer.invoke('hosting-disconnect'),
  hostingUpload: (opts) => ipcRenderer.invoke('hosting-upload', opts),
  claudeStatus: () => ipcRenderer.invoke('claude-status'),
  claudeConnect: (target) => ipcRenderer.invoke(target === 'desktop' ? 'claude-connect-desktop' : 'claude-connect-code'),
  claudeDisconnectCode: () => ipcRenderer.invoke('claude-disconnect-code'),
  chatOpen: (key) => ipcRenderer.invoke('chat-open', key),
  chatSend: (opts) => ipcRenderer.invoke('chat-send', opts),
  chatRetry: (key) => ipcRenderer.invoke('chat-retry', key),
  chatStop: (key) => ipcRenderer.invoke('chat-stop', key),
  chatReset: (key) => ipcRenderer.invoke('chat-reset', key),
  chatRename: (opts) => ipcRenderer.invoke('chat-rename', opts),
  chatApprove: (opts) => ipcRenderer.invoke('chat-approve', opts),
  chatAnswer: (opts) => ipcRenderer.invoke('chat-answer', opts),
  chatLogin: () => ipcRenderer.invoke('chat-login'),
  chatDesignDocs: (dir) => ipcRenderer.invoke('chat-design-docs', dir),
  onChatUpdate: (cb) => {
    const listener = (_e, u) => cb(u);
    ipcRenderer.on('chat-update', listener);
    return () => ipcRenderer.removeListener('chat-update', listener);
  },
  /** The path on disk of a file dropped from the Finder. */
  pathForFile: (file) => webUtils.getPathForFile(file),
  onOpenPath: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('open-path', listener);
    return () => ipcRenderer.removeListener('open-path', listener);
  },
  onAutomationRequest: (cb) => {
    const listener = (_e, req) => cb(req);
    ipcRenderer.on('automation-request', listener);
    return () => ipcRenderer.removeListener('automation-request', listener);
  },
  respondAutomation: (resp) => ipcRenderer.send('automation-response', resp),
});
