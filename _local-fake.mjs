const BASE = 'http://localhost:8971';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';
const r = await fetch(`${BASE}/bus?role=figma`);
const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
let buf = '';
for (;;) {
  const { value, done } = await reader.read(); if (done) break;
  buf += value; let i;
  while ((i = buf.indexOf('\n\n')) !== -1) {
    const raw = buf.slice(0, i); buf = buf.slice(i + 2);
    const ev = /^event: (.+)$/m.exec(raw)?.[1]; const data = /^data: (.+)$/m.exec(raw)?.[1];
    if (ev === 'render') { const q = JSON.parse(data);
      await fetch(`${BASE}/render-result`, { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ reqId:q.reqId, result:{ id:q.id, name:'Шапка', type:'COMPONENT', format:q.format, width:1920, height:120, bytes:PNG }})}); }
    if (ev === 'find') { const q = JSON.parse(data);
      await fetch(`${BASE}/render-result`, { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ reqId:q.reqId, nodes:[{id:'1310:27242',name:'header',type:'COMPONENT',page:'Page 1',width:1920,height:120}]})}); }
  }
}
