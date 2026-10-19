import { createMemoryApi, MemoryApiError } from '/js/memory-api.mjs';
import {
  createConstellationView,
  categoryOrder,
  categoryLabels,
  categoryColors
} from '/js/constellation-view.mjs';
import { createUniversePresentation, coverageMessage } from '/js/universe-model.mjs';

const canvas = document.getElementById('star-map');
const statusEl = document.getElementById('status');
const connectionButton = document.getElementById('connection-button');
const connectionDialog = document.getElementById('connection-dialog');
const connectionForm = document.getElementById('connection-form');
const connectionError = document.getElementById('connection-error');
const tokenInput = document.getElementById('access-token');
const connectSubmit = document.getElementById('connect-submit');
const forgetToken = document.getElementById('forget-token');
const closeConnection = document.getElementById('close-connection');
const emptyEl = document.getElementById('empty-state');
const panel = document.getElementById('detail-panel');
const metricsEl = document.getElementById('metrics');
const legendEl = document.getElementById('legend');
const layerOverviewEl = document.getElementById('layer-overview');
const memoryLayersEl = document.getElementById('memory-layers');
const coverageNoteEl = document.getElementById('coverage-note');

const api = createMemoryApi();
const view = createConstellationView({ canvas, onSelect: openDetails });
let loading = false;

function setConnectionState(state, message) {
  connectionButton.dataset.state = state;
  statusEl.textContent = message;
}

function setConnectionError(message = '') {
  connectionError.textContent = message;
  connectionError.hidden = !message;
}

function openConnectionSettings({ message = '', focusToken = false } = {}) {
  setConnectionError(message);
  forgetToken.hidden = !api.hasAccessToken();
  if (!connectionDialog.open) connectionDialog.showModal();
  if (focusToken) requestAnimationFrame(() => tokenInput.focus());
}

function closeConnectionSettings() {
  setConnectionError();
  tokenInput.value = '';
  if (connectionDialog.open) connectionDialog.close();
}

function renderLegend() {
  legendEl.innerHTML = categoryOrder.map((category) => (
    `<span><i style="background:${categoryColors[category]};color:${categoryColors[category]}"></i>${categoryLabels[category]}</span>`
  )).join('');
}

function renderOverview(universe) {
  const presentation = createUniversePresentation(universe);
  const layerStatus = {
    active: '当前星图',
    available: '可进入',
    pending: '待服务端接入',
    quarantined: '隔离 · 不入星图'
  };

  memoryLayersEl.innerHTML = presentation.layers.map((layer) => {
    const isConversation = layer.id === 'conversation';
    const count = isConversation ? presentation.conversationDisplay.count : layer.count;
    const unit = isConversation ? presentation.conversationDisplay.unit : layer.unit;
    const note = isConversation ? presentation.conversationDisplay.note : layerStatus[layer.status];
    return `<article class="memory-layer ${isConversation ? 'is-current' : ''} ${layer.status === 'quarantined' ? 'is-quarantined' : ''}">
      <span>${escapeHtml(layer.label)}</span>
      <strong>${count === null ? '—' : escapeHtml(count)}${count === null ? '' : `<small>${escapeHtml(unit)}</small>`}</strong>
      <em>${escapeHtml(note)}</em>
    </article>`;
  }).join('');
  coverageNoteEl.textContent = coverageMessage(presentation);
  layerOverviewEl.hidden = false;

  metricsEl.innerHTML = [
    `${presentation.metrics.entities ?? '—'} 星座`,
    `${presentation.metrics.entityLinks ?? '—'} 实体关联`,
    `${presentation.metrics.episodes ?? '—'} 情节`
  ].map((item) => `<span>${item}</span>`).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function formatDate(value) {
  if (!value) return '日期未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function openDetails(node) {
  document.getElementById('detail-galaxy').textContent = node.galaxyLabel || categoryLabels[node.category] || 'Constellation';
  document.getElementById('detail-title').textContent = node.label;
  document.getElementById('detail-summary').textContent = node.description || '这座星座还没有形成稳定概述。';
  const statusWrap = document.getElementById('detail-status-wrap');
  const judgmentWrap = document.getElementById('detail-judgment-wrap');
  statusWrap.hidden = !node.currentStatus;
  judgmentWrap.hidden = !node.judgment;
  document.getElementById('detail-status').textContent = node.currentStatus || '';
  document.getElementById('detail-judgment').textContent = node.judgment || '';
  document.getElementById('memory-list').innerHTML = node.stars.length
    ? node.stars.map((memory) => `<article class="memory-card"><p>${escapeHtml(memory.content)}</p><small>${escapeHtml(memory.lifecycle)} · ${escapeHtml(formatDate(memory.date))}</small></article>`).join('')
    : '<p class="summary">暂无碎片。</p>';
  document.getElementById('episode-list').innerHTML = node.episodes.length
    ? node.episodes.map((episode) => `<article class="episode-card"><strong>${escapeHtml(episode.title)}</strong><p>${escapeHtml(episode.content)}</p><small>${escapeHtml(formatDate(episode.date))}</small></article>`).join('')
    : '<p class="summary">尚未形成情节。</p>';
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
}

function closeDetails() {
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
}

function messageForError(error) {
  if (error instanceof MemoryApiError && error.status === 401) return '访问令牌无效，请重新输入。';
  if (error instanceof MemoryApiError && error.code === 'network_error') return '无法连接 Memory Runtime。请确认本机服务或 SSH 隧道正在运行。';
  return `连接失败：${error.message || 'unknown_error'}`;
}

async function loadUniverse({ promptForToken = true, reportToDialog = false } = {}) {
  if (loading) return false;
  loading = true;
  connectSubmit.disabled = true;
  setConnectionState('loading', '正在连接…');

  try {
    const [health, universe] = await Promise.all([api.health(), api.universe()]);
    view.setUniverse(universe);
    renderOverview(universe);
    renderLegend();
    emptyEl.hidden = universe.constellations.length > 0;
    setConnectionState('online', `B-GPE ${health.bGpeVersion} · ${health.llmConfigured ? 'LLM online' : 'memory-only'}`);
    closeConnectionSettings();
    return true;
  } catch (error) {
    view.clear();
    closeDetails();
    emptyEl.hidden = true;
    metricsEl.innerHTML = '';
    layerOverviewEl.hidden = true;

    if (error instanceof MemoryApiError && error.status === 401) {
      api.clearAccessToken();
      setConnectionState('locked', '需要访问令牌');
      if (promptForToken) {
        openConnectionSettings({ message: reportToDialog ? messageForError(error) : '', focusToken: true });
      }
    } else {
      setConnectionState('error', '连接失败');
      if (reportToDialog) openConnectionSettings({ message: messageForError(error) });
    }
    return false;
  } finally {
    loading = false;
    connectSubmit.disabled = false;
  }
}

connectionButton.addEventListener('click', () => openConnectionSettings({ focusToken: true }));
closeConnection.addEventListener('click', closeConnectionSettings);
document.getElementById('close-panel').addEventListener('click', closeDetails);

connectionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (token) api.setAccessToken(token);
  tokenInput.value = '';
  const connected = await loadUniverse({ promptForToken: true, reportToDialog: true });
  if (!connected && !connectionDialog.open) openConnectionSettings({ message: '连接未完成，请重试。', focusToken: true });
});

forgetToken.addEventListener('click', async () => {
  api.clearAccessToken();
  tokenInput.value = '';
  forgetToken.hidden = true;
  await loadUniverse({ promptForToken: true });
});

connectionDialog.addEventListener('close', () => {
  tokenInput.value = '';
  setConnectionError();
});

loadUniverse();
