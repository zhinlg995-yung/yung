'use strict';

const DB_NAME = 'jianji-local-db';
const DB_VERSION = 1;
const STORE_NAME = 'app-state';
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
  folderName: $('#folderNameInput'), deleteFolder: $('#deleteFolderButton'), toast: $('#toast'), importFile: $('#importFile')
};

let state = null;
let dbPromise = null;
let saveTimer = null;
let toastTimer = null;
let editingFolderId = null;
let isSaving = false;

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
      content: '这里是你的私人笔记空间。\n\n• 点击左侧「新建笔记」记录想法。\n• 使用文件夹整理不同主题。\n• 创建待办清单，勾选完成的事项。\n• 搜索可以查找标题、正文和待办内容。\n\n笔记默认保存在这台设备的浏览器本地。建议定期使用左下角的「备份笔记」导出 JSON 文件，妥善保存备份。',
      tasks: [], pinned: true, createdAt: now, updatedAt: now
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
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
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

function getActiveNote() { return state.notes.find(note => note.id === state.activeNoteId) || null; }
function getFolderName(id) { return state.folders.find(folder => folder.id === id)?.name || '默认文件夹'; }
function displayTitle(note) { return note.title.trim() || (note.type === 'tasks' ? '未命名清单' : '无标题'); }
function countTasks(note) { return { total: note.tasks.length, done: note.tasks.filter(task => task.done).length }; }
function textForSearch(note) {
  const taskText = note.type === 'tasks' ? note.tasks.map(task => task.text).join(' ') : '';
  return `${note.title} ${note.content || ''} ${taskText}`.toLocaleLowerCase();
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
    card.append(top, preview, bottom);
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
    remove.addEventListener('click', () => { note.tasks = note.tasks.filter(item => item.id !== task.id); note.updatedAt = new Date().toISOString(); renderTaskItems(note); updateTaskProgress(note); renderNotes(); scheduleSave(); });
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
}

function render() {
  renderNavigation(); renderFolders(); renderNotes(); renderEditor();
}

function closeSidebar() { document.body.classList.remove('sidebar-open'); }

function createNote(type = 'note') {
  const now = new Date().toISOString();
  const selectedFolder = state.folders.some(folder => folder.id === state.activeFolderId) ? state.activeFolderId : 'folder_default';
  const note = { id: makeId('note'), folderId: selectedFolder, type, title: '', content: '', tasks: [], pinned: false, createdAt: now, updatedAt: now };
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

function deleteFolder() {
  const folder = state.folders.find(item => item.id === editingFolderId);
  if (!folder || folder.id === 'folder_default') return;
  if (!window.confirm(`删除「${folder.name}」？其中的笔记会移动到「默认文件夹」，不会被删除。`)) return;
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

function deleteCurrentNote() {
  const note = getActiveNote(); if (!note) return;
  if (!window.confirm(`确定删除「${displayTitle(note)}」吗？此操作无法撤销。建议先备份重要内容。`)) return;
  state.notes = state.notes.filter(item => item.id !== note.id);
  state.activeNoteId = null; render(); scheduleSave(); showToast('笔记已删除。');
}

async function exportBackup() {
  await saveNow();
  const backup = { app: '简记', version: 1, exportedAt: new Date().toISOString(), folders: state.folders, notes: state.notes };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `简记备份-${new Date().toISOString().slice(0,10)}.json`;
  document.body.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  showToast('备份文件已生成，请妥善保存。');
}

async function importBackup(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const restored = normalizeState(parsed);
    if (!window.confirm(`导入备份将替换当前设备中的全部笔记。备份内有 ${restored.notes.length} 条笔记、${restored.folders.length} 个文件夹。建议先导出当前数据。继续吗？`)) return;
    state = restored; await saveNow(); render(); showToast('备份导入完成。');
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
  window.addEventListener('pagehide', () => { if (state) { try { localStorage.setItem(LEGACY_KEY, JSON.stringify(state)); } catch (_) { /* IndexedDB remains the primary store */ } } });
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
