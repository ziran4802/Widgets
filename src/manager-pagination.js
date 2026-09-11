(function exposeManagerPagination(global) {
  function normalizePageSize(pageSize) {
    const value = Number(pageSize);
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 1;
  }

  function createPageModel(items, pageSize, currentPage = 0) {
    const values = Array.isArray(items) ? items : [];
    const size = normalizePageSize(pageSize);
    const pageCount = Math.max(1, Math.ceil(values.length / size));
    const requestedPage = Number.isFinite(Number(currentPage)) ? Math.floor(Number(currentPage)) : 0;
    const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
    const start = page * size;
    return {
      items: values.slice(start, start + size),
      totalItems: values.length,
      pageSize: size,
      pageCount,
      currentPage: page,
      hasPrevious: page > 0,
      hasNext: page < pageCount - 1
    };
  }

  const api = Object.freeze({ createPageModel, normalizePageSize });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.managerPagination = api;
})(typeof window === 'undefined' ? globalThis : window);
