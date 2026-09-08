const phase = document.querySelector('#phase');
const capability = document.querySelector('#capability');
const lastResult = document.querySelector('#last-result');
const stateView = document.querySelector('#state');

function render(value) {
  if (!value) return;
  phase.textContent = value.phase || '未知';
  capability.textContent = JSON.stringify(value.capability || {}, null, 2);
  lastResult.textContent = JSON.stringify(value.lastResult || {}, null, 2);
  stateView.textContent = JSON.stringify({ runId: value.runId, phase: value.phase, attached: value.attached, mode: value.mode, bounds: value.bounds, scaleFactor: value.scaleFactor, records: value.records?.length || 0 }, null, 2);
}

for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await window.m0.command(button.dataset.command);
      if (result && result.error) lastResult.textContent = JSON.stringify(result, null, 2);
    } finally { button.disabled = false; }
  });
}

window.m0.onState(render);
window.m0.getState().then(render).catch(error => { lastResult.textContent = error.message; });
