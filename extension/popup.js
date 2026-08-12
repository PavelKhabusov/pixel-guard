const refresh = () => {
  chrome.runtime.sendMessage({ type: 'pg-status' }, (s) => {
    if (!s) return;
    document.getElementById('dot').className = `dot ${s.connected ? 'on' : 'off'}`;
    document.getElementById('state').textContent = s.connected ? 'подключён к серверу' : 'сервер недоступен';
    document.getElementById('figma').textContent = s.peers?.figma ? `${s.peers.figma} ✓` : 'нет';
    document.getElementById('ext').textContent = s.peers?.extension ?? 0;
  });
};

document.getElementById('rc').onclick = () => {
  chrome.runtime.sendMessage({ type: 'pg-reconnect' }, () => setTimeout(refresh, 600));
};

refresh();
setInterval(refresh, 1500);
