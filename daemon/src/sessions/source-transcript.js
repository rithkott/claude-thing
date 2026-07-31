// Tails a session's transcript JSONL for token usage + activity. The format
// is Claude Code-internal — every field access is defensive.

import fs from 'node:fs';

export function startTranscriptTail({ store, sessionId, transcriptPath }) {
  let offset = 0;
  let reading = false;

  function harvest(line) {
    let obj;
    try { obj = JSON.parse(line); } catch { return; }

    const msg = obj.message || obj;
    const usage = msg.usage || obj.usage;
    if (usage) {
      const raw = store.raw(sessionId) || {};
      // What a turn sent is what the window currently holds, so the newest
      // turn's prompt size *is* the context occupancy — an overwrite, not a
      // sum. The lifetime counters below are the opposite arithmetic on the
      // same numbers.
      store.upsert(sessionId, {
        contextTokens: (usage.input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0),
      });
      // Cache reads are counted separately: summing them across every turn
      // reaches tens of millions and drowns out the real numbers.
      store.upsert(sessionId, {
        tokensIn: (raw.tokensIn || 0) + (usage.input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0),
        tokensOut: (raw.tokensOut || 0) + (usage.output_tokens || 0),
        cacheRead: (raw.cacheRead || 0) + (usage.cache_read_input_tokens || 0),
      });
    }
    if (msg.model) store.upsert(sessionId, { model: msg.model });

    // last assistant text snippet
    const content = msg.content;
    if (Array.isArray(content)) {
      const text = content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join(' ');
      if (text) store.upsert(sessionId, { lastMessage: text.slice(0, 200) });
    }
    if (obj.timestamp || msg.timestamp) {
      const ts = Date.parse(obj.timestamp || msg.timestamp);
      if (!Number.isNaN(ts)) store.upsert(sessionId, { lastActivityTs: ts });
    }
  }

  function readNew() {
    if (reading) return;
    reading = true;
    fs.stat(transcriptPath, (err, st) => {
      if (err || st.size <= offset) { reading = false; return; }
      const stream = fs.createReadStream(transcriptPath, { start: offset, end: st.size - 1 });
      let buf = '';
      stream.on('data', (c) => { buf += c.toString('utf8'); });
      stream.on('end', () => {
        offset = st.size;
        const lines = buf.split('\n');
        for (const line of lines) if (line.trim()) harvest(line);
        reading = false;
      });
      stream.on('error', () => { reading = false; });
    });
  }

  // catch up from the start so tokens reflect the whole session
  readNew();
  let watcher = null;
  try {
    watcher = fs.watch(transcriptPath, readNew);
  } catch {
    // file may not exist yet; poll until it does
  }
  const poll = setInterval(readNew, 3_000);

  return {
    stop: () => {
      clearInterval(poll);
      if (watcher) watcher.close();
    },
  };
}
