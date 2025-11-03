// public/script.js — main UI logic + TTS + sparkline
const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws');
const pairSelect = document.getElementById('pairSelect');
const startBtn = document.getElementById('startBtn');
const nextBtn = document.getElementById('nextBtn');
const autoBtn = document.getElementById('autoBtn');
const ttsBtn = document.getElementById('ttsBtn');
const signalTitle = document.getElementById('signalTitle');
const signalBody = document.getElementById('signalBody');
const countdownEl = document.getElementById('countdown');
const logBox = document.getElementById('logBox');
const signalTimes = document.getElementById('signalTimes');
const spark = document.getElementById('spark');
const ctx = spark.getContext('2d');

let currentPair = null;
let countdownTimer = null;
let lastSparkData = [];

function pushLog(t){ const d=new Date().toLocaleTimeString(); logBox.innerHTML = `<div>[${d}] ${t}</div>` + logBox.innerHTML; }

function populatePairs(pairsStructured){
  pairSelect.innerHTML = '';
  const groups = {};
  pairsStructured.forEach(p => { (groups[p.type] = groups[p.type] || []).push(p.symbol); });
  const order = ['real','otc','crypto','commodity'];
  order.forEach(type => {
    if(!groups[type]) return;
    const labelOpt = document.createElement('option'); labelOpt.disabled = true; labelOpt.textContent = `--- ${type.toUpperCase()} ---`; pairSelect.appendChild(labelOpt);
    groups[type].forEach(sym => { const o = document.createElement('option'); o.value = sym; o.textContent = sym; pairSelect.appendChild(o); });
  });
  if(pairSelect.options.length > 0) currentPair = pairSelect.value;
}

ws.onopen = ()=> pushLog('WS connected to backend');
ws.onmessage = (evt) => {
  try {
    const msg = JSON.parse(evt.data);
    if(msg.type === 'hello' || msg.type === 'pairs'){
      pushLog('Server: ' + (msg.server_time || new Date().toISOString()));
      const pairs = msg.pairs || [];
      if(Array.isArray(pairs) && pairs.length && typeof pairs[0] === 'object') populatePairs(pairs);
    } else if(msg.type === 'signal'){
      showSignal(msg.data);
    } else if(msg.type === 'hold'){
      showHold(msg.data);
      pushLog(`HOLD ${msg.data.symbol || ''} -> ${msg.data.reason || ''}`);
    } else if(msg.type === 'log'){
      pushLog(msg.data);
    } else if(msg.type === 'signal_result'){
      pushLog(`Result ${msg.data.symbol} => ${msg.data.result} @ ${msg.data.finalPrice}`);
    } else if(msg.type === 'scores'){
      pushLog('Top scores: ' + JSON.stringify(msg.data));
    }
  } catch(e){ console.warn('ws parse err', e); }
};

pairSelect.onchange = ()=> currentPair = pairSelect.value;

function showHold(data){
  clearInterval(countdownTimer);
  signalTitle.textContent = `${data.symbol || '—'} — HOLD / WAIT`;
  signalBody.innerHTML = `<div style="color:#ffd166;font-weight:800">${data.reason || 'Market not optimal — hold'}</div>`;
  signalTimes.textContent = '';
  countdownEl.textContent = '';
}

function showSignal(rec){
  clearInterval(countdownTimer);
  signalTitle.textContent = `${rec.symbol} — ${rec.direction}  (conf ${rec.confidence}%)`;
  const analysis = rec.notes ? `<div class="list"><strong>Notes:</strong> ${rec.notes}</div>` : '';
  signalBody.innerHTML = `<div>Entry price: <span class="confidence">${rec.entry}</span></div>${analysis}`;
  const serverEntryIso = rec.entry_time_iso || (rec.entry_ts ? new Date(rec.entry_ts*1000).toISOString() : null);
  const localEntry = serverEntryIso ? new Date(serverEntryIso).toLocaleString() : '—';
  function toBangladesh(iso){ if(!iso) return '—'; const d = new Date(iso); const bd = new Date(d.getTime() + 6*60*60*1000); return bd.getFullYear() + '-' + String(bd.getMonth()+1).padStart(2,'0') + '-' + String(bd.getDate()).padStart(2,'0') + ' ' + String(bd.getHours()).padStart(2,'0') + ':' + String(bd.getMinutes()).padStart(2,'0') + ':' + String(bd.getSeconds()).padStart(2,'0') + ' (BDT)'; }
  signalTimes.innerHTML = `Server(UTC): ${serverEntryIso || '—'} • Your local: ${localEntry} • Bangladesh: ${toBangladesh(serverEntryIso)}`;

  const nowTs = Math.floor(Date.now()/1000);
  let secs = Math.max(0, (rec.expiry_ts || Math.floor(new Date(rec.expiry_at||rec.expiry).getTime()/1000)) - nowTs);
  countdownEl.textContent = `Countdown: ${secs}s`;
  countdownTimer = setInterval(()=> {
    secs--;
    if(secs <= 0){ clearInterval(countdownTimer); countdownEl.textContent = 'Signal closed — awaiting result'; }
    else countdownEl.textContent = `Countdown: ${secs}s`;
  }, 1000);

  drawGauge(rec.confidence || 0);
  if(rec.symbol) fetchSpark(rec.symbol);
  speak(`Signal ${rec.symbol} ${rec.direction} confidence ${rec.confidence} percent`);
  pushLog(`Signal: ${rec.symbol} ${rec.direction} conf:${rec.confidence}% entry:${rec.entry} time:${serverEntryIso||'—'}`);
}

startBtn.onclick = ()=> {
  if(!currentPair){ pushLog('No pair selected — Auto-Pick'); ws.send(JSON.stringify({ type:'start' })); return; }
  ws.send(JSON.stringify({ type:'start', symbol: currentPair }));
  pushLog('Requested start for ' + currentPair);
};
nextBtn.onclick = ()=> {
  if(!currentPair){ pushLog('No pair selected — Auto-Pick'); ws.send(JSON.stringify({ type:'next' })); return; }
  ws.send(JSON.stringify({ type:'next', symbol: currentPair }));
  pushLog('Requested next for ' + currentPair);
};
autoBtn.onclick = ()=> { ws.send(JSON.stringify({ type:'start' })); pushLog('Requested Auto-Pick Best'); };

ttsBtn.onclick = ()=> { speak('TTS test. Binary sniper ready'); };

function speak(text){
  try{
    const synth = window.speechSynthesis;
    if(!synth) return;
    const u = new SpeechSynthesisUtterance(text);
    synth.cancel();
    synth.speak(u);
  } catch(e){}
}

function drawGauge(val){
  const el = document.getElementById('gauge');
  el.innerHTML = `<div style="padding:20px;font-weight:800;color:#001">${val}%</div>`;
}

async function fetchSpark(symbol){
  try{
    const r = await fetch('/signals/history');
    const j = await r.json();
    const rows = (j.rows || []).filter(x=> x.symbol === symbol).slice(-60);
    if(rows.length === 0) { clearSpark(); return; }
    const prices = rows.map(r=>r.entry).reverse();
    lastSparkData = prices;
    drawSpark(prices);
  }catch(e){ clearSpark(); }
}

function clearSpark(){ ctx.clearRect(0,0,spark.width,spark.height); }

function drawSpark(prices){
  ctx.clearRect(0,0,spark.width,spark.height);
  if(!prices || prices.length===0) return;
  const W = spark.width, H = spark.height;
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = Math.max(1e-6, max - min);
  ctx.beginPath(); ctx.lineWidth = 2; ctx.strokeStyle = '#7af9b8';
  for(let i=0;i<prices.length;i++){
    const x = (i/(prices.length-1)) * W;
    const y = H - ((prices[i]-min)/range) * H;
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();
    }
