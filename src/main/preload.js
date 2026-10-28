'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  pty: {
    create: (options) => ipcRenderer.invoke('pty:create', options),
    write: (id, data) => ipcRenderer.send('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('pty:kill', { id }),
    onData: (callback) => subscribe('pty:data', callback),
    onExit: (callback) => subscribe('pty:exit', callback),
  },
  clipboard: {
    readText: () => ipcRenderer.sendSync('clipboard:read'),
    writeText: (text) => {
      ipcRenderer.sendSync('clipboard:write', String(text ?? ''));
    },
  },
  voice: {
    start: () => ipcRenderer.invoke('voice:start'),
    stop: () => ipcRenderer.invoke('voice:stop'),
    typing: () => ipcRenderer.invoke('voice:typing'),
    onText: (callback) => subscribe('voice:text', callback),
    onPartial: (callback) => subscribe('voice:partial', callback),
    onState: (callback) => subscribe('voice:state', callback),
  },
  director: {
    start: (options) => ipcRenderer.invoke('director:start', options),
    send: (text, options = {}) => ipcRenderer.invoke('director:send', { ...options, text }),
    stop: () => ipcRenderer.invoke('director:stop'),
    onEvent: (callback) => subscribe('director:event', callback),
  },
  chats: {
    save: (chat) => ipcRenderer.invoke('chat:save', chat),
    load: (id) => ipcRenderer.invoke('chat:load', id),
    list: () => ipcRenderer.invoke('chat:list'),
    remove: (id) => ipcRenderer.invoke('chat:delete', id),
  },
  claude: {
    send: (payload) => ipcRenderer.invoke('claude:send', payload),
    authStatus: () => ipcRenderer.invoke('claude:auth-status'),
    setupConsole: (action) => ipcRenderer.invoke('claude:setup-console', { action }),
    cancel: (payload) => ipcRenderer.send('claude:cancel', payload),
    onEvent: (callback) => subscribe('claude:event', callback),
  },
  radio: {
    search: (payload) => ipcRenderer.invoke('radio:search', payload),
  },
  control: {
    onRequest: (callback) => subscribe('control:request', callback),
    respond: (payload) => ipcRenderer.send('control:response', payload),
  },
  context: {
    read: () => ipcRenderer.invoke('context:read'),
    sync: (content) => ipcRenderer.invoke('context:sync', content),
  },
  contextLog: {
    list: (options) => ipcRenderer.invoke('context-log:list', options),
    paths: (options) => ipcRenderer.invoke('context-log:paths', options),
    onUpdated: (callback) => subscribe('context-log:updated', callback),
  },
  joint: {
    create: (payload) => ipcRenderer.invoke('joint:create', payload),
    read: (id) => ipcRenderer.invoke('joint:read', id),
    write: (payload) => ipcRenderer.invoke('joint:write', payload),
  },
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    reload: () => ipcRenderer.send('win:reload'),
    capture: (rect) => ipcRenderer.invoke('win:capture', rect),
    captureWeb: (payload) => ipcRenderer.invoke('web:capture', payload),
    onMaximized: (callback) => subscribe('win:maximized', callback),
  },
  sys: {
    info: () => ipcRenderer.invoke('sys:info'),
    pickFolder: (startPath) => ipcRenderer.invoke('dialog:pick-folder', startPath),
    pickImage: () => ipcRenderer.invoke('dialog:pick-image'),
    readImage: (filePath) => ipcRenderer.invoke('sys:read-image', filePath),
    openExternal: (url) => ipcRenderer.invoke('sys:open-external', url),
  },
});
