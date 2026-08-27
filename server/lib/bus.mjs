const clients = new Map();
let nextId = 1;

export function subscribe(role, res) {
  const id = nextId++;
  clients.set(id, { role, res, since: Date.now() });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ id, role })}\n\n`);
  let ping;
  const drop = () => { clearInterval(ping); clients.delete(id); broadcastPeers(); };
  // an explicit event, not an SSE comment: the plugin uses it to know the
  // connection is alive without waiting for a probe request
  ping = setInterval(() => {
    try { res.write(`event: beat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`); }
    catch { drop(); }
  }, 20000);
  res.on('finish', drop);
  res.on('close', drop);
  res.on('error', drop);
  broadcastPeers();
  return id;
}

export function publish(event, payload, toRole) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  let sent = 0;
  for (const { role, res } of clients.values()) {
    if (toRole && role !== toRole) continue;
    res.write(chunk);
    sent++;
  }
  return sent;
}

export const peers = () => {
  const out = {};
  for (const { role } of clients.values()) out[role] = (out[role] ?? 0) + 1;
  return out;
};

/** Who is connected and for how long — to judge liveness without a probe request. */
export const peerDetails = () => [...clients.values()].map(({ role, since }) => ({
  role, uptimeSec: Math.round((Date.now() - since) / 1000),
}));

function broadcastPeers() {
  const chunk = `event: peers\ndata: ${JSON.stringify(peers())}\n\n`;
  for (const { res } of clients.values()) res.write(chunk);
}
