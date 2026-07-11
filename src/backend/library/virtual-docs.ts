// GUI \u5de6\u4fa7\u680f\u300c\u5bfc\u822a\u300d\u865a\u62df\u6587\u6863\u7684\u8eab\u4efd\u5e38\u91cf\uff1a\u628a library \u6587\u4ef6\u5939\u5c42\u7ea7\u5448\u73b0\u6210\u4e00\u7bc7\u53ef\u6d4f\u89c8\u7684\u5bfc\u822a\u89c6\u56fe\uff0c
// \u4f5c\u7528\u7b49\u540c MCP \u7684 library_index\u2014\u2014\u540c\u4e00\u80fd\u529b\u7684 GUI \u5448\u73b0\u3002docs \u8868\u91cc\u53ea\u6709\u4e00\u884c\u58f3\uff080 \u8282\u70b9\u3001\u65e0 source\u3001
// meta.virtual=true\uff09\uff0c\u5bfc\u822a\u6811\u8fd0\u884c\u65f6\u4ece library \u6587\u4ef6\u7cfb\u7edf\u52a8\u6001\u751f\u6210\uff0c\u4e0d\u643a\u5e26\u4efb\u4f55\u4e0d\u53ef\u518d\u751f\u6570\u636e\u3002
// library \u88c5\u914d\u5728 store \u521d\u59cb\u5316\u540e\u6309\u672c\u5e38\u91cf UPSERT \u515c\u5e95\u91cd\u5efa\uff08\u8bef\u5220\u53ef\u81ea\u6108\uff09\uff1bdelete \u52a8\u8bcd\u5728\u5165\u53e3
// \u6309 meta.virtual \u62d2\u5220\uff08import-service.deleteImportedDocument\uff09\u2014\u2014\u5220\u9664\u65e0\u610f\u4e49\uff0c\u4e14\u91cd\u5efa\u524d\u7684
// \u7a97\u53e3\u671f GUI \u6253\u5f00\u5bfc\u822a\u884c\u4e3a\u672a\u5b9a\u4e49\u3002
export const LIBRARY_NAVIGATION_DOC_ID = '019e8ea9-92db-7303-8bb1-3b6533e2bd73';
export const LIBRARY_NAVIGATION_DOC_TITLE = '\u5bfc\u822a';
export const LIBRARY_NAVIGATION_DOC_META = Object.freeze({
  virtual: true,
  virtualType: 'libraryNavigation',
  sourceBinding: null
});

interface VirtualDocStore {
  db: {
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
    };
  };
}

export function ensureLibraryNavigationDoc(store: VirtualDocStore): void {
  store.db.prepare(`
    INSERT INTO docs (id, title, meta, folder_id, doc_sort_order)
    VALUES (?, ?, ?, NULL, 0)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      meta = excluded.meta
  `).run(
    LIBRARY_NAVIGATION_DOC_ID,
    LIBRARY_NAVIGATION_DOC_TITLE,
    JSON.stringify(LIBRARY_NAVIGATION_DOC_META)
  );
}
