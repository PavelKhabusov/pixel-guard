const clients = new Map();
let nextId = 1;

export function subscribe(role, res) {
  const id = nextId++;
  clients.set(id, { role, res });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ id, role })}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  const drop = () => { clearInterval(ping); clients.delete(id); broadcastPeers(); };
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

function broadcastPeers() {
  const chunk = `event: peers\ndata: ${JSON.stringify(peers())}\n\n`;
  for (const { res } of clients.values()) res.write(chunk);
}
