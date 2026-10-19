const el = (id) => document.getElementById(id);
let chatId = null;
function status(message, error = false) { el('status').textContent = message; el('status').className = error ? 'error' : ''; }
function add(role, text) {
  const row = document.createElement('article'); row.className = `message ${role}`;
  const label = document.createElement('strong'); label.textContent = role === 'user' ? '你' : '知伴';
  row.append(label, document.createTextNode(text)); el('messages').append(row);
}
fetch('/health').then(r => r.json()).then(data => status(data.llmConfigured ? '模型配置已填写；实际可用性以对话结果为准。' : '模型尚未配置：请在服务端 .env 填写自己的模型信息并重启。')).catch(() => status('无法连接本机服务。', true));
el('new').addEventListener('click', () => { chatId = null; el('messages').replaceChildren(); status('已开始新对话，历史仍保存在本机数据库。'); });
el('chat').addEventListener('submit', async (event) => {
  event.preventDefault(); const message = el('message').value.trim(); if (!message) return;
  el('send').disabled = true; el('new').disabled = true; status('正在等待回复…');
  add('user', message); el('message').value = '';
  try {
    const headers = { 'Content-Type': 'application/json' }; const token = el('token').value.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch('/api/v1/chat', { method: 'POST', headers, body: JSON.stringify({ message, chatId, processMemory: el('memory').checked }) });
    const result = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? '访问令牌不正确，请检查连接设置。' : '请求失败；请检查本机服务与模型配置。');
    chatId = result.chatId;
    if (result.status === 'llm_disabled') status('消息已保存在本机，但模型未配置，尚未生成回复。', true);
    else { add('assistant', result.reply); status('回复完成。'); }
  } catch (error) { status(`${error.message} 消息可能已保存；不会自动重发。`, true); }
  finally { el('send').disabled = false; el('new').disabled = false; }
});
