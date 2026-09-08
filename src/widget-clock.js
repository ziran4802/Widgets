(function attachWidgetClock(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.widgetClock = Object.freeze(api);
}(typeof globalThis === 'object' ? globalThis : this, () => {
  function normalizedConfig(config = {}) {
    return {
      format: config.format === '12h' ? '12h' : '24h',
      showSeconds: config.showSeconds !== false
    };
  }

  function timeOptions(config) {
    const normalized = normalizedConfig(config);
    return {
      hour: '2-digit',
      minute: '2-digit',
      ...(normalized.showSeconds ? { second: '2-digit' } : {}),
      hour12: normalized.format === '12h'
    };
  }

  function formatTime(date, config) {
    return date.toLocaleTimeString('zh-CN', timeOptions(config));
  }

  function formatDate(date) {
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  }

  return { normalizedConfig, timeOptions, formatTime, formatDate };
}));
