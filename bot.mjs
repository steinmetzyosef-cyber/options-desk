// Options Desk bot v2. Runs on GitHub Actions. PAPER trading only (paper endpoint is hard-coded).
import fs from "node:fs";
const E=process.env,D="https://data.alpaca.markets/",T="https://paper-api.alpaca.markets/";
const CFG={RISK_PCT:.02,BP_USE:.5,MAX_QTY:5,MAX_OPEN:3,DAILY_LOSS:.03,MIN_VOL:20,MIN_OI:500,MAX_SPREAD:.10,DTE:30,CLOSE_DTE:5,TP:.5,SL:-.5,FEE:.65,STEPS:4,WAIT:20,MAX_SLIP:.4,EARN_DAYS:45,IV_MIN_DAYS:20,IVR_MAX:60,MIN_RR:.7};
const EVENTS=["2026-12-09"]; // FOMC decision days. Edit by hand; check federalreserve.gov. Entries pause that day and the day before.
const H={"APCA-API-KEY-ID":E.ALPACA_KEY,"APCA-API-SECRET-KEY":E.ALPACA_SECRET,"content-type":"application/json"},POLL=+E.POLL_MS||5000;
const api=async(u,m="GET",b)=>{const r=await fetch(u,{method:m,headers:H,body:b?JSON.stringify(b):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(String(j.message||r.status));return j};
const UNI="SPY QQQ IWM DIA XLF XLK XLE XLV XLY XLI XLP XLU SMH GLD TLT AAPL MSFT NVDA AMZN GOOGL META TSLA AMD NFLX AVGO CRM ORCL ADBE INTC QCOM MU COST WMT HD LOW NKE MCD SBUX DIS BA CAT DE GE JPM BAC WFC GS MS C V MA PYPL UNH LLY JNJ PFE MRK ABBV XOM CVX COP KO PEP PG T VZ CSCO IBM UBER SHOP PLTR COIN SOFI F GM".split(" ");
const ETF=new Set("SPY QQQ IWM DIA XLF XLK XLE XLV XLY XLI XLP XLU SMH GLD TLT".split(" "));
const sma=(a,n,e)=>{let s=0;for(let i=e-n;i<e;i++)s+=a[i];return s/n};
const rsi=(a,e,n=14)=>{let g=0,l=0;for(let i=e-n;i<e;i++){const d=a[i]-a[i-1];d>0?g+=d:l-=d}return l?100-100/(1+g/l):100};
const score=(a,e,F,S)=>{const f=sma(a,F,e),s=sma(a,S,e),r=rsi(a,e),m=a[e-1]/a[e-11]-1;let sc=(f>s?1:-1)+(r>55?1:r<45?-1:0)+(m>.004?1:m<-.004?-1:0);if(r>78)sc--;if(r<22)sc++;return{sc,r,m}};
const side=sc=>sc>=2?1:sc<=-2?-1:0,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const days=e=>Math.round((Date.parse(e)-Date.now())/864e5),dt=n=>new Date(Date.now()+n*864e5).toISOString().slice(0,10);
const ymd=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"}),tmw=new Date(Date.parse(ymd)+864e5).toISOString().slice(0,10);
const occ=s=>{const m=s.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);return m&&{root:m[1],exp:"20"+m[2].slice(0,2)+"-"+m[2].slice(2,4)+"-"+m[2].slice(4),type:m[3],strike:+m[4]/1e3}};
const out=[],skips=[],say=l=>out.push(l),usd=x=>(x<0?"-$":"$")+Math.abs(x).toFixed(0);
let IVH={};try{IVH=JSON.parse(fs.readFileSync("data/iv.json","utf8"))}catch{}
const ivr=(s,iv)=>{const h=Object.values(IVH[s]||{});if(h.length<CFG.IV_MIN_DAYS)return{n:h.length};const lo=Math.min(...h),hi=Math.max(...h);return{n:h.length,rank:hi>lo?(iv-lo)/(hi-lo)*100:50,pct:h.filter(v=>v<iv).length/h.length*100}};
const open=(await api(T+"v2/clock")).is_open,force=E.FORCE==="1",live=open&&E.AUTO==="on";
async function finish(head){fs.mkdirSync("data",{recursive:true});for(const s in IVH)for(const d of Object.keys(IVH[s]).sort().slice(0,-260))delete IVH[s][d];fs.writeFileSync("data/iv.json",JSON.stringify(IVH));
 if(skips.length)say("Skipped: "+skips.slice(0,4).join("; ")+".");if(force&&!open)say("Market is closed, so no orders were placed.");if(!out.length&&force)say("Bot is working. No strong signals right now.");
 if(out.length){const body=head+"\n"+out.join("\n")+"\nPaper trading. Not financial advice.";if(E.NTFY_TOPIC)await fetch("https://ntfy.sh/"+encodeURIComponent(E.NTFY_TOPIC),{method:"POST",headers:{Title:"Options Desk"+(open?"":" (test)"),Priority:"4"},body});else console.log(body)}
 console.log("done,",out.length,"messages");process.exit(0)}
if(!open&&!force){console.log("Market closed.");process.exit(0)}
const ac=await api(T+"v2/account"),eq=+ac.equity,last=+ac.last_equity||eq,bp=+(ac.options_buying_power??ac.buying_power),dayPL=eq/last-1;
const head=`Account ${usd(eq)} (${(dayPL*100).toFixed(1)}% today).`;
if(dayPL<=-CFG.DAILY_LOSS){say(`KILL SWITCH: account is down ${(dayPL*100).toFixed(1)}% today. No new trades.`);if(live){try{await api(T+"v2/positions?cancel_orders=true","DELETE");say("All positions closed.")}catch(e){say("Close-all failed: "+e.message)}}await finish(head)}

async function walk(legs,qty,mid,nat,debit,tag,maxFrac,market){
 const rd=(v,t)=>Math.max(.01,Math.round(v/t)*t);
 for(let i=0;i<CFG.STEPS;i++){const f=maxFrac*i/(CFG.STEPS-1),p=debit?mid+(nat-mid)*f:mid-(mid-nat)*f;let o;
  for(const t of[.01,.05]){try{o=await api(T+"v2/orders","POST",{order_class:"mleg",qty:String(qty),type:"limit",limit_price:((debit?1:-1)*rd(p,t)).toFixed(2),time_in_force:"day",legs,client_order_id:`bot-${ymd}-${tag}-${i}`});break}catch(e){if(t===.05||!/tick|increment|price/i.test(e.message))throw e}}
  for(let w=0;w<CFG.WAIT;w+=5){await sleep(POLL);o=await api(T+"v2/orders/"+o.id);if(o.status==="filled")return{ok:true,price:+o.filled_avg_price||p};if(["canceled","expired","rejected"].includes(o.status))break}
  if(o.status!=="filled"){try{await api(T+"v2/orders/"+o.id,"DELETE")}catch{}await sleep(POLL/3);o=await api(T+"v2/orders/"+o.id);if(+o.filled_qty>0)return{ok:true,price:+o.filled_avg_price||p}}}
 if(market){await api(T+"v2/orders","POST",{order_class:"mleg",qty:String(qty),type:"market",time_in_force:"day",legs,client_order_id:`bot-${ymd}-${tag}-mkt`});return{ok:true,market:true}}
 return{ok:false}}
async function exitGroup(g){const syms=g.ps.map(p=>p.symbol);
 if(syms.length<2){await api(T+"v2/positions/"+syms[0],"DELETE");return{ok:true}}
 const sn=(await api(`${D}v1beta1/options/snapshots?feed=indicative&symbols=${syms.join(",")}`)).snapshots||{};let mid=0,nat=0;
 const legs=g.ps.map(p=>{const sh=p.side==="short"||+p.qty<0,q=sn[p.symbol]?.latestQuote||{},bid=q.bp||0,ask=q.ap||0;mid+=(sh?-1:1)*(bid+ask)/2;nat+=(sh?-ask:bid);
  return{symbol:p.symbol,ratio_qty:"1",side:sh?"buy":"sell",position_intent:sh?"buy_to_close":"sell_to_close"}});
 const qty=Math.min(...g.ps.map(p=>Math.abs(+p.qty)));return walk(legs,qty,Math.abs(mid),Math.abs(nat),mid<0,"x-"+g.m.root,1,true)}
async function build(s,x){const px=x.p,up=x.sc>0,type=up?"call":"put",f=`type=${type}&expiration_date_gte=${dt(CFG.DTE-9)}&expiration_date_lte=${dt(CFG.DTE+15)}&strike_price_gte=${(px*.95).toFixed(2)}&strike_price_lte=${(px*1.05).toFixed(2)}`;
 const[cj,sj]=await Promise.all([api(`${T}v2/options/contracts?underlying_symbols=${s}&${f}&limit=1000`),api(`${D}v1beta1/options/snapshots/${s}?feed=indicative&${f}&limit=1000`)]);
 const oi={};for(const c of cj.option_contracts||[])oi[c.symbol]=+c.open_interest||0;
 const rows=Object.entries(sj.snapshots||{}).map(([k,v])=>{const m=occ(k),q=v.latestQuote||{},bid=q.bp||0,ask=q.ap||0,mid=(bid+ask)/2,g=v.greeks||{};return m&&{sym:k,...m,bid,ask,mid,spr:mid?(ask-bid)/mid:9,iv:v.impliedVolatility||0,d:g.delta||0,g:g.gamma||0,t:g.theta||0,v:g.vega||0,vol:v.dailyBar?.v??v.prevDailyBar?.v??0,oi:oi[k]||0}}).filter(r=>r&&r.bid>0&&r.ask>0&&r.iv>0);
 const good=r=>r.spr<=CFG.MAX_SPREAD&&r.oi>=CFG.MIN_OI&&r.vol>=CFG.MIN_VOL,G=rows.filter(good);
 const ex=[...new Set(G.map(r=>r.exp))].sort((a,b)=>Math.abs(days(a)-CFG.DTE)-Math.abs(days(b)-CFG.DTE))[0];
 if(!ex)return{why:`no contracts pass the liquidity filters (${rows.length} checked)`};
 const L=G.filter(r=>r.exp===ex),long=[...L].sort((a,b)=>Math.abs(a.strike-px)-Math.abs(b.strike-px))[0];
 const cand=L.filter(r=>up?r.strike>long.strike:r.strike<long.strike).sort((a,b)=>Math.abs(a.strike-long.strike)-Math.abs(b.strike-long.strike)),short=cand[1]||cand[0];
 if(!short)return{why:"no liquid short leg"};
 const mid=long.mid-short.mid,nat=long.ask-short.bid,width=Math.abs(long.strike-short.strike);
 if(!(mid>0&&nat<width))return{why:"spread is not priced sensibly"};
 const rr=(width-mid)/mid;if(rr<CFG.MIN_RR)return{why:`reward/risk ${rr.toFixed(2)} is too low`};
 return{type,ex,dte:days(ex),long,short,mid,nat,width,iv:long.iv,gr:{d:long.d-short.d,g:long.g-short.g,t:long.t-short.t,v:long.v-short.v}}}
const bars=(await api(`${D}v2/stocks/bars?symbols=${UNI.join(",")}&timeframe=1Day&feed=iex&adjustment=split&limit=10000&start=${new Date(Date.now()-110*864e5).toISOString()}`)).bars||{};
const sig={};for(const s of UNI){const c=(bars[s]||[]).map(b=>b.c);if(c.length>=40)sig[s]={...score(c,c.length,10,30),p:c[c.length-1]}}
const pos=(await api(T+"v2/positions")).filter(p=>p.asset_class==="us_option"),Gp={};
for(const p of pos){const m=occ(p.symbol);(Gp[m.root+m.exp+m.type]??={m,ps:[]}).ps.push(p)}
const rolled=new Set(),gone=new Set();
for(const g of Object.values(Gp)){const m=g.m,x=sig[m.root],sd=x?side(x.sc):0,dte=days(m.exp),cost=g.ps.reduce((s,p)=>s+ +p.cost_basis,0),pl=g.ps.reduce((s,p)=>s+ +p.unrealized_pl,0),pc=cost?pl/Math.abs(cost):0;
 const sITM=g.ps.some(p=>(p.side==="short"||+p.qty<0)&&x&&((m.type==="C"&&x.p>occ(p.symbol).strike)||(m.type==="P"&&x.p<occ(p.symbol).strike)));
 const why=pc>=CFG.TP?"profit target":pc<=CFG.SL?"stop loss":dte<=CFG.CLOSE_DTE?"expiry close, avoids assignment":sITM&&dte<=7?"short leg in the money near expiry":(m.type==="C"&&sd<0)||(m.type==="P"&&sd>0)?"signal flipped":"";
 if(!why)continue;const st=g.ps.map(p=>occ(p.symbol).strike).sort((a,b)=>a-b).join("/"),nm=`${m.root} ${m.type==="C"?"call":"put"}${g.ps.length>1?" spread":""} ${st} ${m.exp.slice(5)}`,pnl=`P/L about ${usd(pl)}`;
 if(live){try{const r=await exitGroup(g);if(r.ok){gone.add(g);say(`SOLD (paper) ${nm}: ${why}. ${pnl}.`);if(why.startsWith("expiry")&&((m.type==="C"&&sd>0)||(m.type==="P"&&sd<0)))rolled.add(m.root)}else say(`SELL ${nm}: ${why}. ${pnl}. Exit did not fill.`)}catch(e){say(`SELL ${nm}: ${why}. ${pnl}. Auto-sell failed (${e.message}).`)}}
 else say(`SELL ${nm}: ${why}. ${pnl}.`)}
const held=Object.values(Gp).filter(g=>!gone.has(g)),mine=new Set(held.map(g=>g.m.root));
const blackout=EVENTS.includes(ymd)||EVENTS.includes(tmw)?"FOMC day":(new Date(ymd).getUTCDay()===5&&+ymd.slice(8)<=7)?"jobs report day":"";
let earn=new Map();if(E.FINNHUB_KEY){try{const j=await(await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${dt(0)}&to=${dt(CFG.EARN_DAYS)}&token=${E.FINNHUB_KEY}`)).json();for(const r of j.earningsCalendar||[])if(!earn.has(r.symbol)||r.date<earn.get(r.symbol))earn.set(r.symbol,r.date)}catch{say("Earnings calendar unavailable, trading ETFs only.");E.FINNHUB_KEY=""}}
const ranked=Object.entries(sig).filter(([,x])=>Math.abs(x.sc)>=2).sort((a,b)=>Math.abs(b[1].sc)-Math.abs(a[1].sc)||Math.abs(b[1].m)-Math.abs(a[1].m)).sort((a,b)=>rolled.has(b[0])-rolled.has(a[0])).slice(0,6);
const orders=live?await api(`${T}v2/orders?status=all&limit=100&after=${ymd}T00:00:00Z`):[];
let did=orders.some(o=>String(o.client_order_id).startsWith("bot-"+ymd)&&!String(o.client_order_id).includes("-x-")&&+o.filled_qty>0),shown=0;
if(blackout)say(`No new trades today: ${blackout}.`);
else for(const[s,x]of ranked){if(shown>=3)break;if(mine.has(s)&&!rolled.has(s))continue;
 if(!ETF.has(s)&&!E.FINNHUB_KEY){skips.push(`${s} (add FINNHUB_KEY to check earnings)`);continue}
 let sp;try{sp=await build(s,x)}catch(e){skips.push(`${s} (${e.message})`);continue}
 if(sp.why){skips.push(`${s} (${sp.why})`);continue}
 const iv=ivr(s,sp.iv);(IVH[s]??={})[ymd]=sp.iv;const ed=earn.get(s);
 if(ed&&ed<=sp.ex){skips.push(`${s} (earnings ${ed.slice(5)} before expiry)`);continue}
 if(iv.rank!==undefined&&iv.rank>CFG.IVR_MAX){skips.push(`${s} (IV rank ${iv.rank.toFixed(0)} is high)`);continue}
 const budget=Math.min(eq*CFG.RISK_PCT,bp*CFG.BP_USE),per=sp.nat*100+4*CFG.FEE,q=Math.min(CFG.MAX_QTY,Math.floor(budget/per));
 if(q<1){skips.push(`${s} (one spread risks ${usd(per)}, your limit is ${usd(budget)})`);continue}
 shown++;const str=Math.round(Math.abs(x.sc)/3*100),up=sp.type==="call",R=rolled.has(s);
 let line=`${R?"ROLL":"BUY"} ${s} ${up?"bull call":"bear put"} spread ${sp.long.strike}/${sp.short.strike} ${sp.ex.slice(5)} x${q} at about $${sp.mid.toFixed(2)} net debit. Max loss up to ${usd(sp.nat*100*q)}, max gain about ${usd((sp.width-sp.mid)*100*q)}. Strength ${str}%. Greeks: delta ${sp.gr.d.toFixed(2)}, gamma ${sp.gr.g.toFixed(3)}, theta ${sp.gr.t.toFixed(2)}/day, vega ${sp.gr.v.toFixed(2)}. IV ${(sp.iv*100).toFixed(0)}% (${iv.rank!==undefined?"rank "+iv.rank.toFixed(0)+", pct "+iv.pct.toFixed(0):"rank building "+iv.n+"/"+CFG.IV_MIN_DAYS+" days"}). Exits: +50%, -50%, or ${CFG.CLOSE_DTE} days before expiry.`;
 if(live&&(!did||R)&&held.length<CFG.MAX_OPEN){try{const legs=[{symbol:sp.long.sym,ratio_qty:"1",side:"buy",position_intent:"buy_to_open"},{symbol:sp.short.sym,ratio_qty:"1",side:"sell",position_intent:"sell_to_open"}];
  const r=await walk(legs,q,sp.mid,sp.nat,true,s,CFG.MAX_SLIP,false);if(r.ok){did=true;held.push({m:{root:s}});line=(R?"ROLLED":"BOUGHT")+" (paper) "+line.slice(R?5:4)+` Filled at about $${(+r.price).toFixed(2)}.`}else line+=" Order did not fill within the price limit, so it was cancelled."}catch(e){line+=` Auto-buy failed (${e.message}).`}}
 say(line)}
await finish(head);
