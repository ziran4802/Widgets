const root = document.querySelector('#root');
let component;
let metrics;
let quota;
let editing = false;
let clockTimer;
let quotaTimer;
let noteSaveTimer;
let noteEditor;
let noteSaveSequence = 0;
let todoDateTimer;
let todoSaveTail = Promise.resolve();
let todoItemSequence = 0;
let todoEditor;
let dragMode = 'electron-native';
let todoInteractive = true;
let dragPointerId;
let dragPendingUpdate;
let dragPendingTerminal;
let dragDraining = false;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : '—';
}

function applyTheme(view) {
  const theme = component?.theme || { name: 'system', opacity: 0.92 };
  const noteConfig = component?.type === 'note' ? component.config || {} : {};
  const classes = ['widget', theme.name, component?.type || 'unknown', dragMode === 'native-message' ? 'native-drag' : 'electron-drag'];
  if (component?.type === 'note') {
    classes.push(`note-size-${noteConfig.size || 'standard'}`, `note-background-${noteConfig.background || 'yellow'}`);
  }
  if (component?.type === 'daily-todo' && !todoInteractive) classes.push('todo-locked');
  if (editing) classes.push('editing');
  view.className = classes.join(' ');
  document.documentElement.style.setProperty('--widget-opacity', String(theme.opacity));
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear().toString().padStart(4, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function renderHeader(title, status = '实时') {
  const header = node('header', undefined, 'header');
  const copy = node('div');
  copy.append(node('p', 'WIDGET / DESKTOP', 'eyebrow'));
  copy.append(node('h1', title));
  header.append(copy);
  header.append(node('span', status, 'status'));
  return header;
}

function renderMetric(label, value, suffix = '') {
  const card = node('div', undefined, 'metric');
  card.append(node('div', label, 'label'));
  const valueView = node('div', undefined, 'value');
  valueView.append(document.createTextNode(value));
  if (suffix) valueView.append(node('span', suffix, 'unit'));
  card.append(valueView);
  return card;
}

function metricValue(metric) {
  if (metric?.phase === 'available' && Number.isFinite(metric.usagePercent)) return percent(metric.usagePercent);
  return '—';
}

function metricState(metric) {
  if (metric?.phase === 'baseline') return '等待';
  if (metric?.phase === 'available') return '实时';
  return '不可用';
}

function renderRing(label, metric, color) {
  const ring = node('div', undefined, `metric-ring ${metric?.phase || 'unavailable'}`);
  const progress = metric?.phase === 'available' && Number.isFinite(metric.usagePercent) ? Math.min(100, Math.max(0, metric.usagePercent)) : 0;
  ring.style.setProperty('--ring-progress', `${progress}%`);
  ring.style.setProperty('--ring-color', color);
  const content = node('div', undefined, 'ring-content');
  content.append(node('span', label, 'ring-label'));
  content.append(node('strong', metricValue(metric), 'ring-value'));
  content.append(node('small', metricState(metric), 'ring-state'));
  ring.append(content);
  return ring;
}

function rate(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let scaled = Math.max(0, value);
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) { scaled /= 1024; index += 1; }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[index]}`;
}

function renderRate(label, value, arrow, className) {
  const row = node('div', undefined, `rate-row ${className}`);
  row.append(node('span', arrow, 'rate-arrow'));
  const copy = node('div', undefined, 'rate-copy');
  copy.append(node('span', label, 'rate-label'));
  copy.append(node('strong', rate(value), 'rate-value'));
  row.append(copy);
  return row;
}

function renderSystemMonitor(view) {
  view.classList.add('monitor');
  view.append(renderHeader(component.displayName, metrics?.phase === 'ready' ? '实时' : '恢复中'));
  const body = node('section', undefined, 'monitor-body');
  const rings = node('div', undefined, 'ring-grid');
  rings.append(renderRing('CPU', metrics?.cpu, '#287be7'));
  rings.append(renderRing('内存', metrics?.memory ? { ...metrics.memory, phase: 'available', usagePercent: metrics.memory.usagePercent } : undefined, '#7c4ed8'));
  const gpuLabel = metrics?.gpu?.adapterKind === 'discrete' ? 'GPU·独显' : 'GPU';
  rings.append(renderRing(gpuLabel, metrics?.gpu, '#159b9d'));
  body.append(rings);
  const rates = node('div', undefined, 'rates');
  rates.append(renderRate('上传', metrics?.network?.phase === 'available' ? metrics.network.uploadBytesPerSecond : null, '↑', 'upload'));
  rates.append(renderRate('下载', metrics?.network?.phase === 'available' ? metrics.network.downloadBytesPerSecond : null, '↓', 'download'));
  rates.append(node('small', `网络：${metricState(metrics?.network)} · 物理网卡`, 'network-state'));
  body.append(rates);
  view.append(body);
}

function stopQuotaTimer() {
  if (quotaTimer === undefined) return;
  window.clearInterval(quotaTimer);
  quotaTimer = undefined;
}

function quotaPercent(windowValue, field = 'remainingPercent') {
  return Number.isFinite(windowValue?.[field]) ? `${Math.round(windowValue[field])}%` : '—';
}

function quotaProgress(windowValue) {
  return Number.isFinite(windowValue?.remainingPercent) ? Math.min(100, Math.max(0, windowValue.remainingPercent)) : 0;
}

function quotaCountdown(timestamp) {
  if (!Number.isFinite(timestamp)) return '—';
  const remaining = Math.max(0, Math.floor(timestamp * 1000 - Date.now()));
  if (remaining === 0) return '已重置';
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function quotaDate(timestamp) {
  if (!Number.isFinite(timestamp)) return '—';
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return '—';
  const year = date.getFullYear().toString().padStart(4, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function quotaUpdatedAt(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '—';
  const seconds = Math.max(0, Date.now() - Date.parse(value)) / 1000;
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}

function quotaStatus(quota) {
  if (quota?.phase === 'available') return quota.cacheState === 'cached' ? '上次结果' : '已确认';
  if (quota?.phase === 'loading') return '确认中';
  if (quota?.phase === 'stale') return '确认失败，显示上次结果';
  if (quota?.phase === 'idle') return '尚未确认';
  return '不可用';
}

function renderQuotaSummary(label, value, className = '') {
  const item = node('div', undefined, `quota-summary-item ${className}`.trim());
  item.append(node('span', label, 'quota-summary-label'), node('strong', value, 'quota-summary-value'));
  return item;
}

function renderCodexQuota(view) {
  stopQuotaTimer();
  view.classList.add('codex-quota');
  const current = quota || { phase: 'idle', fiveHour: null, weekly: null, updatedAt: null };
  const hasData = Boolean(current.fiveHour || current.weekly);
  const loading = current.phase === 'loading';
  const header = node('header', undefined, 'quota-header');
  header.append(node('h1', 'Codex 额度', 'quota-title'));
  const badges = node('div', undefined, 'quota-badges');
  const refresh = node('button', loading ? '确认中…' : hasData ? '重新确认' : '确认额度', 'quota-read');
  refresh.type = 'button';
  refresh.disabled = loading;
  refresh.title = hasData ? '点击重新确认最新 Codex 额度' : '点击确认当前 Codex 额度';
  refresh.addEventListener('click', () => {
    if (!refresh.disabled) void window.widget.refreshCodexQuota?.();
  });
  badges.append(refresh);
  badges.append(node('span', quotaStatus(current), `quota-status ${current.phase || 'unavailable'}`));
  header.append(badges);
  view.append(header);

  const body = node('div', undefined, 'quota-body');
  const primary = node('section', undefined, 'quota-primary');
  const ring = node('div', undefined, `quota-ring ${current.phase || 'unavailable'}`);
  ring.style.setProperty('--quota-progress', `${quotaProgress(current.fiveHour)}%`);
  const ringContent = node('div', undefined, 'quota-ring-content');
  ringContent.append(node('span', '剩余', 'quota-ring-label'), node('strong', quotaPercent(current.fiveHour), 'quota-ring-value'), node('small', '5 小时额度', 'quota-ring-caption'));
  ring.append(ringContent);
  primary.append(ring);

  const side = node('section', undefined, 'quota-side');
  const weekly = node('div', undefined, 'quota-weekly');
  const weeklyHead = node('div', undefined, 'quota-weekly-head');
  weeklyHead.append(node('span', '周额度'), node('strong', `剩余 ${quotaPercent(current.weekly)}`));
  const weeklyBar = node('div', undefined, 'quota-progress');
  weeklyBar.style.setProperty('--quota-progress', `${quotaProgress(current.weekly)}%`);
  weekly.append(weeklyHead, weeklyBar);
  const summary = node('div', undefined, 'quota-summary');
  summary.append(
    renderQuotaSummary('已用', quotaPercent(current.fiveHour, 'usedPercent')),
    renderQuotaSummary('5 小时重置', quotaCountdown(current.fiveHour?.resetsAt), 'quota-reset'),
    renderQuotaSummary('周重置', quotaDate(current.weekly?.resetsAt), 'quota-weekly-reset'),
    renderQuotaSummary('最后更新', quotaUpdatedAt(current.updatedAt), 'quota-updated')
  );
  side.append(weekly, summary);
  body.append(primary, side);
  view.append(body);
  if (current.phase === 'unavailable' || current.phase === 'stale') view.append(node('small', current.message || '暂时无法确认 Codex 额度', `quota-message ${current.phase}`));
  if (current.phase === 'available' && Number.isFinite(current.fiveHour?.resetsAt)) quotaTimer = window.setInterval(() => {
    const reset = view.querySelector('.quota-reset .quota-summary-value');
    if (reset) reset.textContent = quotaCountdown(current.fiveHour.resetsAt);
  }, 1000);
}

function stopClockTimer() {
  if (clockTimer === undefined) return;
  window.clearInterval(clockTimer);
  clockTimer = undefined;
}

function renderClock(view) {
  stopClockTimer();
  const clock = node('section', undefined, 'clock');
  clock.append(renderHeader(component.displayName, '本机时间'));
  const time = node('div', undefined, 'time');
  const date = node('div', undefined, 'date');
  clock.append(time);
  clock.append(date);
  view.append(clock);
  const update = () => {
    const now = new Date();
    const clock = window.widgetClock || {};
    time.textContent = typeof clock.formatTime === 'function' ? clock.formatTime(now, component.config) : now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    date.textContent = typeof clock.formatDate === 'function' ? clock.formatDate(now) : now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  };
  update();
  clockTimer = window.setInterval(update, 1000);
}

function clearNoteSaveTimer() {
  if (noteSaveTimer === undefined) return;
  window.clearTimeout(noteSaveTimer);
  noteSaveTimer = undefined;
}

function setNoteSaveState(state, message) {
  if (!noteEditor) return;
  noteEditor.state.textContent = message;
  noteEditor.state.className = `note-save-state ${state}`;
  noteEditor.retry.hidden = state !== 'failed';
}

async function saveNoteNow() {
  const editor = noteEditor;
  if (!editor || !component || component.type !== 'note' || typeof window.widget?.saveNote !== 'function') return false;
  clearNoteSaveTimer();
  const version = editor.changeVersion;
  const content = { title: editor.title.value, text: editor.body.value };
  const sequence = ++noteSaveSequence;
  setNoteSaveState('saving', '保存中…');
  try {
    const result = await window.widget.saveNote(content);
    if (noteEditor !== editor || sequence !== noteSaveSequence || editor.changeVersion !== version) return false;
    if (result?.ok !== true) throw new Error(result?.message || 'note save failed');
    editor.dirty = false;
    setNoteSaveState('saved', '已保存');
    return true;
  } catch {
    if (noteEditor === editor && sequence === noteSaveSequence && editor.changeVersion === version) {
      editor.dirty = true;
      setNoteSaveState('failed', '保存失败');
    }
    return false;
  }
}

function scheduleNoteSave() {
  if (!noteEditor) return;
  noteEditor.changeVersion += 1;
  noteEditor.dirty = true;
  setNoteSaveState('pending', '待保存');
  clearNoteSaveTimer();
  noteSaveTimer = window.setTimeout(() => { noteSaveTimer = undefined; void saveNoteNow(); }, 650);
}

function syncNoteState() {
  if (!noteEditor || component?.type !== 'note') return;
  applyTheme(noteEditor.view);
  if (noteEditor.dirty) return;
  const config = component.config || {};
  if (document.activeElement !== noteEditor.title) noteEditor.title.value = config.title || '';
  if (document.activeElement !== noteEditor.body) noteEditor.body.value = config.text || '';
}

function renderNote(view) {
  const config = component.config || {};
  const strip = node('div', undefined, 'note-drag-strip');
  strip.append(node('span', '便签', 'note-drag-label'));
  const status = node('span', '已保存', 'note-save-state saved');
  strip.append(status);
  const content = node('div', undefined, 'note-content');
  const title = node('input', undefined, 'note-title');
  title.type = 'text';
  title.maxLength = 160;
  title.placeholder = '可选标题';
  title.value = config.title || '';
  title.setAttribute('aria-label', '便签标题');
  const body = node('textarea', undefined, 'note-body');
  body.maxLength = 12000;
  body.placeholder = '写点什么…';
  body.value = config.text || '';
  body.setAttribute('aria-label', '便签正文');
  const retry = node('button', '重试保存', 'note-retry');
  retry.type = 'button';
  retry.hidden = true;
  const editor = { view, title, body, state: status, retry, dirty: false, changeVersion: 0 };
  noteEditor = editor;
  const changed = () => scheduleNoteSave();
  title.addEventListener('input', changed);
  body.addEventListener('input', changed);
  retry.addEventListener('click', () => { void saveNoteNow(); });
  content.append(title, body, retry);
  view.append(strip, content);
}

function stopTodoDateTimer() {
  if (todoDateTimer === undefined) return;
  window.clearInterval(todoDateTimer);
  todoDateTimer = undefined;
}

function todoDateLabel(date = new Date()) {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `周${weekdays[date.getDay()]} · ${date.getMonth() + 1}月${date.getDate()}日`;
}

function todoItemsForToday() {
  const config = component?.config || {};
  return config.dateKey === localDateKey() && Array.isArray(config.items) ? config.items : [];
}

function setTodoSaveState(state, message) {
  if (!todoEditor) return;
  todoEditor.status.textContent = message;
  todoEditor.status.className = `todo-save-state ${state}`;
}

function localTodoState(items, dateKey = localDateKey()) {
  component = {
    ...component,
    config: { dateKey, items: items.map(item => ({ ...item })) }
  };
}

function saveTodoState(items) {
  const payload = { dateKey: localDateKey(), items: items.map(item => ({ ...item })) };
  const operation = todoSaveTail.then(async () => {
    if (!component || component.type !== 'daily-todo' || typeof window.widget?.updateTodo !== 'function') return false;
    setTodoSaveState('saving', '保存中…');
    try {
      const result = await window.widget.updateTodo(payload);
      if (result?.ok !== true) throw new Error(result?.message || 'todo save failed');
      setTodoSaveState('saved', '已保存');
      return true;
    } catch {
      setTodoSaveState('failed', '保存失败');
      return false;
    }
  });
  todoSaveTail = operation.catch(() => false);
  return operation;
}

async function toggleTodoInteraction(button) {
  if (editing || typeof window.widget?.setTodoInteraction !== 'function') return;
  button.disabled = true;
  try {
    const result = await window.widget.setTodoInteraction(!todoInteractive);
    if (result?.ok !== true) return;
    todoInteractive = result.interactive === true;
    render();
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function renderDailyTodo(view) {
  stopTodoDateTimer();
  view.classList.add('daily-todo');
  const items = todoItemsForToday();
  const completed = items.filter(item => item.completed).length;
  const strip = node('div', undefined, 'todo-drag-strip');
  const stripActions = node('div', undefined, 'todo-strip-actions');
  const interaction = node('button', todoInteractive ? '交互中' : '已锁定', 'todo-interaction-toggle');
  interaction.type = 'button';
  interaction.disabled = editing;
  interaction.setAttribute('aria-pressed', String(todoInteractive));
  interaction.setAttribute('aria-label', todoInteractive ? '锁定每日待办交互' : '解锁每日待办交互');
  interaction.title = editing ? '编辑布局时由管理器接管' : (todoInteractive ? '点击锁定；锁定后可从系统托盘解锁' : '已锁定，请从系统托盘解锁');
  interaction.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void toggleTodoInteraction(interaction);
  });
  stripActions.append(node('span', '本地清单', 'todo-drag-hint'), interaction);
  strip.append(node('span', 'DAILY / TODO', 'todo-eyebrow'), stripActions);
  const header = node('header', undefined, 'todo-header');
  const titleCopy = node('div');
  titleCopy.append(node('h1', '每日待办', 'todo-title'), node('span', todoDateLabel(), 'todo-date'));
  const progress = node('div', undefined, 'todo-progress-copy');
  progress.append(node('span', '今日进度'), node('strong', `${completed} / ${items.length}`));
  header.append(titleCopy, progress);
  const progressBar = node('div', undefined, 'todo-progress');
  progressBar.style.setProperty('--todo-progress', items.length === 0 ? '0%' : `${Math.round((completed / items.length) * 100)}%`);
  const list = node('div', undefined, 'todo-list');
  if (items.length === 0) list.append(node('p', '今天还没有待办，先添加一件小事吧。', 'todo-empty'));
  for (const item of items) {
    const row = node('label', undefined, `todo-item${item.completed ? ' completed' : ''}`);
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.completed;
    checkbox.setAttribute('aria-label', `完成：${item.title}`);
    checkbox.addEventListener('change', () => {
      const next = todoItemsForToday().map(candidate => candidate.id === item.id ? { ...candidate, completed: checkbox.checked } : candidate);
      localTodoState(next);
      render();
      void saveTodoState(next);
    });
    row.append(checkbox, node('span', item.title, 'todo-item-title'));
    list.append(row);
  }
  const add = node('form', undefined, 'todo-add');
  const input = node('input');
  input.type = 'text';
  input.maxLength = 160;
  input.placeholder = '添加任务…';
  input.setAttribute('aria-label', '添加待办任务');
  const addButton = node('button', '添加任务', 'todo-add-button');
  addButton.type = 'submit';
  add.addEventListener('submit', event => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) {
      input.focus();
      return;
    }
    if (todoItemsForToday().length >= 64) return;
    const next = [...todoItemsForToday(), { id: `todo-${Date.now()}-${++todoItemSequence}`, title, completed: false }];
    input.value = '';
    localTodoState(next);
    render();
    void saveTodoState(next);
  });
  add.append(input, addButton);
  const status = node('span', '已保存', 'todo-save-state saved');
  todoEditor = { view, input, status };
  view.append(strip, header, progressBar, list, add, status);
  todoDateTimer = window.setInterval(() => {
    if (component?.type !== 'daily-todo' || component.config?.dateKey === localDateKey()) return;
    localTodoState([]);
    render();
    void saveTodoState([]);
  }, 60000);
}

function isDragSurface(target) {
  if (!editing || dragMode !== 'native-message') return false;
  if (component?.type === 'note') return Boolean(target?.closest?.('.note-drag-strip'));
  if (component?.type === 'daily-todo') return Boolean(target?.closest?.('.todo-drag-strip'));
  return true;
}

function drainDragQueue() {
  if (dragDraining) return;
  dragDraining = true;
  const run = async () => {
    while (true) {
      const request = dragPendingUpdate || dragPendingTerminal;
      if (!request) break;
      if (request === dragPendingUpdate) dragPendingUpdate = undefined;
      else dragPendingTerminal = undefined;
      try { await window.widget.drag(request.operation, request.pointerId); } catch {}
    }
    dragDraining = false;
    if (dragPendingUpdate || dragPendingTerminal) drainDragQueue();
  };
  void run();
}

function queueDrag(operation, pointerId) {
  if (operation === 'update') dragPendingUpdate = { operation, pointerId };
  else dragPendingTerminal = { operation, pointerId };
  drainDragQueue();
}

function installNativeDragSurface(view) {
  view.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !isDragSurface(event.target)) return;
    dragPointerId = event.pointerId;
    view.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    queueDrag('start', dragPointerId);
  });
  view.addEventListener('pointermove', event => {
    if (dragPointerId !== event.pointerId) return;
    event.preventDefault();
    queueDrag('update', dragPointerId);
  });
  const finish = (event, operation) => {
    if (dragPointerId !== event.pointerId) return;
    event.preventDefault();
    queueDrag(operation, dragPointerId);
    dragPointerId = undefined;
    view.releasePointerCapture?.(event.pointerId);
  };
  view.addEventListener('pointerup', event => finish(event, 'end'));
  view.addEventListener('pointercancel', event => finish(event, 'cancel'));
  view.addEventListener('lostpointercapture', event => finish(event, 'cancel'));
}

function render() {
  if (!component) {
    stopClockTimer();
    stopQuotaTimer();
    stopTodoDateTimer();
    return;
  }
  if (component.type !== 'clock-date') stopClockTimer();
  if (component.type !== 'codex-quota') stopQuotaTimer();
  if (component.type !== 'daily-todo') stopTodoDateTimer();
  root.replaceChildren();
  const view = node('section', undefined, 'widget');
  applyTheme(view);
  if (component.type === 'system-monitor') renderSystemMonitor(view);
  else if (component.type === 'clock-date') renderClock(view);
  else if (component.type === 'note') renderNote(view);
  else if (component.type === 'daily-todo') renderDailyTodo(view);
  else if (component.type === 'codex-quota') renderCodexQuota(view);
  else view.append(node('p', '组件类型暂不支持', 'fallback'));
  installNativeDragSurface(view);
  root.append(view);
}

window.widget.onState(next => {
  const keepNoteEditor = component?.type === 'note' && next?.type === 'note' && noteEditor?.view?.isConnected;
  component = next;
  if (keepNoteEditor) syncNoteState();
  else { noteEditor = undefined; clearNoteSaveTimer(); render(); }
});
window.widget.onMetrics(next => { metrics = next; if (component?.type === 'system-monitor') render(); });
window.widget.onCodexQuota(next => { quota = next; if (component?.type === 'codex-quota') render(); });
window.widget.onEditMode(next => {
  editing = next?.editing === true;
  dragMode = next?.dragMode || 'electron-native';
  if (typeof next?.interactive === 'boolean') todoInteractive = next.interactive;
  if (noteEditor?.view?.isConnected) applyTheme(noteEditor.view);
  else render();
});
window.widget.onFlushNote(async ({ requestId } = {}) => {
  const ok = await saveNoteNow();
  window.widget.completeNoteFlush(requestId, { ok, errorCode: ok ? undefined : 'NOTE_SAVE_FAILED' });
});
window.addEventListener('beforeunload', () => { stopClockTimer(); stopQuotaTimer(); stopTodoDateTimer(); clearNoteSaveTimer(); });
