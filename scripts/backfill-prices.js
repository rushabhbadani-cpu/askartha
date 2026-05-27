// scripts/backfill-prices.js
// Downloads full NSE Bhavcopy history → data/prices/{SYM}.json
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const NSE_HEADERS={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36','Accept':'*/*','Referer':'https://www.nseindia.com/'};
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function fmtISO(d){return d.toISOString().split('T')[0];}
function padZ(n){return String(n).padStart(2,'0');}
function isWeekend(d){return d.getDay()===0||d.getDay()===6;}
function ensureDir(d){if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true});}

function nseUrls(date){
  const yyyy=date.getFullYear(),mm=padZ(date.getMonth()+1),dd=padZ(date.getDate());
  const mon=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][date.getMonth()];
  return[`https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${yyyy}${mm}${dd}_F_0000.csv.zip`,`https://nsearchives.nseindia.com/archives/cm/bhav/cm${dd}${mon}${yyyy}bhav.csv.zip`];
}

async function fetchZip(url){
  try{
    const r=await fetch(url,{headers:NSE_HEADERS,signal:AbortSignal.timeout(30000)});
    if(!r.ok)return null;
    const buf=Buffer.from(await r.arrayBuffer());
    if(buf.length<500)return null;
    if(buf.slice(0,4).toString('ascii').startsWith('<'))return null;
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
  const startYear=parseInt(process.env.START_YEAR||'2020');
  const endYear=parseInt(process.env.END_YEAR||new Date().getFullYear());
  const forceRestart=process.env.FORCE_RESTART==='true';
  console.log(`🚀 AskArtha Backfill — ${startYear}→${endYear}`);
  const PRICES_DIR=path.join(process.cwd(),'data','prices');
  ensureDir(PRICES_DIR);
  const allData={};
  if(fs.existsSync(PRICES_DIR)&&!forceRestart){
    const files=fs.readdirSync(PRICES_DIR).filter(f=>f.endsWith('.json')&&f!=='_meta.json');
    for(const file of files){const sym=file.replace('.json','');try{const d=JSON.parse(fs.readFileSync(path.join(PRICES_DIR,file),'utf8'));allData[sym]=d.candles||[];}catch{allData[sym]=[];}}
    console.log(`Loaded ${Object.keys(allData).length} existing symbols`);
  }
  const existingDates={};
  for(const[sym,candles]of Object.entries(allData))existingDates[sym]=new Set(candles.map(c=>c.date));
  let cursor=new Date(startYear,0,3);
  const today=new Date();
  const finalDate=new Date(endYear,11,31)<today?new Date(endYear,11,31):today;
  let currentMonth='',monthBuffer={};
  console.log(`From: ${fmtISO(cursor)} → ${fmtISO(finalDate)}\n`);
  while(cursor<=finalDate){
    if(!isWeekend(cursor)){
      const dateStr=fmtISO(cursor);
      const month=dateStr.slice(0,7);
      if(month!==currentMonth){
        if(currentMonth&&Object.keys(monthBuffer).length>0){
          let written=0;
          for(const[sym,newCandles]of Object.entries(monthBuffer)){
            if(!allData[sym])allData[sym]=[];
            if(!existingDates[sym])existingDates[sym]=new Set();
            for(const c of newCandles){if(!existingDates[sym].has(c.date)){allData[sym].push(c);existingDates[sym].add(c.date);}}
            allData[sym].sort((a,b)=>a.date.localeCompare(b.date));
            fs.writeFileSync(path.join(PRICES_DIR,`${sym}.json`),JSON.stringify({symbol:sym,candles:allData[sym],lastUpdated:new Date().toISOString()}));
            written++;
          }
          process.stdout.write(` [${written}]\n`);
          monthBuffer={};
        }
        currentMonth=month;
        process.stdout.write(`📅 ${month}: `);
      }
      let csv=null;
      for(const url of nseUrls(cursor)){csv=await fetchZip(url);if(csv)break;await sleep(200);}
      if(csv){
        const rows=parseNSE(csv,dateStr);
        if(rows.length>100){for(const row of rows){if(!monthBuffer[row.sym])monthBuffer[row.sym]=[];monthBuffer[row.sym].push({date:row.date,open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume});}process.stdout.write('N');}
        else process.stdout.write('n');
      }else process.stdout.write('n');
    }
    cursor.setDate(cursor.getDate()+1);
    await sleep(150);
  }
  if(Object.keys(monthBuffer).length>0){
    let written=0;
    for(const[sym,newCandles]of Object.entries(monthBuffer)){
      if(!allData[sym])allData[sym]=[];if(!existingDates[sym])existingDates[sym]=new Set();
      for(const c of newCandles){if(!existingDates[sym].has(c.date)){allData[sym].push(c);existingDates[sym].add(c.date);}}
      allData[sym].sort((a,b)=>a.date.localeCompare(b.date));
      fs.writeFileSync(path.join(PRICES_DIR,`${sym}.json`),JSON.stringify({symbol:sym,candles:allData[sym],lastUpdated:new Date().toISOString()}));
      written++;
    }
    process.stdout.write(` [${written}]\n`);
  }
  fs.writeFileSync(path.join(PRICES_DIR,'_meta.json'),JSON.stringify({range:`${startYear}→${endYear}`,totalSymbols:Object.keys(allData).length,updatedAt:new Date().toISOString(),source:'NSE Bhavcopy Archive'},null,2));
  console.log(`\n✅ BACKFILL COMPLETE — ${Object.keys(allData).length} symbols`);
}
main().catch(e=>{console.error('Fatal:',e.message);process.exit(1);});
