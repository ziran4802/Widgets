const status = document.querySelector('#status');
const detail = document.querySelector('#detail');
const mode = document.querySelector('#mode');

function render(value) {
  if (!value) return;
  mode.textContent = String(value.mode || 'locked').toUpperCase();
  status.textContent = value.attached ? `已附着 · ${value.lastResult?.result || '等待操作'}` : `未附着 · ${value.lastResult?.result || '等待附着'}`;
  detail.textContent = value.lastResult?.reasons?.join('；') || (value.capability?.reason || '控制面板可执行附着、编辑输入、几何读回和恢复。');
}

window.m0.onState(render);
window.m0.getState().then(render).catch(() => {});
