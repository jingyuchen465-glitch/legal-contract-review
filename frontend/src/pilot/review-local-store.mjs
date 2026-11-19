const DATABASE = 'legal-margin-review';
const STORE = 'documents';
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开本机存储，请下载 DOCX 保留修改'));
  });
}
export async function readLocalReview(key) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
export async function saveLocalReview(key, value) {
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(value, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(new Error('本机保存失败，请下载 DOCX 保留修改'));
      transaction.onabort = () => reject(new Error('本机保存中断，修改仍保留在页面中'));
    });
  } finally { db.close(); }
}
