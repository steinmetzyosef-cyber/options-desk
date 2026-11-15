// Options Desk bot. Runs on GitHub Actions. PAPER trading only.
// Secrets: ALPACA_KEY, ALPACA_SECRET, NTFY_TOPIC. Variable: AUTO=on to let it place paper trades.
const E=process.env,D="https://data.alpaca.markets/",T="https://paper-api.alpaca.markets/";
const H={"APCA-API-KEY-ID":E.ALPACA_KEY,"APCA-API-SECRET-KEY":E.ALPACA_SECRET,"content-type":"application/json"};
const api=async(u,m="GET",b)=>{const r=await fetch(u,{method:m,headers:H,body:b?JSON.stringify(b):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(String(j.message||r.status));return j};
const UNI="SPY QQQ IWM DIA XLF XLK XLE XLV XLY XLI XLP XLU SMH GLD TLT AAPL MSFT NVDA AMZN GOOGL META TSLA AMD NFLX AVGO CRM ORCL ADBE INTC QCOM MU COST WMT HD LOW NKE MCD SBUX DIS BA CAT DE GE JPM BAC WFC GS MS C V MA PYPL UNH LLY JNJ PFE MRK ABBV XOM CVX COP KO PEP PG T VZ CSCO IBM UBER SHOP PLTR COIN SOFI F GM".split(" ");
const sma=(a,n,e)=>{let s=0;for(let i=e-n;i<e;i++)s+=a[i];return s/n};
const rsi=(a,e,n=14)=>{let g=0,l=0;for(let i=e-n;i<e;i++){const d=a[i]-a[i-1];d>0?g+=d:l-=d}return l?100-100/(1+g/l):100};
const score=(a,e,F,S)=>{const f=sma(a,F,e),s=sma(a,S,e),r=rsi(a,e),m=a[e-1]/a[e-11]-1;let sc=(f>s?1:-1)+(r>55?1:r<45?-1:0)+(m>.004?1:m<-.004?-1:0);if(r>78)sc--;if(r<22)sc++;return{sc,r,m}};
const side=sc=>sc>=2?1:sc<=-2?-1:0;
const days=e=>Math.round((Date.parse(e)-Date.now())/864e5),dt=n=>new Date(Date.now()+n*864e5).toISOString().slice(0,10);
const ymd=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
const occ=s=>{const m=s.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);return m&&{root:m[1],exp:"20"+m[2].slice(0,2)+"-"+m[2].slice(2,4)+"-"+m[2].slice(4),type:m[3],strike:+m[4]/1e3}};
const out=[],say=l=>out.push(l);
const push=async(t,b,p=3)=>{if(!E.NTFY_TOPIC){console.log(t+"\n"+b);return}await fetch("https://ntfy.sh/"+encodeURIComponent(E.NTFY_TOPIC),{method:"POST",headers:{Title:t,Priority:String(p)},body:b})};
async function contract(s,x){const px=x.p,j=await api(`${D}v1beta1/options/snapshots/${s}?feed=indicative&type=${x.sc>0?"call":"put"}&limit=1000&expiration_date_gte=${dt(14)}&expiration_date_lte=${dt(45)}&strike_price_gte=${(px*.97).toFixed(2)}&strike_price_lte=${(px*1.03).toFixed(2)}`);
 const rows=Object.entries(j.snapshots||{}).map(([k,v])=>{const m=occ(k);return m&&{sym:k,...m,bid:v.latestQuote?.bp||0,ask:v.latestQuote?.ap||0,iv:v.impliedVolatility}}).filter(r=>r&&r.ask>0&&r.iv>0&&(r.ask-r.bid)/((r.ask+r.bid)/2)<=.1);
 const ex=[...new Set(rows.map(r=>r.exp))].sort((a,b)=>Math.abs(days(a)-30)-Math.abs(days(b)-30))[0];
 return rows.filter(r=>r.exp===ex).sort((a,b)=>Math.abs(a.strike-px)-Math.abs(b.strike-px))[0]}

const open=(await api(T+"v2/clock")).is_open,force=E.FORCE==="1",auto=E.AUTO==="on";
if(!open&&!force){console.log("Market closed.");process.exit(0)}
const cap=+(await api(T+"v2/account")).equity*.02;
const bars=(await api(`${D}v2/stocks/bars?symbols=${UNI.join(",")}&timeframe=1Day&feed=iex&adjustment=split&limit=10000&start=${new Date(Date.now()-110*864e5).toISOString()}`)).bars||{};
const sig={};for(const s of UNI){const c=(bars[s]||[]).map(b=>b.c);if(c.length>=40)sig[s]={...score(c,c.length,10,30),p:c[c.length-1]}}
const pos=(await api(T+"v2/positions")).filter(p=>p.asset_class==="us_option"),sold=new Set();
for(const p of pos){const m=occ(p.symbol),pl=+p.unrealized_plpc,x=sig[m.root],sd=x?side(x.sc):0;
 const why=pl<=-.4?"stop loss (-40%)":pl>=.6?"take profit (+60%)":days(m.exp)<7?"under 7 days left":(m.type==="C"&&sd<0)||(m.type==="P"&&sd>0)?"signal flipped":"";
 if(!why)continue;const nm=`${m.root} ${m.type==="C"?"call":"put"} ${m.strike} ${m.exp.slice(5)}`,pnl=`P/L about $${(+p.unrealized_pl).toFixed(0)}`;
 if(auto&&open){try{await api(T+"v2/positions/"+p.symbol,"DELETE");sold.add(p.symbol);say(`SOLD (paper) ${nm}: ${why}. ${pnl}.`)}catch(e){say(`SELL ${nm}: ${why}. ${pnl}. Auto-sell failed (${e.message}).`)}}
 else say(`SELL ${nm}: ${why}. ${pnl}.`)}
const ranked=Object.entries(sig).filter(([,x])=>Math.abs(x.sc)>=2).sort((a,b)=>Math.abs(b[1].sc)-Math.abs(a[1].sc)||Math.abs(b[1].m)-Math.abs(a[1].m)).slice(0,6);
const orders=open&&auto?await api(`${T}v2/orders?status=all&limit=100&after=${ymd}T00:00:00Z`):[];
let did=orders.some(o=>String(o.client_order_id).startsWith("bot-"+ymd));
const held=pos.filter(p=>!sold.has(p.symbol)),mine=new Set(held.map(p=>occ(p.symbol).root));let shown=0;
for(const[s,x]of ranked){if(shown>=3)break;let c;try{c=await contract(s,x)}catch(e){continue}if(!c)continue;shown++;
 const risk=c.ask*100,q=Math.floor(cap/risk),hold=Math.max(3,Math.min(15,days(c.exp)-7)),str=Math.round(Math.abs(x.sc)/3*100),nm=`${s} ${x.sc>0?"call":"put"} ${c.strike} ${c.exp.slice(5)}`;
 let line=`BUY ${nm} at about $${c.ask.toFixed(2)} (max loss $${risk.toFixed(0)} per contract). Strength ${str}%. Hold up to about ${hold} days. Sell at +60%, cut at -40%.`;
 if(q<1)line+=" Too big for your 2% risk limit.";
 else if(auto&&open&&!did&&held.length<3&&!mine.has(s)){try{await api(T+"v2/orders","POST",{symbol:c.sym,qty:String(q),side:"buy",type:"limit",limit_price:c.ask.toFixed(2),time_in_force:"day",client_order_id:`bot-${ymd}-${s}`});did=true;line="BOUGHT (paper) "+line.slice(4)}catch(e){line+=` Auto-buy failed (${e.message}).`}}
 say(line)}
if(!out.length&&force)say("Bot is working. No strong signals right now.");
if(force&&!open)say("Market is closed, so no orders were placed.");
if(out.length)await push(`Options Desk${open?"":" (test)"}`,out.join("\n")+"\nPaper trading. Not financial advice.",4);
console.log("done,",out.length,"messages");
