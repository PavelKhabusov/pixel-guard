const BASE='http://localhost:8971';
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';
const r=await fetch(`${BASE}/bus?role=figma`);
const rd=r.body.pipeThrough(new TextDecoderStream()).getReader();
let buf='';
for(;;){const {value,done}=await rd.read(); if(done)break; buf+=value; let i;
  while((i=buf.indexOf('\n\n'))!==-1){const raw=buf.slice(0,i); buf=buf.slice(i+2);
    const ev=/^event: (.+)$/m.exec(raw)?.[1], data=/^data: (.+)$/m.exec(raw)?.[1];
    if(ev==='render'){const q=JSON.parse(data);
      fetch(`${BASE}/render-ack`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reqId:q.reqId})});
      setTimeout(()=>fetch(`${BASE}/render-result`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({reqId:q.reqId,result:{id:q.id,name:'n'+q.id,type:'FRAME',format:q.format,width:100,height:100,bytes:PNG}})}), 2500);
    }}}
