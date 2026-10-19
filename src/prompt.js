const { getActivePersona, assemblePersona } = require('./b-gpe-adapter');

function permissionInstruction(permission) {
  if (permission === 'cite') return 'May be referenced as a remembered fact.';
  if (permission === 'cautious') return 'Use cautious language and leave room for correction.';
  return 'Internal association only; do not state as fact.';
}

function createPromptBuilder({ db, librarian, diaryStore, aboutDiaryMemoryStore, assetDocumentStore, continuityId }) {
  diaryStore = diaryStore || { search: async () => [] };
  aboutDiaryMemoryStore = aboutDiaryMemoryStore || { search: async () => [] };
  assetDocumentStore = assetDocumentStore || { searchRouteCards: async () => [] };
  async function runtimeContext(userMessage) {
    const [memories, aboutDiaryMemories, diaryMemories, personalTheoryMemories] = await Promise.all([
      librarian.searchHybrid(userMessage, 3), aboutDiaryMemoryStore.search(userMessage, 3), diaryStore.search(userMessage, 2),
      assetDocumentStore.searchRouteCards(userMessage)
    ]);
    const states = db.prepare(`
      SELECT id, content, expires_at FROM current_states
      WHERE status='active' AND expires_at > CURRENT_TIMESTAMP
      ORDER BY expires_at LIMIT 10
    `).all();
    return { memories, aboutDiaryMemories, diaryMemories, personalTheoryMemories, states };
  }

  async function build(userMessage) {
    const sections = getActivePersona(db, continuityId);
    const persona = assemblePersona(sections);
    const { memories, aboutDiaryMemories, diaryMemories, personalTheoryMemories, states } = await runtimeContext(userMessage);
    const memoryLines = [
      ...memories.map((memory) => `- [memory:${memory.id}; ${memory.recallPermission}] ${memory.content} (${permissionInstruction(memory.recallPermission)})`),
      ...aboutDiaryMemories.map((memory) => `- [关于日记的记忆:${memory.id}; ${memory.dateStart || 'date uncertain'}; importance=${memory.importance}] ${memory.content}`),
      ...personalTheoryMemories.map((item) => `- [个人理论记忆:${item.id}; document=${item.document?.title || ''}; version=${item.document?.versionLabel || ''}] ${item.title}: ${item.content}`)
    ];
    const memoryBlock = memoryLines.length
      ? memoryLines.join('\n')
      : '- No relevant stored memory was found.';
    const stateBlock = states.length
      ? states.map((state) => `- ${state.content} (expires ${state.expires_at})`).join('\n')
      : '- No active temporary state.';
    return {
      system: `${persona}\n\n## Runtime memory policy\n\nStored memories are fallible and source-bound. Never invent a shared experience. Respect recall permissions. “关于日记的记忆” is first-class autobiographical memory about the user and should be used alongside conversational memory. Personal theory memory is sourced from a user-authored document: treat it as what the user proposed in that document version, preserve its tensions, and do not silently turn it into an eternal personality trait or an externally proven fact. A learned self-model does not override core identity or relationship boundaries.\n\n## Active temporary state\n${stateBlock}\n\n## Relevant memories\n${memoryBlock}\n\n## Supporting diary evidence\n${diaryMemories.length ? diaryMemories.map((item) => `- [${item.absolute_date || 'date uncertain'}] ${item.content}`).join('\n') : '- No additional diary excerpt was found.'}`,
      memories,
      aboutDiaryMemories,
      diaryMemories,
      personalTheoryMemories,
      states,
      personaSections: sections.map((section) => ({ id: section.id, key: section.section_key, authority: section.authority }))
    };
  }

  async function buildHermesContext(userMessage) {
    const { memories, aboutDiaryMemories, diaryMemories, personalTheoryMemories, states } = await runtimeContext(userMessage);
    const learnedPersona = getActivePersona(db, continuityId)
      .filter((section) => section.authority === 'learned')
      .map((section) => ({
        id: section.id,
        key: section.section_key,
        content: section.content,
        confidence: section.confidence,
        evidenceCount: section.evidence_count
      }));
    const lines = [
      '## Retrieved companion memory',
      'Memories are source-bound and fallible. Never invent a shared experience. Respect each recall permission.',
      ...memories.map((memory) => `- [memory:${memory.id}; ${memory.recallPermission}] ${memory.content}`),
      ...aboutDiaryMemories.map((memory) => `- [关于日记的记忆:${memory.id}; category=${memory.category}; date=${memory.dateStart || 'uncertain'}; importance=${memory.importance}] ${memory.content}`),
      ...((memories.length || aboutDiaryMemories.length) ? [] : ['- No relevant stored memory was found.']),
      '',
      '## Relevant personal theory memory',
      'These route cards are sourced from user-authored documents. Treat them as the user\'s theory at that document version, not as an externally proven fact or an eternal personality trait. Preserve stated tensions and retrieve the original asset when exact wording or wider context matters.',
      ...personalTheoryMemories.map((item) => `- [个人理论记忆:${item.id}; document=${item.document?.title || ''}; version=${item.document?.versionLabel || ''}; lines=${item.sourceLineStart || '?'}-${item.sourceLineEnd || '?'}] ${item.title}: ${item.content}`),
      ...(personalTheoryMemories.length ? [] : ['- No strongly relevant personal theory card was found.']),
      '',
      '## Supporting diary evidence',
      'These excerpts support 关于日记的记忆. Cite their date and distinguish "then" from "now". Retrieval itself is not a new event or new evidence.',
      ...diaryMemories.map((item) => `- [diary:${item.entry_id}; chunk=${item.id}; date=${item.absolute_date || 'uncertain'}; cycle=${item.cycle_id}/${item.cycle_day}] ${item.content}`),
      ...(diaryMemories.length ? [] : ['- No relevant diary excerpt was found.']),
      '',
      '## Active temporary state',
      ...states.map((state) => `- ${state.content} (expires ${state.expires_at})`),
      ...(states.length ? [] : ['- No active temporary state.']),
      '',
      '## Approved learned persona additions',
      ...learnedPersona.map((section) => `- [${section.key}] ${section.content}`),
      ...(learnedPersona.length ? [] : ['- No approved learned additions.'])
    ];
    return { context: lines.join('\n'), memories, aboutDiaryMemories, diaryMemories, personalTheoryMemories,
      retrievedDiaryIds: diaryMemories.map((item) => item.id),
      retrievedDiaryMemoryIds: aboutDiaryMemories.map((item) => item.id),
      retrievedTheoryUnitIds: personalTheoryMemories.map((item) => item.id), states, learnedPersona };
  }

  return { build, buildHermesContext };
}

module.exports = { createPromptBuilder };
