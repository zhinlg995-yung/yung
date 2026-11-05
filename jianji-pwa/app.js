'use strict';

const DB_NAME = 'jianji-local-db';
const DB_VERSION = 2;
const STORE_NAME = 'app-state';
const ATTACH_STORE = 'attachments';
const MAX_IMAGE_EDGE = 1600;
const JPEG_QUALITY = 0.85;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const STATE_KEY = 'main';
const LEGACY_KEY = 'jianji-state-v1';

const $ = (selector) => document.querySelector(selector);
const els = {
  sidebar: $('#sidebar'), folderList: $('#folderList'), notesList: $('#notesList'),
  allCount: $('#allCount'), taskCount: $('#taskCount'), topbarTitle: $('#topbarTitle'),
  sectionTitle: $('#sectionTitle'), sectionSubtitle: $('#sectionSubtitle'), sectionKicker: $('#sectionKicker'),
  resultCount: $('#resultCount'), searchInput: $('#searchInput'), saveStatus: $('#saveStatus'),
  emptyEditor: $('#emptyEditor'), noteEditor: $('#noteEditor'), noteTitle: $('#noteTitleInput'),
  noteContent: $('#noteContentInput'), plainBody: $('#plainNoteBody'), taskBody: $('#taskNoteBody'),
  noteTypeLabel: $('#noteTypeLabel'), noteFolder: $('#noteFolderSelect'), noteDate: $('#noteDateLabel'),
  wordCount: $('#noteWordCount'), pinButton: $('#pinButton'), taskItems: $('#taskItems'),
  newTaskInput: $('#newTaskInput'), progressFill: $('#progressFill'), progressText: $('#progressText'),
  folderDialog: $('#folderDialog'), folderForm: $('#folderForm'), folderDialogTitle: $('#folderDialogTitle'),
  folderName: $('#folderNameInput'), deleteFolder: $('#deleteFolderButton'), toast: $('#toast'), importFile: $('#importFile'),
  attachImageButton: $('#attachImageButton'), attachFileButton: $('#attachFileButton'),
  attachImageInput: $('#attachImageInput'), attachFileInput: $('#attachFileInput'),
  attachGallery: $('#attachGallery'), attachFiles: $('#attachFiles'), attachSummary: $('#attachSummary'),
  imageDialog: $('#imageDialog'), viewerImage: $('#viewerImage'), viewerName: $('#viewerName'), viewerSave: $('#viewerSave'),
  confirmDialog: $('#confirmDialog'), confirmTitle: $('#confirmTitle'), confirmMessage: $('#confirmMessage'), confirmOk: $('#confirmOkButton')
};

let state = null;
let dbPromise = null;
let saveTimer = null;
let toastTimer = null;
let editingFolderId = null;
let isSaving = false;
let attachRenderToken = 0;
const objectUrls = new Map();

function makeId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function initialState() {
  const now = new Date().toISOString();
  return {
    version: 1,
    folders: [{ id: 'folder_default', name: '默认文件夹', createdAt: now }],
    notes: [{
      id: 'note_welcome', folderId: 'folder_default', type: 'note', title: '欢迎使用简记',
      content: '这里是你的私人笔记空间。\n\n• 点击左侧「新建笔记」记录想法。\n• 使用文件夹整理不同主题。\n• 创建待办清单，勾选完成的事项。\n• 点击笔记里的「图片」「文件」可以添加照片和附件。\n• 搜索可以查找标题、正文、待办内容和附件名称。\n\n笔记默认保存在这台设备的浏览器本地。建议定期使用左下角的「备份笔记」导出 JSON 文件，妥善保存备份。',
      tasks: [], attachments: [], pinned: true, createdAt: now, updatedAt: now
    }],
    activeFolderId: 'all',
    activeNoteId: 'note_welcome'
  };
}

function openDatabase() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('当前浏览器不支持本地数据库'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        // v1 -> v2：保留原有的 app-state（笔记），只新增附件仓库。
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(ATTACH_STORE)) {
          const store = db.createObjectStore(ATTACH_STORE, { keyPath: 'id' });
          store.createIndex('noteId', 'noteId', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('无法打开本地数据库'));
      request.onblocked = () => reject(new Error('本地数据库正在被其他页面占用，请关闭重复打开的页面'));
    });
  }
  return dbPromise;
}

async function readFromDatabase() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);
    request.onsuccess = () => resolve(request.result ? request.result.value : null);
    request.onerror = () => reject(request.error || new Error('读取本地笔记失败'));
  });
}

async function writeToDatabase(value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({ key: STATE_KEY, value });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('保存本地笔记失败'));
    transaction.onabort = () => reject(transaction.error || new Error('保存已中断'));
  });
}

function putAttachment(record) {
  return openDatabase().then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction(ATTACH_STORE, 'readwrite');
    transaction.objectStore(ATTACH_STORE).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('保存附件失败'));
    transaction.onabort = () => reject(transaction.error || new Error('存储空间不足或保存已中断'));
  }));
}

function getAttachment(id) {
  return openDatabase().then(db => new Promise((resolve, reject) => {
    const request = db.transaction(ATTACH_STORE, 'readonly').objectStore(ATTACH_STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('读取附件失败'));
  }));
}

function deleteAttachments(ids) {
  if (!ids.length) return Promise.resolve();
  return openDatabase().then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction(ATTACH_STORE, 'readwrite');
    const store = transaction.objectStore(ATTACH_STORE);
    ids.forEach(id => store.delete(id));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('删除附件失败'));
    transaction.onabort = () => reject(transaction.error || new Error('删除附件失败'));
  }));
}

// 导入备份时：一次事务内同时替换笔记状态和全部附件，避免只导入一半。
function replaceAllData(value, records) {
  return openDatabase().then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, ATTACH_STORE], 'readwrite');
    transaction.objectStore(STORE_NAME).put({ key: STATE_KEY, value });
    const store = transaction.objectStore(ATTACH_STORE);
    store.clear();
    records.forEach(record => store.put(record));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('导入失败'));
    transaction.onabort = () => reject(transaction.error || new Error('存储空间不足，导入已取消，原有数据未改变'));
  }));
}

function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(a => a && typeof a.id === 'string' && typeof a.name === 'string')
    .map(a => ({
      id: a.id,
      name: a.name.slice(0, 200),
      type: typeof a.type === 'string' ? a.type : '',
      size: Number.isFinite(a.size) ? a.size : 0,
      kind: a.kind === 'image' ? 'image' : 'file',
      createdAt: a.createdAt || new Date().toISOString()
    }));
}

function normalizeState(candidate) {
  if (!candidate || !Array.isArray(candidate.folders) || !Array.isArray(candidate.notes)) {
    throw new Error('备份文件格式不正确。');
  }
  const folders = candidate.folders
    .filter(f => f && typeof f.id === 'string' && typeof f.name === 'string')
    .map(f => ({ id: f.id, name: f.name.slice(0, 30), createdAt: f.createdAt || new Date().toISOString() }));
  if (!folders.some(f => f.id === 'folder_default')) folders.unshift({ id: 'folder_default', name: '默认文件夹', createdAt: new Date().toISOString() });
  const folderIds = new Set(folders.map(f => f.id));
  const notes = candidate.notes
    .filter(n => n && typeof n.id === 'string')
    .map(n => ({
      id: n.id,
      folderId: folderIds.has(n.folderId) ? n.folderId : 'folder_default',
      type: n.type === 'tasks' ? 'tasks' : 'note',
      title: typeof n.title === 'string' ? n.title.slice(0, 120) : '',
      content: typeof n.content === 'string' ? n.content : '',
      tasks: Array.isArray(n.tasks) ? n.tasks.filter(t => t && typeof t.text === 'string').map(t => ({ id: typeof t.id === 'string' ? t.id : makeId('task'), text: t.text.slice(0, 180), done: Boolean(t.done) })) : [],
      attachments: normalizeAttachments(n.attachments),
      pinned: Boolean(n.pinned),
      createdAt: n.createdAt || new Date().toISOString(),
      updatedAt: n.updatedAt || new Date().toISOString()
    }));
  return { version: 1, folders, notes, activeFolderId: 'all', activeNoteId: notes[0]?.id || null };
}

async function loadState() {
  try {
    const saved = await readFromDatabase();
    if (saved) return normalizeState(saved);
  } catch (error) {
    console.warn('IndexedDB load issue:', error);
  }
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed = normalizeState(JSON.parse(legacy));
      try { await writeToDatabase(parsed); localStorage.removeItem(LEGACY_KEY); } catch (_) { /* use in-memory state */ }
      return parsed;
    }
  } catch (error) {
    console.warn('Legacy storage could not be read:', error);
  }
  return initialState();
}

function setSaveStatus(label, busy = false) {
  isSaving = busy;
  els.saveStatus.innerHTML = `<span class="status-dot"></span> ${label}`;
  els.saveStatus.classList.toggle('saving', busy);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!state) return;
  setSaveStatus('正在保存…', true);
  const snapshot = JSON.parse(JSON.stringify(state));
  try {
    await writeToDatabase(snapshot);
    setSaveStatus('已保存在此设备');
  } catch (error) {
    console.error(error);
    try {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(snapshot));
      setSaveStatus('已保存（备用存储）');
    } catch (fallbackError) {
      setSaveStatus('保存失败，请先导出备份');
      showToast('本机存储不可用，请导出备份并检查浏览器设置。');
    }
  }
}

function scheduleSave() {
  setSaveStatus('正在保存…', true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 280);
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

// iPhone 主屏幕 PWA 里 window.confirm/alert 常被系统直接吞掉或立刻返回 false，
// 导致删除笔记、附件等操作看起来“点了没反应”。统一改用应用内确认框。
function askConfirm(message, { title = '确认操作', okText = '删除', cancelText = '取消' } = {}) {
  return new Promise(resolve => {
    if (!els.confirmDialog || typeof els.confirmDialog.showModal !== 'function') {
      resolve(window.confirm(message));
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      els.confirmDialog.removeEventListener('close', onClose);
      els.confirmDialog.removeEventListener('cancel', onCancel);
      resolve(value);
    };
    const onClose = () => finish(els.confirmDialog.returnValue === 'ok');
    const onCancel = (event) => { event.preventDefault(); finish(false); };
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmOk.textContent = okText;
    const cancelBtn = els.confirmDialog.querySelector('button[value="cancel"].secondary-button');
    if (cancelBtn) cancelBtn.textContent = cancelText;
    els.confirmDialog.addEventListener('close', onClose);
    els.confirmDialog.addEventListener('cancel', onCancel);
    if (els.confirmDialog.open) els.confirmDialog.close('cancel');
    els.confirmDialog.returnValue = '';
    els.confirmDialog.showModal();
    setTimeout(() => els.confirmOk.focus(), 30);
  });
}

function getActiveNote() { return state.notes.find(note => note.id === state.activeNoteId) || null; }
function getFolderName(id) { return state.folders.find(folder => folder.id === id)?.name || '默认文件夹'; }
function displayTitle(note) { return note.title.trim() || (note.type === 'tasks' ? '未命名清单' : '无标题'); }
function countTasks(note) { return { total: note.tasks.length, done: note.tasks.filter(task => task.done).length }; }
function textForSearch(note) {
  const taskText = note.type === 'tasks' ? note.tasks.map(task => task.text).join(' ') : '';
  const fileText = (note.attachments || []).map(item => item.name).join(' ');
  return `${note.title} ${note.content || ''} ${taskText} ${fileText}`.toLocaleLowerCase();
}
function activeFilterNotes() {
  let notes = [...state.notes];
  if (state.activeFolderId === 'tasks') notes = notes.filter(note => note.type === 'tasks');
  else if (state.activeFolderId !== 'all') notes = notes.filter(note => note.folderId === state.activeFolderId);
  const query = els.searchInput.value.trim().toLocaleLowerCase();
  if (query) notes = notes.filter(note => textForSearch(note).includes(query));
  return notes.sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.updatedAt) - new Date(a.updatedAt));
}
function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function attachmentSummary(note) {
  const list = note.attachments || [];
  const images = list.filter(item => item.kind === 'image').length;
  const files = list.length - images;
  const parts = [];
  if (images) parts.push(`${images} 张图片`);
  if (files) parts.push(`${files} 个文件`);
  return parts.join('、');
}
function notePreview(note) {
  if (note.type === 'tasks') {
    const { total, done } = countTasks(note);
    const next = note.tasks.find(task => !task.done)?.text;
    return next ? `${done}/${total} 已完成 · ${next}` : `${done}/${total} 项已完成`;
  }
  const clean = note.content.replace(/\s+/g, ' ').trim();
  return clean || '还没有内容，点击打开并开始记录。';
}

function renderFolders() {
  els.folderList.replaceChildren();
  const counts = new Map(state.folders.map(folder => [folder.id, state.notes.filter(note => note.folderId === folder.id).length]));
  state.folders.forEach(folder => {
    const wrap = document.createElement('div'); wrap.className = 'folder-item';
    const select = document.createElement('button'); select.type = 'button'; select.className = `folder-select-button ${state.activeFolderId === folder.id ? 'active' : ''}`;
    select.innerHTML = `<span class="folder-emoji">▱</span><span class="folder-name"></span><span class="folder-count">${counts.get(folder.id) || 0}</span>`;
    select.querySelector('.folder-name').textContent = folder.name;
    select.addEventListener('click', () => { state.activeFolderId = folder.id; closeSidebar(); render(); });
    const more = document.createElement('button'); more.type = 'button'; more.className = 'folder-more'; more.textContent = '···'; more.setAttribute('aria-label', `管理${folder.name}`); more.title = '管理文件夹';
    more.addEventListener('click', () => openFolderDialog(folder.id));
    wrap.append(select, more); els.folderList.append(wrap);
  });
}

function renderNavigation() {
  const allCount = state.notes.length;
  const taskCount = state.notes.filter(note => note.type === 'tasks').length;
  els.allCount.textContent = allCount;
  els.taskCount.textContent = taskCount;
  document.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('active', button.dataset.filter === state.activeFolderId));
  const currentFolder = state.folders.find(folder => folder.id === state.activeFolderId);
  let label = '全部笔记', kicker = 'LIBRARY', subtitle = '把想法收好，随时继续。';
  if (state.activeFolderId === 'tasks') { label = '待办清单'; kicker = 'TO-DO'; subtitle = '把下一步变得清晰。'; }
  else if (currentFolder) { label = currentFolder.name; kicker = 'FOLDER'; subtitle = '这个文件夹里的所有记录。'; }
  els.topbarTitle.textContent = label;
  els.sectionTitle.textContent = label;
  els.sectionKicker.textContent = kicker;
  els.sectionSubtitle.textContent = subtitle;
}

function renderNotes() {
  const notes = activeFilterNotes();
  els.notesList.replaceChildren();
  els.resultCount.textContent = `${notes.length} 条内容`;
  if (!notes.length) {
    const empty = document.createElement('div'); empty.className = 'list-empty';
    const strong = document.createElement('strong');
    const query = els.searchInput.value.trim();
    strong.textContent = query ? '没有找到匹配内容' : '这里还很安静';
    const p = document.createElement('span'); p.textContent = query ? '试试其他关键词。' : '创建一篇笔记，把第一个想法放进来。';
    empty.append(strong, p); els.notesList.append(empty); return;
  }
  notes.forEach(note => {
    const card = document.createElement('article'); card.className = `note-card ${note.id === state.activeNoteId ? 'active' : ''}`; card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-label', `打开${displayTitle(note)}`);
    const top = document.createElement('div'); top.className = 'note-card-top';
    const icon = document.createElement('span'); icon.className = 'note-card-icon'; icon.textContent = note.type === 'tasks' ? '☷' : '▤';
    const title = document.createElement('span'); title.className = 'note-card-title'; title.textContent = displayTitle(note);
    top.append(icon, title);
    if (note.pinned) { const pin = document.createElement('span'); pin.className = 'pinned-mark'; pin.textContent = '✦'; top.append(pin); }
    const preview = document.createElement('p'); preview.className = 'note-card-preview'; preview.textContent = notePreview(note);
    const bottom = document.createElement('div'); bottom.className = 'note-card-bottom';
    const folder = document.createElement('span'); folder.className = 'note-card-folder'; folder.textContent = getFolderName(note.folderId);
    const date = document.createElement('span'); date.textContent = formatDate(note.updatedAt);
    bottom.append(folder, date);
    if (note.type === 'tasks') { const { total, done } = countTasks(note); date.textContent = `${done}/${total} 完成 · ${formatDate(note.updatedAt)}`; date.className = 'task-mini-progress'; }
    const attachText = attachmentSummary(note);
    if (attachText) { const tag = document.createElement('span'); tag.className = 'note-card-attach'; tag.textContent = `📎 ${attachText}`; card.append(top, preview, tag, bottom); }
    else card.append(top, preview, bottom);
    const activate = () => { state.activeNoteId = note.id; render(); closeSidebar(); };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } });
    els.notesList.append(card);
  });
}

function renderTaskItems(note) {
  els.taskItems.replaceChildren();
  note.tasks.forEach(task => {
    const row = document.createElement('div'); row.className = `task-item ${task.done ? 'done' : ''}`;
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = task.done; checkbox.setAttribute('aria-label', `完成：${task.text}`);
    checkbox.addEventListener('change', () => { task.done = checkbox.checked; note.updatedAt = new Date().toISOString(); renderTaskItems(note); updateTaskProgress(note); renderNotes(); scheduleSave(); });
    const input = document.createElement('input'); input.type = 'text'; input.className = 'task-item-text'; input.value = task.text; input.maxLength = 180; input.setAttribute('aria-label', '待办内容');
    input.addEventListener('input', () => { task.text = input.value; note.updatedAt = new Date().toISOString(); renderNotes(); scheduleSave(); updateMeta(note); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'task-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', '删除待办');
    remove.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      note.tasks = note.tasks.filter(item => item.id !== task.id);
      note.updatedAt = new Date().toISOString();
      renderTaskItems(note); updateTaskProgress(note); updateMeta(note); renderNotes(); scheduleSave();
      showToast('待办已删除。');
    });
    row.append(checkbox, input, remove); els.taskItems.append(row);
  });
}

function updateTaskProgress(note) {
  const { total, done } = countTasks(note);
  const percent = total ? Math.round(done / total * 100) : 0;
  els.progressFill.style.width = `${percent}%`;
  els.progressText.textContent = `${done} / ${total} 已完成`;
}

function updateMeta(note) {
  els.noteDate.textContent = `更新于 ${formatDate(note.updatedAt)}`;
  const count = note.type === 'tasks' ? note.tasks.reduce((sum, item) => sum + item.text.length, 0) : note.content.length;
  els.wordCount.textContent = `${count} 字`;
}

function renderEditor() {
  const note = getActiveNote();
  if (!note) {
    els.emptyEditor.hidden = false; els.noteEditor.hidden = true;
    releaseUnusedUrls(new Set());
    document.body.classList.remove('mobile-editing');
    return;
  }
  els.emptyEditor.hidden = true; els.noteEditor.hidden = false;
  document.body.classList.toggle('mobile-editing', window.matchMedia('(max-width: 820px)').matches);
  els.noteTitle.value = note.title;
  els.noteTypeLabel.textContent = note.type === 'tasks' ? 'CHECKLIST · 待办清单' : 'NOTE · 笔记';
  els.plainBody.hidden = note.type === 'tasks';
  els.taskBody.hidden = note.type !== 'tasks';
  els.noteContent.value = note.content;
  els.pinButton.textContent = note.pinned ? '★' : '☆';
  els.pinButton.classList.toggle('pinned', note.pinned);
  els.pinButton.title = note.pinned ? '取消收藏' : '收藏笔记';
  els.noteFolder.replaceChildren();
  state.folders.forEach(folder => {
    const option = document.createElement('option'); option.value = folder.id; option.textContent = folder.name; els.noteFolder.append(option);
  });
  els.noteFolder.value = note.folderId;
  updateMeta(note);
  if (note.type === 'tasks') { renderTaskItems(note); updateTaskProgress(note); }
  renderAttachments();
}

function render() {
  renderNavigation(); renderFolders(); renderNotes(); renderEditor();
}

function closeSidebar() { document.body.classList.remove('sidebar-open'); }

function createNote(type = 'note') {
  const now = new Date().toISOString();
  const selectedFolder = state.folders.some(folder => folder.id === state.activeFolderId) ? state.activeFolderId : 'folder_default';
  const note = { id: makeId('note'), folderId: selectedFolder, type, title: '', content: '', tasks: [], attachments: [], pinned: false, createdAt: now, updatedAt: now };
  state.notes.push(note); state.activeNoteId = note.id;
  render(); scheduleSave(); closeSidebar();
  if (type === 'tasks') els.newTaskInput.focus(); else els.noteTitle.focus();
}

function openFolderDialog(folderId = null) {
  editingFolderId = folderId;
  const folder = folderId ? state.folders.find(item => item.id === folderId) : null;
  els.folderDialogTitle.textContent = folder ? '管理文件夹' : '新建文件夹';
  els.folderName.value = folder ? folder.name : '';
  els.deleteFolder.hidden = !folder || folder.id === 'folder_default';
  els.folderDialog.showModal();
  setTimeout(() => els.folderName.focus(), 30);
}

function saveFolder(event) {
  event.preventDefault();
  const name = els.folderName.value.trim();
  if (!name) { els.folderName.focus(); return; }
  const duplicate = state.folders.some(folder => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase() && folder.id !== editingFolderId);
  if (duplicate) { showToast('已经有同名文件夹了。'); return; }
  if (editingFolderId) {
    const folder = state.folders.find(item => item.id === editingFolderId);
    if (folder) folder.name = name;
    showToast('文件夹名称已更新。');
  } else {
    const folder = { id: makeId('folder'), name, createdAt: new Date().toISOString() };
    state.folders.push(folder); state.activeFolderId = folder.id;
    showToast('文件夹已创建。');
  }
  els.folderDialog.close(); render(); scheduleSave();
}

async function deleteFolder() {
  const folder = state.folders.find(item => item.id === editingFolderId);
  if (!folder || folder.id === 'folder_default') return;
  const ok = await askConfirm(`删除「${folder.name}」？其中的笔记会移动到「默认文件夹」，不会被删除。`, { title: '删除文件夹', okText: '删除' });
  if (!ok) return;
  state.notes.forEach(note => { if (note.folderId === folder.id) note.folderId = 'folder_default'; });
  state.folders = state.folders.filter(item => item.id !== folder.id);
  if (state.activeFolderId === folder.id) state.activeFolderId = 'all';
  els.folderDialog.close(); render(); scheduleSave(); showToast('文件夹已删除，笔记已移至默认文件夹。');
}

function addTask() {
  const note = getActiveNote();
  if (!note || note.type !== 'tasks') return;
  const text = els.newTaskInput.value.trim();
  if (!text) { els.newTaskInput.focus(); return; }
  note.tasks.push({ id: makeId('task'), text, done: false });
  note.updatedAt = new Date().toISOString(); els.newTaskInput.value = '';
  renderTaskItems(note); updateTaskProgress(note); updateMeta(note); renderNotes(); scheduleSave(); els.newTaskInput.focus();
}


// ===== 图片与文件附件 =====
function releaseUnusedUrls(keep) {
  for (const [id, url] of objectUrls) {
    if (!keep.has(id)) { URL.revokeObjectURL(url); objectUrls.delete(id); }
  }
}

function urlForAttachment(id, blob) {
  let url = objectUrls.get(id);
  if (!url) { url = URL.createObjectURL(blob); objectUrls.set(id, url); }
  return url;
}

function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取这张图片')); };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

// 大图缩小到最长边 1600px 并压缩为 JPEG；GIF/SVG 保持原样。
async function prepareImage(file) {
  const baseName = (file.name || '').replace(/\.[^.]+$/, '') || `图片-${Date.now()}`;
  const keepOriginal = { blob: file, name: file.name || `${baseName}.jpg`, type: file.type || 'image/jpeg' };
  if (/image\/(gif|svg)/i.test(file.type)) return keepOriginal;
  let img;
  try { img = await loadImageElement(file); } catch (_) { return null; }
  const width = img.naturalWidth, height = img.naturalHeight;
  if (!width || !height) return null;
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
  if (scale === 1 && file.size <= 800 * 1024 && /jpe?g|png|webp/i.test(file.type)) return keepOriginal;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
  canvas.width = canvas.height = 0;
  if (!blob) return keepOriginal;
  if (scale === 1 && blob.size >= file.size) return keepOriginal;
  return { blob, name: `${baseName}.jpg`, type: 'image/jpeg' };
}

async function addAttachments(fileList, kind) {
  const note = getActiveNote();
  const files = Array.from(fileList || []);
  if (!note || !files.length) return;
  if (!Array.isArray(note.attachments)) note.attachments = [];
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  showToast(kind === 'image' ? '正在处理图片…' : '正在添加文件…');
  let added = 0; const problems = [];
  for (const file of files) {
    const label = file.name || '未命名';
    try {
      if (file.size > MAX_FILE_BYTES) { problems.push(`「${label}」超过 50 MB`); continue; }
      let item = { blob: file, name: file.name || `文件-${Date.now()}`, type: file.type || 'application/octet-stream' };
      let itemKind = 'file';
      if (kind === 'image') {
        const prepared = await prepareImage(file);
        if (prepared) { item = prepared; itemKind = 'image'; }
        else { problems.push(`「${label}」无法识别为图片，已作为文件保存`); item.name = file.name || `图片-${Date.now()}`; }
      }
      const id = makeId('att');
      await putAttachment({ id, noteId: note.id, name: item.name, type: item.type, size: item.blob.size, kind: itemKind, createdAt: new Date().toISOString(), blob: item.blob });
      note.attachments.push({ id, name: item.name, type: item.type, size: item.blob.size, kind: itemKind, createdAt: new Date().toISOString() });
      added++;
    } catch (error) {
      console.error(error);
      problems.push(`「${label}」保存失败（可能存储空间不足）`);
    }
  }
  if (added) { note.updatedAt = new Date().toISOString(); scheduleSave(); }
  if (state.notes.includes(note)) { if (note.id === state.activeNoteId) { updateMeta(note); renderAttachments(); } renderNotes(); }
  if (problems.length) showToast(`${added ? `已添加 ${added} 项；` : ''}${problems[0]}${problems.length > 1 ? `等 ${problems.length} 项有问题` : ''}`);
  else if (added) showToast(`已添加 ${added} 项${kind === 'image' ? '图片' : '文件'}。`);
}

async function removeAttachment(attachment) {
  const note = getActiveNote(); if (!note) return;
  const kindLabel = attachment.kind === 'image' ? '图片' : '文件';
  const ok = await askConfirm(`删除${kindLabel}「${attachment.name}」？此操作无法撤销。`, { title: `删除${kindLabel}`, okText: '删除' });
  if (!ok) return;
  note.attachments = (note.attachments || []).filter(item => item.id !== attachment.id);
  note.updatedAt = new Date().toISOString();
  const url = objectUrls.get(attachment.id);
  if (url) { URL.revokeObjectURL(url); objectUrls.delete(attachment.id); }
  try { await deleteAttachments([attachment.id]); } catch (error) { console.error(error); }
  scheduleSave(); renderAttachments(); updateMeta(note); renderNotes(); showToast('附件已删除。');
}

function openImageViewer(attachment, url) {
  els.viewerImage.src = url; els.viewerImage.alt = attachment.name;
  els.viewerName.textContent = attachment.name;
  els.viewerSave.href = url; els.viewerSave.download = attachment.name;
  if (!els.imageDialog.open) els.imageDialog.showModal();
}

function closeImageViewer() {
  if (els.imageDialog.open) els.imageDialog.close();
  els.viewerImage.removeAttribute('src');
}

function downloadAttachment(attachment, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = attachment.name; anchor.rel = 'noopener';
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function shareAttachment(attachment, blob) {
  try {
    const file = new File([blob], attachment.name, { type: attachment.type || blob.type });
    await navigator.share({ files: [file], title: attachment.name });
  } catch (error) {
    if (error && error.name !== 'AbortError') { console.error(error); showToast('无法分享此文件，请改用「打开」。'); }
  }
}

function canShareFile(attachment, blob) {
  try {
    if (!navigator.share || !navigator.canShare) return false;
    return navigator.canShare({ files: [new File([blob], attachment.name, { type: attachment.type || blob.type })] });
  } catch (_) { return false; }
}

async function renderAttachments() {
  const token = ++attachRenderToken;
  const note = getActiveNote();
  const list = note ? (note.attachments || []) : [];
  releaseUnusedUrls(new Set(list.map(item => item.id)));
  els.attachGallery.replaceChildren(); els.attachFiles.replaceChildren();
  els.attachSummary.textContent = list.length ? `已添加 ${attachmentSummary(note)}` : '还没有图片或文件';
  if (!list.length) return;
  const records = await Promise.all(list.map(item => getAttachment(item.id).catch(() => null)));
  if (token !== attachRenderToken) return;
  list.forEach((attachment, index) => {
    const record = records[index];
    if (attachment.kind === 'image') {
      const tile = document.createElement('div'); tile.className = 'attach-thumb';
      if (!record || !record.blob) {
        tile.classList.add('missing'); tile.textContent = '图片丢失';
      } else {
        const url = urlForAttachment(attachment.id, record.blob);
        const open = document.createElement('button'); open.type = 'button'; open.className = 'attach-thumb-open'; open.setAttribute('aria-label', `查看图片 ${attachment.name}`);
        const img = document.createElement('img'); img.src = url; img.alt = attachment.name; img.loading = 'lazy'; img.decoding = 'async';
        open.append(img); open.addEventListener('click', () => openImageViewer(attachment, url));
        tile.append(open);
      }
      const del = document.createElement('button'); del.type = 'button'; del.className = 'attach-remove'; del.textContent = '×'; del.setAttribute('aria-label', `删除 ${attachment.name}`); del.title = '删除图片';
      del.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); removeAttachment(attachment); });
      tile.append(del); els.attachGallery.append(tile);
    } else {
      const row = document.createElement('div'); row.className = 'attach-file';
      const icon = document.createElement('span'); icon.className = 'attach-file-icon'; icon.textContent = '▤';
      const main = document.createElement('button'); main.type = 'button'; main.className = 'attach-file-main';
      const name = document.createElement('span'); name.className = 'attach-file-name'; name.textContent = attachment.name;
      const size = document.createElement('span'); size.className = 'attach-file-size'; size.textContent = record && record.blob ? formatSize(attachment.size) : '文件丢失';
      main.append(name, size); main.setAttribute('aria-label', `打开 ${attachment.name}`);
      row.append(icon, main);
      if (record && record.blob) {
        main.addEventListener('click', () => downloadAttachment(attachment, record.blob));
        if (canShareFile(attachment, record.blob)) {
          const share = document.createElement('button'); share.type = 'button'; share.className = 'attach-file-action'; share.textContent = '分享'; share.title = '分享或存储到“文件”';
          share.addEventListener('click', () => shareAttachment(attachment, record.blob)); row.append(share);
        }
      }
      const del = document.createElement('button'); del.type = 'button'; del.className = 'attach-file-action danger'; del.textContent = '删除'; del.setAttribute('aria-label', `删除 ${attachment.name}`);
      del.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); removeAttachment(attachment); });
      row.append(del); els.attachFiles.append(row);
    }
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取附件失败'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl, fallbackType) {
  const match = /^data:([^;,]*)((?:;[^;,]*)*?),(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('备份中的附件数据格式不正确。');
  const type = match[1] || fallbackType || 'application/octet-stream';
  const isBase64 = /;base64/i.test(match[2]);
  const raw = isBase64 ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function deleteCurrentNote() {
  const note = getActiveNote(); if (!note) return;
  const ok = await askConfirm(`确定删除「${displayTitle(note)}」吗？此操作无法撤销。建议先备份重要内容。`, { title: '删除笔记', okText: '删除' });
  if (!ok) return;
  const attachmentIds = (note.attachments || []).map(item => item.id);
  state.notes = state.notes.filter(item => item.id !== note.id);
  state.activeNoteId = null; render(); scheduleSave();
  deleteAttachments(attachmentIds).catch(error => console.error(error));
  showToast('笔记已删除。');
}

async function exportBackup() {
  await saveNow();
  try {
    showToast('正在生成备份…');
    const parts = [`{"app":"简记","version":2,"exportedAt":${JSON.stringify(new Date().toISOString())},"folders":${JSON.stringify(state.folders)},"notes":[`];
    for (let index = 0; index < state.notes.length; index++) {
      const note = state.notes[index];
      const attachments = [];
      for (const meta of (note.attachments || [])) {
        const record = await getAttachment(meta.id).catch(() => null);
        if (record && record.blob) attachments.push({ ...meta, data: await blobToDataUrl(record.blob) });
      }
      parts.push((index ? ',\n' : '\n') + JSON.stringify({ ...note, attachments }));
    }
    parts.push('\n]}');
    const blob = new Blob(parts, { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `简记备份-${new Date().toISOString().slice(0,10)}.json`;
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    showToast('备份文件已生成（含图片和文件），请妥善保存。');
  } catch (error) {
    console.error(error); showToast('生成备份失败，可能是附件太多导致内存不足。');
  }
}

async function importBackup(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const restored = normalizeState(parsed);
    // 旧版备份没有附件字段，会得到空附件列表，保持兼容。
    const dataById = new Map();
    (Array.isArray(parsed.notes) ? parsed.notes : []).forEach(n => {
      if (n && Array.isArray(n.attachments)) n.attachments.forEach(a => { if (a && typeof a.id === 'string' && typeof a.data === 'string') dataById.set(a.id, a); });
    });
    const records = [];
    restored.notes.forEach(note => {
      note.attachments = note.attachments.filter(meta => {
        const source = dataById.get(meta.id);
        if (!source) return false;
        try {
          const blob = dataUrlToBlob(source.data, meta.type);
          records.push({ id: meta.id, noteId: note.id, name: meta.name, type: meta.type || blob.type, size: blob.size, kind: meta.kind, createdAt: meta.createdAt, blob });
          meta.size = blob.size; return true;
        } catch (_) { return false; }
      });
    });
    const ok = await askConfirm(`导入备份将替换当前设备中的全部笔记和附件。备份内有 ${restored.notes.length} 条笔记、${restored.folders.length} 个文件夹、${records.length} 个附件。建议先导出当前数据。继续吗？`, { title: '导入备份', okText: '继续导入', cancelText: '取消' });
    if (!ok) return;
    clearTimeout(saveTimer);
    await replaceAllData(JSON.parse(JSON.stringify(restored)), records);
    state = restored; releaseUnusedUrls(new Set()); render(); setSaveStatus('已保存在此设备'); showToast('备份导入完成。');
  } catch (error) {
    console.error(error); showToast(error.message || '无法读取备份文件。');
  } finally { els.importFile.value = ''; }
}

function bindEvents() {
  $('#sidebarNewNote').addEventListener('click', () => createNote('note'));
  $('#newNoteButton').addEventListener('click', () => createNote('note'));
  $('#newTaskButton').addEventListener('click', () => createNote('tasks'));
  $('#emptyCreateButton').addEventListener('click', () => createNote('note'));
  $('#addFolderButton').addEventListener('click', () => openFolderDialog());
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { state.activeFolderId = button.dataset.filter; render(); closeSidebar(); }));
  els.searchInput.addEventListener('input', renderNotes);
  els.noteTitle.addEventListener('input', () => { const note = getActiveNote(); if (!note) return; note.title = els.noteTitle.value; note.updatedAt = new Date().toISOString(); updateMeta(note); renderNotes(); scheduleSave(); });
  els.noteContent.addEventListener('input', () => { const note = getActiveNote(); if (!note) return; note.content = els.noteContent.value; note.updatedAt = new Date().toISOString(); updateMeta(note); renderNotes(); scheduleSave(); });
  els.noteFolder.addEventListener('change', () => { const note = getActiveNote(); if (!note) return; note.folderId = els.noteFolder.value; note.updatedAt = new Date().toISOString(); renderFolders(); renderNotes(); scheduleSave(); });
  els.pinButton.addEventListener('click', () => { const note = getActiveNote(); if (!note) return; note.pinned = !note.pinned; note.updatedAt = new Date().toISOString(); renderEditor(); renderNotes(); scheduleSave(); });
  $('#deleteNoteButton').addEventListener('click', deleteCurrentNote);
  $('#addTaskButton').addEventListener('click', addTask);
  els.newTaskInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addTask(); } });
  els.attachImageButton.addEventListener('click', () => els.attachImageInput.click());
  els.attachFileButton.addEventListener('click', () => els.attachFileInput.click());
  els.attachImageInput.addEventListener('change', () => { const files = Array.from(els.attachImageInput.files); els.attachImageInput.value = ''; addAttachments(files, 'image'); });
  els.attachFileInput.addEventListener('change', () => { const files = Array.from(els.attachFileInput.files); els.attachFileInput.value = ''; addAttachments(files, 'file'); });
  $('#viewerClose').addEventListener('click', closeImageViewer);
  els.viewerImage.addEventListener('click', closeImageViewer);
  els.imageDialog.addEventListener('click', event => { if (event.target === els.imageDialog) closeImageViewer(); });
  els.imageDialog.addEventListener('close', () => els.viewerImage.removeAttribute('src'));
  els.folderForm.addEventListener('submit', saveFolder);
  els.deleteFolder.addEventListener('click', deleteFolder);
  $('#menuButton').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  $('#sidebarScrim').addEventListener('click', closeSidebar);
  $('#backToListButton').addEventListener('click', () => document.body.classList.remove('mobile-editing'));
  $('#exportButton').addEventListener('click', exportBackup);
  $('#mobileExportButton').addEventListener('click', exportBackup);
  $('#importButton').addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', () => importBackup(els.importFile.files[0]));
  document.addEventListener('keydown', event => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    if ((isMac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); createNote('note'); }
    if ((isMac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); els.searchInput.focus(); }
    if (event.key === 'Escape') closeSidebar();
  });
  window.addEventListener('resize', () => { if (window.innerWidth > 820) document.body.classList.remove('mobile-editing'); });
  window.addEventListener('pagehide', () => { releaseUnusedUrls(new Set()); if (state) { try { localStorage.setItem(LEGACY_KEY, JSON.stringify(state)); } catch (_) { /* IndexedDB remains the primary store */ } } });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    registration.update().catch(() => {});
  } catch (error) { console.warn('离线缓存注册失败：', error); }
}

async function main() {
  state = await loadState();
  bindEvents();
  render();
  // Save the initial state so the database is created on first use.
  scheduleSave();
  registerServiceWorker();
}

main().catch(error => {
  console.error(error);
  document.body.innerHTML = '<main style="max-width:560px;margin:15vh auto;padding:24px;font-family:sans-serif;color:#333"><h2>简记暂时无法启动</h2><p>请使用最新版 Safari 或 Chrome 打开，并检查浏览器是否允许本地网站数据。</p><p>错误信息：' + String(error.message || error) + '</p></main>';
});
