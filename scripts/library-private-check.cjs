// One-off verification. Private data exists only in process/browser memory, never logs or artifacts.
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {chromium} = require('/tmp/library-browser-check/node_modules/playwright');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
let stage='starting',audit=[];
const pause = ms => new Promise(r=>setTimeout(r,ms));
const base = 'https://contact-capture.matthias-homan.workers.dev';
const backups = 'c0e7a3f504ad45c0bc3d346ba89af2a1';
async function notion(path,body){
  for(let i=0;i<3;i++){
    const r=await fetch('https://api.notion.com/v1'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+process.env.NOTION_TOKEN,'Notion-Version':'2022-06-28','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
    if(r.status===429||r.status===529){await pause(Math.max(1,Number(r.headers.get('retry-after'))||60)*1000);continue;}
    if(!r.ok)throw Error('Private source request failed with HTTP '+r.status);
    return r.json();
  }
  throw Error('Private source remained rate limited.');
}
async function blocks(id){let out=[],cursor='';do{const p=await notion('/blocks/'+id+'/children?page_size=100'+(cursor?'&start_cursor='+encodeURIComponent(cursor):''));out.push(...p.results);cursor=p.has_more?p.next_cursor:'';}while(cursor);return out;}
(async()=>{
  const source=await notion('/databases/'+backups+'/query',{filter:{property:'App',title:{equals:'Library verification source 2026-11-18'}},page_size:10});
  assert.equal(source.results.length,1,'Private source must be unique');
  stage='reading-private-source';const sourceBlocks=await blocks(source.results[0].id);
  const packed=sourceBlocks.map(b=>(b[b.type]?.rich_text||[]).map(x=>x.plain_text??x.text?.content??'').join('')).join('');
  assert.equal(sha(packed),'3de1636ed177822f05c7a20ec24df0b594e923b600b072f3a505e4260f8ac5a8','Private source integrity failed');
  const object=JSON.parse(zlib.gunzipSync(Buffer.from(packed.slice(3),'base64')).toString());
  assert.equal(object.books.length,314);
  stage='private-source-verified';const cursorProbe=await notion('/databases/41ce528fadf881bcab50cfd5b8a27903/query',{page_size:100});console.log(JSON.stringify({opaqueCursorLength:cursorProbe.next_cursor?.length||0,oldCursorRestrictionWouldReject:!!cursorProbe.next_cursor&&!/^[a-zA-Z0-9-]{1,100}$/.test(cursorProbe.next_cursor)}));const oldId='415e528f-adf8-81a7-abb0-cf24a21aa42e';
  const oldHash=sha(JSON.stringify(await blocks(oldId)));
  const response=await fetch('https://librarymh.github.io/library-app/?verification='+Date.now());
  assert(response.ok);
  const html=await response.text();
  assert(html.includes('/backup/library-upload/'),'New application is not deployed');
  stage='browser-backup';let calls=audit,drop=true;
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
      if(!req.url.startsWith('/backup/')){res.writeHead(404);res.end();return;}
      let text='';for await(const c of req)text+=c;
      const t=Date.now();
      const r=await fetch(base+req.url,{method:req.method,headers:{Authorization:'Bearer '+process.env.CAPTURE_TOKEN,'Content-Type':'application/json',Origin:'https://librarymh.github.io'},...(text?{body:text}:{}),signal:AbortSignal.timeout(95000)});
      const body=await r.text();
      let errorCode='';if(!r.ok){try{const e=JSON.parse(body).error;errorCode=e==='Invalid status cursor.'?'invalid-cursor':e?.startsWith('Notion error 400:')?'notion-400':e?.startsWith('Notion cannot see')?'notion-permission':'other';}catch{errorCode='unreadable';}}calls.push({path:req.url,method:req.method,bytes:Buffer.byteLength(text),status:r.status,ms:Date.now()-t,...(errorCode?{errorCode}:{})});
      if(req.url.endsWith('/part')&&drop&&r.ok&&JSON.parse(text).i===3){drop=false;req.socket.destroy();return;}
      res.writeHead(r.status,{'Content-Type':'application/json',...(r.headers.get('Retry-After')?{'Retry-After':r.headers.get('Retry-After')}:{})});res.end(body);
    }catch{res.writeHead(502);res.end('{"error":"Verification proxy request failed"}');}
  }).listen(0,'127.0.0.1');
  await new Promise(r=>server.listening?r():server.once('listening',r));
  const browser=await chromium.launch();
  let result;
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    await page.goto('http://127.0.0.1:'+server.address().port);
    result=await page.evaluate(async({object,url})=>{
      let phase='setup';try{S=object; const before=JSON.stringify(S);
      LibrarySharedBackup.setup(url,'verification-placeholder'); UI.tab='settings';render();
      phase='saving';const saved=await LibrarySharedBackup.save('library',{schema:'library.v1',books:S.books});
      phase='loading';const loaded=await LibrarySharedBackup.load('library');
      if(JSON.stringify(loaded.object)!==JSON.stringify(object))throw Error('Full restored object differs');
      phase='restoring';S={books:[]};const restored=mergeMissing(loaded.object.books);if(restored!==314||JSON.stringify(S.books)!==JSON.stringify(object.books))throw Error('Empty restore fidelity differs');if(mergeMissing(loaded.object.books)!==0)throw Error('Repeated restore adds books');const projection=libraryExportBooks();
      phase='first-export';const one=await libraryRunExport(projection);phase='second-export';const two=await libraryRunExport(projection);
      return {books:loaded.object.books.length,takeaways:one.takeaways_unchanged,secondTakeaways:two.takeaways_unchanged,fullMatch:true,localUnchanged:JSON.stringify(S.books)===JSON.stringify(object.books),restoredExactly:true,saved:!!saved};}catch(e){return {ok:false,phase,errorType:e.name};}
    },{object,url:'http://127.0.0.1:'+server.address().port});
    stage='browser-result-'+(result.phase||'complete');assert(result.fullMatch&&result.localUnchanged&&result.saved);
    assert.equal(result.books,314);assert.equal(result.takeaways,706);assert.equal(result.secondTakeaways,706);
    assert.equal(calls.filter(x=>x.path==='/backup/library-export').length,0,'Unchanged export must send zero writes');
    assert(calls.every(x=>x.status===200),'Every forwarded request must succeed');
    assert(Math.max(...calls.map(x=>x.bytes))<170000,'Upload request exceeded bound');
    assert.equal(sha(JSON.stringify(await blocks(oldId))),oldHash,'Protected old snapshot changed');
    console.log(JSON.stringify({ok:true,...result,requests:calls.length,exportWrites:0,maxRequestBytes:Math.max(...calls.map(x=>x.bytes)),maxResponseMs:Math.max(...calls.map(x=>x.ms)),lostChunkResponseRecovered:!drop,oldBackupUnchanged:true}));
  }finally{await browser.close();server.close();}
})().catch(()=>{console.error(JSON.stringify({ok:false,stage,requests:audit.map(x=>({...x,path:x.path.split('?')[0]}))}));process.exitCode=1;});
