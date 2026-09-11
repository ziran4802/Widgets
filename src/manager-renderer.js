const statusView = document.querySelector('#status');
const errorView = document.querySelector('#error');
const catalogView = document.querySelector('#catalog');
const componentsView = document.querySelector('#components');
const contentView = document.querySelector('.content');
const editorView = document.querySelector('#editor');
const editorContent = document.querySelector('#editor-content');
const revisionView = document.querySelector('#revision');
const sourceView = document.querySelector('#source');
const instanceCountView = document.querySelector('#instance-count');
const catalogTotalView = document.querySelector('#catalog-total');
const catalogPaginationView = document.querySelector('#catalog-pagination');
const catalogPreviousButton = document.querySelector('#catalog-prev');
const catalogPageView = document.querySelector('#catalog-page');
const catalogNextButton = document.querySelector('#catalog-next');
const componentPaginationView = document.querySelector('#component-pagination');
const componentPreviousButton = document.querySelector('#component-prev');
const componentPageView = document.querySelector('#component-page');
const componentNextButton = document.querySelector('#component-next');
const editLayoutButton = document.querySelector('#edit-layout');
const pages = new Map([
  ['components', document.querySelector('#page-components')],
  ['appearance', document.querySelector('#page-appearance')],
  ['settings', document.querySelector('#page-settings')]
]);
const navItems = [...document.querySelectorAll('.nav-item')];
const globalTheme = document.querySelector('#global-theme');
const globalOpacity = document.querySelector('#global-opacity');
const globalOpacityLabel = document.querySelector('#global-opacity-label');
const globalLocked = document.querySelector('#global-locked');
const autostartToggle = document.querySelector('#autostart-toggle');
const autostartStatus = document.querySelector('#autostart-status');
const autostartDetail = document.querySelector('#autostart-detail');
const autostartRetry = document.querySelector('#autostart-retry');
const autostartRepair = document.querySelector('#autostart-repair');
const disableAutostartExit = document.querySelector('#disable-autostart-exit');
let requestSequence = 0;
let snapshot;
let activeEdit;
let currentView = 'components';
let catalogPage = 0;
let componentPage = 0;
let editorBoundsInputs = new Map();
let editUpdateTail = Promise.resolve();
let autostartState;
let autostartBusy = false;
let resizeTimer;

const pagination = window.managerPagination;

const COMPONENT_DETAILS = Object.freeze({
  'system-monitor': Object.freeze({ icon: 'CPU', description: '实时查看处理器、内存和指标状态' }),
  'clock-date': Object.freeze({ icon: '24h', description: '显示本地时间、日期和星期' }),
  note: Object.freeze({ icon: 'TXT', description: '一篇纯文本便签，自动保存内容' }),
  'daily-todo': Object.freeze({ icon: 'TODO', description: '本地记录当天任务并追踪完成进度' }),
  'codex-quota': Object.freeze({ icon: 'CDX', description: '本地读取 Codex 五小时与周额度' })
});

function requestId() {
  requestSequence += 1;
  return `manager-${Date.now()}-${requestSequence}`;
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text, className, handler) {
  const element = node('button', text, className);
  element.addEventListener('click', handler);
  return element;
}

function showError(message) {
  errorView.textContent = message;
  errorView.title = message || '';
  errorView.hidden = !message;
}

function pageSizes() {
  const narrow = window.innerWidth < 920;
  return {
    catalog: narrow ? 2 : 3,
    components: narrow || window.innerHeight < 700 ? 3 : 5
  };
}

function updatePagination(view, previousButton, pageView, nextButton, page) {
  if (!view || !previousButton || !pageView || !nextButton) return;
  view.hidden = page.pageCount <= 1;
  pageView.textContent = `${page.currentPage + 1} / ${page.pageCount}`;
  previousButton.disabled = !page.hasPrevious;
  nextButton.disabled = !page.hasNext;
}

function paginate(items, pageSize, currentPage) {
  if (!pagination?.createPageModel) throw new Error('分页模块加载失败');
  return pagination.createPageModel(items, pageSize, currentPage);
}

function setTextTitle(element, text) {
  if (text !== undefined && text !== null) element.title = String(text);
  return element;
}

function catalogPreview(type) {
  const preview = node('div', undefined, 'preview');
  if (type === 'system-monitor') {
    const rings = node('div', undefined, 'preview-monitor');
    rings.append(node('span', undefined, 'mini-ring'), node('span', undefined, 'mini-ring'), node('span', undefined, 'mini-ring'));
    preview.append(rings);
  } else if (type === 'clock-date') {
    const clock = node('div', undefined, 'preview-clock');
    clock.append(node('strong', '09:41'), node('small', '2026年9月7日  星期一'));
    preview.append(clock);
  } else if (type === 'note') {
    const note = node('div', undefined, 'preview-note');
    note.append(node('strong', '便签'), node('span', '写下随手记录…'));
    preview.append(note);
  } else if (type === 'daily-todo') {
    const todo = node('div', undefined, 'preview-todo');
    const head = node('div', undefined, 'preview-todo-head');
    head.append(node('strong', '每日待办'), node('span', '3 / 5'));
    const rows = node('div', undefined, 'preview-todo-rows');
    for (const [label, checked] of [['整理今日任务', true], ['完成一个小目标', true], ['留出专注时间', false]]) {
      const row = node('span', undefined, checked ? 'done' : '');
      row.append(node('i', checked ? '✓' : '○'), node('em', label));
      rows.append(row);
    }
    todo.append(head, rows);
    preview.append(todo);
  } else if (type === 'codex-quota') {
    const quota = node('div', undefined, 'preview-codex-quota');
    const ring = node('span', undefined, 'preview-quota-ring');
    ring.append(node('strong', '—'), node('small', 'Codex'));
    const bars = node('div', undefined, 'preview-quota-bars');
    bars.append(node('span', '5 小时额度'), node('i'), node('span', '周额度'), node('i'));
    quota.append(ring, bars);
    preview.append(quota);
  }
  return preview;
}

async function dispatch(command, fields = {}) {
  const response = await window.manager.dispatch(command, { schemaVersion: 1, requestId: requestId(), ...fields });
  if (!response || response.ok !== true) throw new Error(response?.message || response?.errorCode || 'manager request failed');
  return response;
}

function renderHeader() {
  const app = snapshot?.app || {};
  statusView.textContent = app.phase === 'ready' ? '已就绪' : app.phase === 'degraded' ? '需要修复' : (app.phase || '未知');
  statusView.className = `badge ${app.phase === 'degraded' ? 'degraded' : app.phase === 'failed' ? 'failed' : ''}`;
  revisionView.textContent = `revision ${snapshot?.catalog?.revision ?? '—'}`;
  sourceView.textContent = `配置来源：${app.configSource || '—'}`;
  if (app.lastError) showError(app.lastError.message); else showError('');
}

function renderCatalog() {
  catalogView.replaceChildren();
  const items = snapshot?.catalog?.catalog || [];
  const page = paginate(items, pageSizes().catalog, catalogPage);
  catalogPage = page.currentPage;
  if (catalogTotalView) catalogTotalView.textContent = `共 ${items.length} 种`;
  updatePagination(catalogPaginationView, catalogPreviousButton, catalogPageView, catalogNextButton, page);
  if (items.length === 0) { catalogView.append(node('div', '暂无可用组件', 'empty')); return; }
  for (const item of page.items) {
    const detail = COMPONENT_DETAILS[item.type] || { icon: 'W', description: '桌面信息组件' };
    const card = node('article', undefined, 'card catalog-card');
    card.append(catalogPreview(item.type));
    const row = node('div', undefined, 'card-head');
    row.append(node('div', detail.icon, `component-icon ${item.type}`));
    const info = node('div');
    info.append(setTextTitle(node('div', item.displayName, 'title'), item.displayName));
    info.append(setTextTitle(node('div', detail.description, 'meta'), detail.description));
    row.append(info);
    const foot = node('div', undefined, 'card-foot');
    foot.append(node('span', item.available ? '可添加' : '已添加', `state ${item.available ? 'available' : 'added'}`));
    if (item.available) foot.append(button('添加到桌面', 'primary', () => addComponent(item.type)));
    card.append(row);
    card.append(foot);
    catalogView.append(card);
  }
}

function renderComponents() {
  componentsView.replaceChildren();
  const components = snapshot?.catalog?.components || [];
  const page = paginate(components, pageSizes().components, componentPage);
  componentPage = page.currentPage;
  if (instanceCountView) instanceCountView.textContent = String(components.length);
  updatePagination(componentPaginationView, componentPreviousButton, componentPageView, componentNextButton, page);
  if (components.length === 0) { componentsView.append(node('div', '还没有添加组件，从左侧目录开始。', 'empty')); return; }
  for (const component of page.items) {
    const detail = COMPONENT_DETAILS[component.type] || { icon: 'W', description: '桌面信息组件' };
    const card = node('article', undefined, 'card instance-card');
    const row = node('div', undefined, 'card-head');
    row.append(node('div', detail.icon, `component-icon ${component.type}`));
    const info = node('div');
    info.append(setTextTitle(node('div', component.displayName, 'title'), component.displayName));
    row.append(info);
    const status = node('div', undefined, 'instance-status');
    status.append(setTextTitle(node('div', detail.description, 'meta'), detail.description));
    status.append(node('span', component.visible ? '显示中' : '已隐藏', `state ${component.visible ? 'visible' : 'hidden'}`));
    const actions = node('div', undefined, 'actions card-actions');
    actions.append(button('⚙ 设置', 'secondary', () => beginEdit(component)));
    actions.append(button(component.visible ? '◉ 隐藏' : '◌ 显示', 'secondary', () => toggleVisible(component)));
    const more = node('details', undefined, 'more-actions');
    const moreTrigger = node('summary', '⋯', 'more-trigger');
    moreTrigger.title = '更多操作';
    moreTrigger.setAttribute('aria-label', `${component.displayName} 更多操作`);
    const moreMenu = node('div', undefined, 'more-menu');
    moreMenu.append(button('删除', 'danger', () => removeComponent(component.instanceId)));
    more.append(moreTrigger, moreMenu);
    card.append(row);
    card.append(status);
    card.append(actions);
    actions.append(more);
    componentsView.append(card);
  }
}

function renderEditor() {
  const editorVisible = Boolean(activeEdit && currentView === 'components');
  editorView.hidden = !editorVisible;
  contentView?.classList.toggle('editor-open', editorVisible);
  editorContent.replaceChildren();
  editorBoundsInputs = new Map();
  if (!editorVisible) return;
  const component = activeEdit.workingCopy;
  const form = node('div');
  const grid = node('div', undefined, 'form-grid');
  const fields = {};
  for (const [key, label] of [['x', 'X'], ['y', 'Y'], ['width', '宽度'], ['height', '高度']]) {
    const field = node('label', undefined, 'field');
    field.append(node('span', `${label}（DIP）`));
    const input = node('input');
    input.type = 'number';
    input.step = '1';
    input.value = component.bounds[key];
    fields[key] = input;
    editorBoundsInputs.set(key, input);
    field.append(input);
    grid.append(field);
  }
  const themeField = node('label', undefined, 'field');
  themeField.append(node('span', '主题'));
  const theme = node('select');
  for (const value of ['system', 'light', 'dark']) { const option = node('option', value); option.value = value; option.selected = value === component.theme.name; theme.append(option); }
  themeField.append(theme);
  grid.append(themeField);
  const opacityField = node('label', undefined, 'field');
  opacityField.append(node('span', '透明度'));
  const opacity = node('input');
  opacity.type = 'number'; opacity.step = '0.01'; opacity.min = '0.4'; opacity.max = '1'; opacity.value = component.theme.opacity;
  opacityField.append(opacity); grid.append(opacityField);
  let format;
  let showSeconds;
  let noteSize;
  let noteBackground;
  if (component.type === 'clock-date') {
    const formatField = node('label', undefined, 'field');
    formatField.append(node('span', '时间格式'));
    format = node('select');
    for (const value of ['24h', '12h']) { const option = node('option', value); option.value = value; option.selected = value === (component.config?.format || '24h'); format.append(option); }
    formatField.append(format);
    grid.append(formatField);

    const secondsField = node('label', undefined, 'checkbox-field');
    showSeconds = node('input');
    showSeconds.type = 'checkbox';
    showSeconds.checked = component.config?.showSeconds !== false;
    secondsField.append(showSeconds, node('span', '显示秒数'));
    grid.append(secondsField);
  }
  if (component.type === 'note') {
    const sizeField = node('label', undefined, 'field');
    sizeField.append(node('span', '尺寸'));
    noteSize = node('select');
    for (const [value, label] of [['compact', '紧凑'], ['standard', '标准'], ['large', '大']]) {
      const option = node('option', label);
      option.value = value;
      option.selected = value === (component.config?.size || 'standard');
      noteSize.append(option);
    }
    sizeField.append(noteSize);
    grid.append(sizeField);

    const backgroundField = node('label', undefined, 'field');
    backgroundField.append(node('span', '便签背景'));
    noteBackground = node('select');
    for (const [value, label] of [['yellow', '暖黄'], ['blue', '浅蓝'], ['green', '浅绿'], ['pink', '浅粉']]) {
      const option = node('option', label);
      option.value = value;
      option.selected = value === (component.config?.background || 'yellow');
      noteBackground.append(option);
    }
    backgroundField.append(noteBackground);
    grid.append(backgroundField);
  }
  const previewTheme = () => {
    queueEditUpdate({ theme: { name: theme.value, opacity: Number(opacity.value) } }).catch(error => showError(error.message));
  };
  theme.addEventListener('change', previewTheme);
  opacity.addEventListener('input', previewTheme);
  const previewClockConfig = () => {
    if (!format || !showSeconds) return;
    queueEditUpdate({ config: { ...(activeEdit?.workingCopy.config || {}), format: format.value, showSeconds: showSeconds.checked } }).catch(error => showError(error.message));
  };
  format?.addEventListener('change', previewClockConfig);
  showSeconds?.addEventListener('change', previewClockConfig);
  const previewNoteConfig = () => {
    if (!noteSize || !noteBackground) return;
    queueEditUpdate({ config: { size: noteSize.value, background: noteBackground.value } }).catch(error => showError(error.message));
  };
  noteSize?.addEventListener('change', previewNoteConfig);
  noteBackground?.addEventListener('change', previewNoteConfig);
  form.append(grid);
  const actions = node('div', undefined, 'editor-actions');
  actions.append(button('取消', 'secondary', cancelEdit));
  actions.append(button('完成并保存', 'primary', async () => {
    try {
      const bounds = { x: Number(fields.x.value), y: Number(fields.y.value), width: Number(fields.width.value), height: Number(fields.height.value), unit: 'dip' };
      const nextTheme = { name: theme.value, opacity: Number(opacity.value) };
      const patch = { bounds, theme: nextTheme };
      if (format && showSeconds) patch.config = { format: format.value, showSeconds: showSeconds.checked };
      if (noteSize && noteBackground) patch.config = { size: noteSize.value, background: noteBackground.value };
      await editUpdateTail;
      await queueEditUpdate(patch);
      await dispatch('manager:edit-complete', { sessionId: activeEdit.sessionId });
      activeEdit = undefined;
      editUpdateTail = Promise.resolve();
      await refresh();
    } catch (error) { showError(error.message); }
  }));
  form.append(actions);
  editorContent.append(form);
}

function renderAppearance() {
  const settings = snapshot?.catalog?.settings || { theme: 'system', opacity: 0.92, globalLocked: true };
  if (globalTheme) globalTheme.value = settings.theme;
  if (globalOpacity) globalOpacity.value = settings.opacity;
  if (globalOpacityLabel) globalOpacityLabel.textContent = `${Math.round(settings.opacity * 100)}%`;
  if (globalLocked) globalLocked.checked = settings.globalLocked;
}

function formatAutostartPath(state) {
  const path = state?.expected?.path;
  return path ? `目标路径：${path}` : '请从 dist\\Widget-portable\\Widget.exe 运行正式成品';
}

function renderAutostart(state = autostartState) {
  if (!autostartStatus || !autostartToggle) return;
  const status = state?.status || 'unavailable';
  const labels = {
    disabled: '未启用',
    enabled: '已启用',
    'path-mismatch': '需要修复',
    'system-disabled': '系统未生效',
    unsupported: '仅正式 portable 可用',
    unavailable: '读取失败'
  };
  autostartStatus.textContent = labels[status] || '未知状态';
  autostartStatus.className = `setting-value autostart-${status}`;
  autostartToggle.checked = status === 'enabled' || status === 'system-disabled';
  autostartToggle.disabled = autostartBusy || status === 'unsupported' || status === 'unavailable';
  if (autostartDetail) {
    const message = state?.message || '无法读取 Windows 当前用户启动状态';
    const effective = state?.effective?.enabled ? 'Windows 报告当前启动项可生效' : 'Windows 报告当前启动项未生效';
    const detail = `${message}；${effective}。${formatAutostartPath(state)}`;
    autostartDetail.textContent = detail;
    autostartDetail.title = detail;
  }
  if (autostartRepair) autostartRepair.hidden = status !== 'path-mismatch';
  if (autostartRetry) autostartRetry.disabled = autostartBusy;
  if (disableAutostartExit) disableAutostartExit.disabled = autostartBusy || status === 'unsupported';
}

async function refreshAutostart() {
  if (typeof window.manager?.autostart !== 'function') {
    autostartState = { status: 'unavailable', message: '当前管理器不支持读取自启动状态' };
    renderAutostart();
    return;
  }
  autostartBusy = true;
  renderAutostart();
  try {
    const result = await window.manager.autostart('get');
    autostartState = result?.state || result;
  } catch (error) {
    autostartState = { status: 'unavailable', message: error.message || '读取失败' };
  } finally {
    autostartBusy = false;
    renderAutostart();
  }
}

async function updateAutostart(action) {
  if (autostartBusy || typeof window.manager?.autostart !== 'function') return;
  autostartBusy = true;
  renderAutostart();
  try {
    const result = await window.manager.autostart(action);
    if (result?.ok !== true) throw new Error(result?.message || result?.errorCode || '自启动操作失败');
    autostartState = result?.state || result;
    if (action === 'disable-and-exit') return;
  } catch (error) {
    showError(error.message || '自启动操作失败');
  } finally {
    autostartBusy = false;
    renderAutostart();
    if (action !== 'disable-and-exit') await refreshAutostart();
  }
}

function setView(view) {
  if (!pages.has(view)) return;
  if (activeEdit && view !== 'components') {
    showError('请先完成或取消当前布局编辑，再切换页面');
    return;
  }
  currentView = view;
  for (const [name, page] of pages) page.hidden = name !== view;
  for (const item of navItems) item.classList.toggle('active', item.dataset.view === view);
  renderEditor();
  showError('');
  if (view === 'settings') void refreshAutostart();
}

async function updateSettings(patch) {
  try {
    await dispatch('manager:settings-update', { payload: { patch } });
    await refresh();
  } catch (error) { showError(error.message); }
}

function queueEditUpdate(patch) {
  const sessionId = activeEdit?.sessionId;
  if (!sessionId) return Promise.resolve(null);
  const operation = editUpdateTail.then(async () => {
    if (!activeEdit || activeEdit.sessionId !== sessionId) return null;
    const response = await dispatch('manager:edit-update', { sessionId, payload: { patch } });
    if (activeEdit?.sessionId === sessionId) activeEdit.workingCopy = response.edit?.workingCopy || response.edit;
    return response;
  });
  editUpdateTail = operation.catch(() => {});
  return operation;
}

function applyComponentMoved(move) {
  if (!activeEdit || activeEdit.workingCopy.instanceId !== move.instanceId) return;
  activeEdit.workingCopy = {
    ...activeEdit.workingCopy,
    bounds: { ...activeEdit.workingCopy.bounds, x: move.x, y: move.y }
  };
  const xInput = editorBoundsInputs.get('x');
  const yInput = editorBoundsInputs.get('y');
  if (xInput) xInput.value = move.x;
  if (yInput) yInput.value = move.y;
}

function render() {
  renderHeader();
  renderCatalog();
  renderComponents();
  renderAppearance();
  renderEditor();
}

async function refresh() {
  try {
    const response = await dispatch('manager:get-snapshot');
    snapshot = response.snapshot;
    render();
  } catch (error) { showError(error.message); }
}

async function addComponent(type) {
  try { await dispatch('manager:component-add', { payload: { type } }); await refresh(); } catch (error) { showError(error.message); }
}

async function removeComponent(instanceId) {
  const component = snapshot?.catalog?.components?.find(item => item.instanceId === instanceId);
  if (component?.type === 'note' && !window.confirm('删除便签将同时删除已保存的标题和正文，确定继续吗？')) return;
  try { await dispatch('manager:component-remove', { instanceId }); await refresh(); } catch (error) { showError(error.message); }
}

async function toggleVisible(component) {
  try { await dispatch('manager:component-update', { instanceId: component.instanceId, payload: { field: 'visible', value: !component.visible } }); await refresh(); } catch (error) { showError(error.message); }
}

async function beginEdit(component) {
  try {
    const response = await dispatch('manager:edit-begin', { instanceId: component.instanceId, sessionId: `edit-${Date.now()}-${++requestSequence}` });
    activeEdit = { sessionId: response.edit.sessionId, workingCopy: response.edit.workingCopy };
    editUpdateTail = Promise.resolve();
    renderEditor();
  } catch (error) { showError(error.message); }
}

async function beginLayoutEdit() {
  const target = snapshot?.catalog?.components?.find(component => component.visible);
  if (!target) { showError('请先添加一个可见组件'); return; }
  await beginEdit(target);
}

async function cancelEdit() {
  if (!activeEdit) return;
  try {
    await editUpdateTail;
    await dispatch('manager:edit-cancel', { sessionId: activeEdit.sessionId });
    activeEdit = undefined;
    editUpdateTail = Promise.resolve();
    await refresh();
  } catch (error) { showError(error.message); }
}

document.querySelector('#refresh').addEventListener('click', refresh);
catalogPreviousButton?.addEventListener('click', () => { catalogPage -= 1; renderCatalog(); });
catalogNextButton?.addEventListener('click', () => { catalogPage += 1; renderCatalog(); });
componentPreviousButton?.addEventListener('click', () => { componentPage -= 1; renderComponents(); });
componentNextButton?.addEventListener('click', () => { componentPage += 1; renderComponents(); });
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!activeEdit) { renderCatalog(); renderComponents(); }
  }, 80);
});
for (const item of navItems) item.addEventListener('click', () => setView(item.dataset.view));
editLayoutButton?.addEventListener('click', beginLayoutEdit);
globalTheme?.addEventListener('change', () => updateSettings({ theme: globalTheme.value }));
globalOpacity?.addEventListener('change', () => updateSettings({ opacity: Number(globalOpacity.value) }));
globalLocked?.addEventListener('change', () => updateSettings({ globalLocked: globalLocked.checked }));
autostartToggle?.addEventListener('change', () => updateAutostart(autostartToggle.checked ? 'enable' : 'disable'));
autostartRetry?.addEventListener('click', refreshAutostart);
autostartRepair?.addEventListener('click', () => updateAutostart('repair'));
disableAutostartExit?.addEventListener('click', () => updateAutostart('disable-and-exit'));
if (typeof window.manager.onComponentMoved === 'function') window.manager.onComponentMoved(applyComponentMoved);
setView('components');
refresh();
