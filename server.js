// server.js — God-Tier final backend (main)
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const compute = require('./computeStrategy');
const aiLearner = require('./aiLearner');
const manipul = require('./manipulationDetector');
const resultResolver = require('./resultResolver');
const quotexAdapter = require('./quotexAdapter');
const sentimentEngine = require('./sentimentEngine');
const strategyManager = require('./strategyManager');
const patternEngine = require('./patternEngine');
const newsFilter = require('./newsFilter');
const riskManager = require('./riskManager');
const optimizer = require('./optimizer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = parseInt(process.env.PORT || '3000', 10);
const SIGNAL_INTERVAL_MS = parseInt(process.env.SIGNAL_INTERVAL_MS || '4500', 10);
const MIN_CONF = parseInt(process.env.MIN_BROADCAST_CONF || '40', 10);
const BINARY_EXPIRY_SECONDS = parseInt(process.env.BINARY_EXPIRY_SECONDS || '60', 10);
const AUTO_PICK = (process.env.AUTO_PICK || 'true') === 'true';
const AUTO_PICK_MIN_SCORE = parseInt(process.env.AUTO_PICK_MIN_SCORE || '45', 10);

const OWNER = process.env.OWNER_NAME || 'Owner';

let PAIRS = (process.env.WATCH_SYMBOLS || '').split(',').map(s=>s.trim()).filter(Boolean);
if(PAIRS.length===0){
  PAIRS = ['EUR/USD','GBP/USD','USD/JPY','AUD/USD','USD/CAD','USD/CHF','NZD/USD','Bitcoin (OTC)','Gold (OTC)'];
}

// expose bars globally for sentimentEngine fallback
global.barsGlobal = {};

const bars = {};       // bars[symbol] = [{time,open,high,low,close,volume},...]
const signals = [];    // persisted in-memory signals
const sessions = {};   // session stats optional

app.use(express.static('public'));

app.get('/pairs', (req,res) => {
  const structured = PAIRS.map(p=>{
    const type = (/\(OTC\)/i.test(p) || /OTC$/i.test(p)) ? 'otc'
               : /(BTC|DOGE|SHIBA|PEPE|ARB|APTOS|TRON|BITCOIN|BINANCE)/i.test(p) ? 'crypto'
               : /(GOLD|SILVER|CRUDE|UKBRENT|USCRUDE)/i.test(p) ? 'commodity'
               : 'real';
    return { symbol: p, type };
  });
  res.json({ ok:true, pairs:structured, owner: OWNER });
});

app.get('/signals/history', (req,res) => res.json({ ok:true, rows: signals.slice(-500).reverse() }));
app.get('/stats', (req,res) => res.json({ ok:true, ai: aiLearner.getState(), sessions: sessions }));

function broadcast(obj){
  const raw = JSON.stringify(obj);
  wss.clients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(raw); });
}

function appendTick(sym, price, qty, tsSec){
  sym = sym.toUpperCase();
  bars[sym] = bars[sym] || [];
  const arr = bars[sym];
  const last = arr[arr.length-1];
  if(!last || last.time !== tsSec){
    arr.push({ time: tsSec, open: price, high: price, low: price, close: price, volume: qty || 1 });
    if(arr.length > 7200) arr.shift();
  } else {
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.volume = (last.volume || 0) + (qty || 0);
  }
  // keep global reference for sentimentEngine fallback
  global.barsGlobal = Object.assign({}, bars);
}

function simulateTick(sym){
  const isCrypto = /BTC|DOGE|SHIBA|PEPE|ARB|APTOS|TRON|BITCOIN|BINANCE/i.test(sym);
  const base = isCrypto ? (Math.random()*200 + 20) : (sym.startsWith('EUR') ? 1.09 : 1.0);
  const noise = (Math.random()-0.5) * (isCrypto ? 2 : 0.003);
  const price = +(base + noise).toFixed(4);
  const qty = Math.random() * (isCrypto ? 2 : 100);
  appendTick(sym, price, qty, Math.floor(Date.now()/1000));
}

function warmup(){
  for(const s of PAIRS){
    bars[s] = bars[s] || [];
    for(let i=0;i<160;i++){
      const ts = Math.floor(Date.now()/1000) - (160 - i);
      const base = s.startsWith('EUR') ? 1.09 : 1.0;
      appendTick(s, +(base + (Math.random()-0.5)*0.005).toFixed(4), Math.random()*100, ts);
    }
  }
}
warmup();

let serverOffsetMs = 0;
async function syncTime(){
  try {
    const r = await fetch('http://worldtimeapi.org/api/timezone/Etc/UTC');
    const j = await r.json();
    const serverMs = (j.unixtime ? j.unixtime*1000 : (new Date(j.datetime)).getTime());
    serverOffsetMs = serverMs - Date.now();
  } catch(e){}
}
setInterval(syncTime, 60_000);
syncTime();

setInterval(()=>{
  try {
    for(const s of Object.keys(bars)){
      const arr = bars[s];
      const cleaned = arr.filter((b,i)=> b && typeof b.close === 'number' && isFinite(b.close) && (i===0 || b.time > arr[i-1].time));
      if(cleaned.length !== arr.length) bars[s] = cleaned;
    }
  } catch(e){}
}, 120000);

resultResolver.start({ signalsRef: signals, barsRef: bars, broadcast });

quotexAdapter.startQuotexAdapter({
  apiUrl: process.env.QUOTEX_API_URL,
  username: process.env.QUOTEX_USERNAME,
  password: process.env.QUOTEX_PASSWORD,
  wsUrl: process.env.QUOTEX_WS_URL
}, {
  appendTick: (sym, price, qty, ts) => appendTick(sym.toUpperCase(), price, qty, ts),
  onOrderConfirm: o => broadcast({ type:'order_confirm', data: o })
}).catch(()=>{/* placeholder safe */});

function scoreAllPairs(){
  const scores=[];
  for(const s of PAIRS){
    try{
      const cand = compute.computeSignalForSymbol(s, bars, { require100:false });
      if(cand) scores.push({ symbol: s, score: cand.confidence, cand });
    }catch(e){}
  }
  scores.sort((a,b)=>b.score - a.score);
  return scores;
}

// main scanner
setInterval(()=>{
  for(const s of PAIRS){
    try{
      if(!bars[s] || bars[s].length < 120){ simulateTick(s); continue; }
      const last100 = bars[s].slice(-120);
      const manip = manipul.detect([], last100);
      if(manip.score > 85) continue;

      const c = compute.computeSignalForSymbol(s, bars, { require100:true });
      if(!c) continue;

      const patterns = patternEngine.detectPatterns(bars[s].slice(-200));
      if(patterns && patterns.length) c.notes = (c.notes||'') + '|' + patterns.join(',');

      const sent = sentimentEngine.getSentiment(s);
      const weighted = strategyManager.applyWeights(c, { sentiment: sent, patterns });

      const risk = await riskManager.computeRisk({ symbol: s, bars: bars[s], manip, sentiment: sent });
      if(risk.riskScore > 65) continue;

      const fv = { fvg: c.notes && c.notes.includes('fvg'), volumeSpike: c.notes && c.notes.includes('volSpike'), manipulation: manip.score>0, bos: c.notes && c.notes.includes('bos')?1:0 };
      const boost = aiLearner.predictBoost ? aiLearner.predictBoost(fv) : 0;
      weighted.confidence = Math.max(1, Math.min(99, Math.round((weighted.confidence || 50) + boost)));

      if(weighted.confidence < MIN_CONF) continue;

      const id = signals.length + 1;
      const expiry_ts = Math.floor(Date.now()/1000) + BINARY_EXPIRY_SECONDS;
      const entry_ts = c.entry_ts || Math.floor(Date.now()/1000);
      const rec = {
        id, symbol: s, market: 'binary', direction: weighted.direction, confidence: weighted.confidence,
        entry: c.entry, entry_ts, entry_time_iso: c.entry_time_iso || new Date(entry_ts*1000).toISOString(),
        expiry_ts, notes: weighted.notes || c.notes || '', time_iso: new Date().toISOString(), server_time_iso: new Date(Date.now()+serverOffsetMs).toISOString(), result: null
      };
      signals.push(rec);
      broadcast({ type:'signal', data: rec });
      broadcast({ type:'log', data:`Signal ${rec.symbol} ${rec.direction} conf:${rec.confidence}% id:${rec.id}` });
    } catch(e){
      console.warn('scanner err', e && e.message ? e.message : e);
    }
  }
}, SIGNAL_INTERVAL_MS);

// WebSocket handlers
wss.on('connection', ws => {
  const structured = PAIRS.map(p=>{
    const t = (/\(OTC\)/i.test(p) || /OTC$/i.test(p)) ? 'otc'
            : /(BTC|DOGE|SHIBA|PEPE|ARB|APTOS|TRON|BITCOIN|BINANCE)/i.test(p) ? 'crypto'
            : /(GOLD|SILVER|CRUDE|UKBRENT|USCRUDE)/i.test(p) ? 'commodity'
            : 'real';
    return { symbol: p, type: t };
  });
  ws.send(JSON.stringify({ type:'hello', server_time: new Date(Date.now()+serverOffsetMs).toISOString(), pairs: structured, owner: OWNER }));

  ws.on('message', async msg => {
    try{
      const m = JSON.parse(msg.toString());
      if(m.type === 'start' || m.type === 'next'){
        let sym = (m.symbol||'').toString().trim();
        if(!sym && AUTO_PICK){
          const best = scoreAllPairs()[0];
          if(best && best.score >= AUTO_PICK_MIN_SCORE) sym = best.symbol;
        }
        if(!sym){
          ws.send(JSON.stringify({ type:'hold', data:{ reason:'No pairs available or no suitable auto-pick' } }));
          return;
        }
        let sig = compute.computeSignalForSymbol(sym, bars, { require100:true, forceNext: m.type==='next' });
        if(!sig) sig = compute.computeSignalForSymbol(sym, bars, { require100:false, forceNext: m.type==='next' });
        if(!sig){
          ws.send(JSON.stringify({ type:'hold', data:{ symbol: sym, reason:'No confirmed opportunity now — hold' } }));
          return;
        }
        const patterns = patternEngine.detectPatterns(bars[sym] ? bars[sym].slice(-200) : []);
        if(patterns && patterns.length) sig.notes = (sig.notes||'') + '|' + patterns.join(',');
        const sent = sentimentEngine.getSentiment(sym);
        const weighted = strategyManager.applyWeights(sig, { sentiment: sent, patterns });
        const manip = manipul.detect([], bars[sym] ? bars[sym].slice(-120) : []);
        const risk = await riskManager.computeRisk({ symbol: sym, bars: bars[sym]||[], manip, sentiment: sent });
        if(risk.riskScore > 65){ ws.send(JSON.stringify({ type:'hold', data:{ symbol: sym, reason:'Risk high (news/manip). Hold' } })); return; }
        const fv = { fvg: sig.notes && sig.notes.includes('fvg'), volumeSpike: sig.notes && sig.notes.includes('volSpike'), manipulation: manip.score>0, bos: sig.notes && sig.notes.includes('bos')?1:0 };
        const boost = aiLearner.predictBoost ? aiLearner.predictBoost(fv) : 0;
        weighted.confidence = Math.max(1, Math.min(99, Math.round((weighted.confidence || 50) + boost)));
        if(weighted.confidence < MIN_CONF) { ws.send(JSON.stringify({ type:'hold', data:{ symbol: sym, reason:'Confidence too low' } })); return; }

        const id = signals.length + 1;
        const expiry_ts = Math.floor(Date.now()/1000) + BINARY_EXPIRY_SECONDS;
        const entry_ts = sig.entry_ts || Math.floor(Date.now()/1000);
        const rec = {
          id, symbol: sig.symbol || sym, market: sig.market || 'binary', direction: weighted.direction, confidence: weighted.confidence,
          entry: sig.entry, entry_ts, entry_time_iso: sig.entry_time_iso || new Date(entry_ts*1000).toISOString(),
          expiry_ts, notes: weighted.notes || sig.notes || '', time_iso: new Date().toISOString(), server_time_iso: new Date(Date.now()+serverOffsetMs).toISOString(), result: null
        };
        signals.push(rec);
        ws.send(JSON.stringify({ type:'signal', data: rec }));
        broadcast({ type:'log', data:`User requested ${m.type} -> ${rec.symbol} id:${rec.id}` });
      } else if(m.type === 'execTrade'){
        const { pair, direction, amount } = m;
        try{
          const res = await quotexAdapter.placeTrade(pair, direction, amount, 1);
          ws.send(JSON.stringify({ type:'execResult', data: res }));
        }catch(e){
          ws.send(JSON.stringify({ type:'execError', data: e.message || e }));
        }
      } else if(m.type === 'getScores'){
        ws.send(JSON.stringify({ type:'scores', data: scoreAllPairs().slice(0,10) }));
      }
    }catch(e){}
  });
});

server.listen(PORT, ()=> {
  console.log(`Binary Sniper God listening ${PORT} pairs:${PAIRS.length}`);
  console.log('Pairs:', PAIRS.join(', '));
  optimizer.start({ signalsRef: signals, ai: aiLearner });
});
