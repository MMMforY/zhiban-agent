function createScheduler({ db, scribe, archivist, vectorStore, assetVectorStore, assetDocumentVectorStore, diaryVectorStore, diaryMemoryVectorStore, config }) {
  assetDocumentVectorStore = assetDocumentVectorStore || { flushPending: async () => ({ skipped: true, reason: 'not_configured' }) };
  diaryVectorStore = diaryVectorStore || { flushPending: async () => ({ skipped: true, reason: 'not_configured' }) };
  diaryMemoryVectorStore = diaryMemoryVectorStore || { flushPending: async () => ({ skipped: true, reason: 'not_configured' }) };
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return { skipped: true, reason: 'already_running' };
    running = true;
    try {
      const chats = db.prepare(`
        SELECT c.id, c.last_message_at,
               SUM(CASE WHEN m.memory_processed=0 AND m.role IN ('user','assistant') THEN 1 ELSE 0 END) AS backlog
        FROM chats c LEFT JOIN messages m ON m.chat_id=c.id
        GROUP BY c.id
        HAVING backlog > 0
      `).all();
      const now = Date.now();
      const scribeResults = [];
      for (const chat of chats) {
        const lastMessageAt = new Date(`${chat.last_message_at || ''}`.replace(' ', 'T')).getTime();
        const silentMinutes = Number.isNaN(lastMessageAt) ? 0 : (now - lastMessageAt) / 60000;
        if (chat.backlog >= config.scribeBacklogMessages || silentMinutes >= config.scribeSilenceMinutes) {
          try {
            scribeResults.push({ chatId: chat.id, ...(await scribe.processChat(chat.id, { force: true })) });
          } catch (error) {
            scribeResults.push({ chatId: chat.id, error: error.message });
          }
        }
      }
      const lightweight = archivist.lightweightCycle();
      const latest = db.prepare('SELECT MAX(last_message_at) AS value FROM chats').get()?.value;
      const latestTime = new Date(`${latest || ''}`.replace(' ', 'T')).getTime();
      const idleMinutes = Number.isNaN(latestTime) ? Infinity : (now - latestTime) / 60000;
      const deep = idleMinutes >= config.deepCycleIdleMinutes
        ? await archivist.deepCycle()
        : { skipped: true, reason: 'user_not_idle' };
      const vectors = await vectorStore.flushPending();
      const assetVectors = await assetVectorStore.flushPending();
      const assetDocumentVectors = await assetDocumentVectorStore.flushPending();
      const diaryVectors = await diaryVectorStore.flushPending();
      const diaryMemoryVectors = await diaryMemoryVectorStore.flushPending();
      return { scribeResults, lightweight, deep, vectors, assetVectors, assetDocumentVectors, diaryVectors, diaryMemoryVectors };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => tick().catch((error) => {
      console.error('[scheduler] tick failed:', error.message);
    }), Math.max(10, config.archivistTickSeconds) * 1000);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function status() {
    return { started: Boolean(timer), running, intervalSeconds: config.archivistTickSeconds };
  }

  return { tick, start, stop, status };
}

module.exports = { createScheduler };
