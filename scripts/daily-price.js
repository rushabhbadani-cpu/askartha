// scripts/daily-prices.js
// Downloads NSE Bhavcopy daily → appends to data/prices/{SYM}.json
// GitHub Actions commits the files automatically
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const NSE_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept':'*/*','Referer':'https://www.nseindia.com/','Connection':'keep-alive',
};
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function fmtISO(d){return d.toISOString().split('T')[0];}
function isWeekend(d){return d.getDay()===0||d.getDay()===6;}
function padZ(n){return String(n).padStart(2,'0');}
function ensureDir(d){if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true});}

function nseUrls(date){
  const yyyy=date.getFullYear(),mm=padZ(date.getMonth()+1),dd=padZ(date.getDate());
  const mon=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][date.getMonth()];
  return[
    `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${yyyy}${mm}${dd}_F_0000.csv.zip`,
    `https://nsearchives.nseindia.com/archives/cm/bhav/cm${dd}${mon}${yyyy}bhav.csv.zip`,
  ];
}

async function fetchZip(url){
  try{
    const r=await fetch(url,{headers:NSE_HEADERS,signal:AbortSignal.timeout(30000)});
    if(!r.ok)return null;
    const buf=Buffer.from(await r.arrayBuffer());
    if(buf.length<500)return null;
    const start=buf.slice(0,4).toString('ascii');
    if(start.startsWith('<!')||start.startsWith('<h'))return null;
    const zip=new AdmZip(buf);
    const entry=zip.getEntries()[0];
    return entry?entry.getData().toString('utf8'):null;
  }catch{return null;}
}

function parseNSE(csv,dateStr){
  const lines=csv.trim().split('\n');
  if(lines.length<2)return[];
  const h=lines[0].split(',').map(x=>x.trim().replace(/"/g,''));
  const gi=(...n)=>{for(const x of n){const i=h.indexOf(x);if(i!==-1)return i;}return -1;};
  const idx={sym:gi('TckrSymb','SYMBOL'),series:gi('SctySrs','SERIES'),open:gi('OpnPric','OPEN'),high:gi('HghPric','HIGH'),low:gi('LwPric','LOW'),close:gi('ClsPric','CLOSE'),volume:gi('TtlTradgVol','TOTTRDQTY')};
  const EXCLUDE=new Set(['N1','N2','N3','N4','N5','N6','N7','N8','N9','IV','CB','NB']);
  const out=[];
  for(let i=1;i<lines.length;i++){
    const c=lines[i].split(',').map(x=>x.trim().replace(/"/g,''));
    if(c.length<5)continue;
    const series=idx.series>=0?c[idx.series]:'EQ';
    if(EXCLUDE.has(series))continue;
    const sym=idx.sym>=0?c[idx.sym]:'';
    const close=parseFloat(idx.close>=0?c[idx.close]:0);
    if(!sym||close<=0)continue;
    out.push({sym,date:dateStr,open:parseFloat(idx.open>=0?c[idx.open]:close),high:parseFloat(idx.high>=0?c[idx.high]:close),low:parseFloat(idx.low>=0?c[idx.low]:close),close,volume:parseInt(idx.volume>=0?c[idx.volume]:0)});
  }
  return out;
}

async function main(){
  console.log('🚀 AskArtha Daily Prices — NSE Bhavcopy → GitHub Files');
  const PRICES_DIR=path.join(process.cwd(),'data','prices');
  ensureDir(PRICES_DIR);
  const now=new Date();
  const ist=new Date(now.getTime()+5.5*60*60*1000);
  let targetDate=new Date(ist.toISOString().split('T')[0]);
  let csv=null,dateStr='';
  for(let daysBack=0;daysBack<=4;daysBack++){
    const date=new Date(targetDate);
    date.setDate(date.getDate()-daysBack);
    if(isWeekend(date))continue;
    dateStr=fmtISO(date);
    const sampleFile=path.join(PRICES_DIR,'TCS.json');
    if(fs.existsSync(sampleFile)&&process.env.FORCE_DOWNLOAD!=='true'){
      const sample=JSON.parse(fs.readFileSync(sampleFile,'utf8'));
      if(sample.candles?.length&&sample.candles[sample.candles.length-1].date===dateStr){
        console.log(`✅ Already have ${dateStr} — skipping`);process.exit(0);
      }
    }
    for(const url of nseUrls(date)){
      csv=await fetchZip(url);
      if(csv)break;
    }
    if(csv)break;
  }
  if(!csv){console.log('❌ No Bhavcopy data found');process.exit(0);}
  const rows=parseNSE(csv,dateStr);
  console.log(`📊 ${rows.length} stocks for ${dateStr}`);
  const bySymbol={};
  for(const row of rows)bySymbol[row.sym]={date:row.date,open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume};
  let updated=0;
  for(const [sym,candle] of Object.entries(bySymbol)){
    const file=path.join(PRICES_DIR,`${sym}.json`);
    let data={symbol:sym,candles:[]};
    if(fs.existsSync(file)){try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}}
    data.candles=(data.candles||[]).filter(c=>c.date!==candle.date);
    data.candles.push(candle);
    data.candles.sort((a,b)=>a.date.localeCompare(b.date));
    data.lastUpdated=new Date().toISOString();
    fs.writeFileSync(file,JSON.stringify(data));
    updated++;
  }
  fs.writeFileSync(path.join(PRICES_DIR,'_meta.json'),JSON.stringify({lastDate:dateStr,totalSymbols:updated,updatedAt:new Date().toISOString(),source:'NSE Bhavcopy'},null,2));
  console.log(`✅ ${updated} files updated for ${dateStr}`);
}
main().catch(e=>{console.error('Fatal:',e.message);process.exit(1);});
