/** Optional browser regression check. Install Playwright or set PLAYWRIGHT_MODULE.
 * Run: node web/scripts/check-live-context.mjs [site URL] [artifact prefix]
 * All server responses are fixtures; media playback and native sharing are
 * simulated. Every API mutation is blocked, including the site's analytics.
 */
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const base = process.argv[2] || 'http://127.0.0.1:4281';
const prefix = process.argv[3] || '/tmp/nixamp-course-local';
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),args:['--no-sandbox'] });
const fixture = { revision:1, tracks:[
 {title:'Unrelated.mp4',artist:'',album:'',duration:0,video:true,folder:'Another course'},
 {title:'0001_1_Few_Words_Before_We_Begin.mp4',artist:'',album:'',duration:0,video:true,folder:'Microservices/01_Getting_Started'},
 {title:'0002_2_Maven.mp4',artist:'',album:'',duration:0,video:true,folder:'Microservices/01_Getting_Started'}
],trackCount:3,index:1,playing:true,position:10,bars:[],levels:[],silent:false,note:'',root:'/private/server/path'};
const results=[];
for (const config of [{width:1280,height:900},{width:390,height:844},{width:1920,height:1080,tv:true},{width:1280,height:900,missing:true},{width:1280,height:900,late:true}]) {
 const snapshot=structuredClone(fixture);
 if(config.missing) snapshot.tracks=snapshot.tracks.map(({folder,...track})=>track);
 const air={server:{name:'server1',nowPlaying:snapshot.tracks[1].title,tracks:3,playing:true,live:true,listed:false,url:'https://server.example/view/view-key',carries:true},channels:[{id:'news',name:'News channel',via:'pull',listeners:0,startedAt:0,kind:'audio'}],restreams:[]};
 const context=await browser.newContext({viewport:{width:config.width,height:config.height},serviceWorkers:'block'});
 const page=await context.newPage();const errors=[];const blocked=[];
 page.on('pageerror',e=>errors.push(e.message));
 await context.addInitScript(({snapshot,late})=>{
   window.__shares=[];
   Object.defineProperty(navigator,'share',{value:async data=>{window.__shares.push(data);}});
   const playing=new WeakMap();
   Object.defineProperty(HTMLMediaElement.prototype,'paused',{get(){return !playing.get(this);}});
   HTMLMediaElement.prototype.play=async function(){playing.set(this,true);this.dispatchEvent(new Event('play'));this.dispatchEvent(new Event('playing'));};
   HTMLMediaElement.prototype.pause=function(){playing.set(this,false);this.dispatchEvent(new Event('pause'));};
   HTMLMediaElement.prototype.load=function(){};
   HTMLMediaElement.prototype.canPlayType=function(){return 'probably';};
   class FakeEventSource extends EventTarget {
     static CLOSED=2;static OPEN=1;static instances=[];readyState=1;
     constructor(url){super();this.url=String(url);FakeEventSource.instances.push(this);if(this.url.includes('/api/events'))setTimeout(()=>{this.onopen?.({});this.onmessage?.({data:JSON.stringify(snapshot)});},late?700:30);}
     close(){this.readyState=2;}
   }
   window.EventSource=FakeEventSource;
   window.__nextSnapshot=next=>{for(const source of FakeEventSource.instances)if(source.url.includes('/api/events'))source.onmessage?.({data:JSON.stringify(next)});};
 },{snapshot,late:config.late});
 await page.route('**/api/**',async route=>{
   const req=route.request();const path=new URL(req.url()).pathname;
   if(req.method()!=='GET'){blocked.push(`${req.method()} ${path}`);return route.fulfill({status:405,contentType:'application/json',body:'{}'});}
   if(path==='/api/live'||path.startsWith('/api/media/'))return route.fulfill({status:204});
   let body={};let status=200;
   if(path==='/api/health')body={name:'nixamp',version:'0.24.0'};
   if(path==='/api/state')body=snapshot;
   if(path==='/api/streams')body=air;
   if(path==='/api/connections'||path==='/api/v1/auth/me')status=401;
   if(path==='/api/directory')body={streams:[]};
   if(path==='/api/catalogs')body={catalogs:[]};
   if(path==='/api/v1/watch-parties')body={parties:[]};
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 try {
   await page.goto(`${base}/?url=${encodeURIComponent('https://server.example/view/view-key')}&play=live${config.tv?'&tv=1':''}`,{waitUntil:'networkidle'});
   await page.waitForFunction(()=>document.querySelector('#title-line').textContent==='Few Words Before We Begin');
   const expected=config.missing?'Few Words Before We Begin':'Microservices › 01 Getting Started › Few Words Before We Begin';
   await page.waitForFunction(expected=>document.querySelector('#live-line').textContent.includes(expected),expected);
   assert.ok((await page.locator('#live-line').innerText()).includes(expected));
   const album=await page.locator('#album-line').innerText();
   assert.ok(album.includes(config.missing?'Playlist · 2 of 3':'Playlist · 1 of 2'));
   assert.ok(!(await page.locator('#live-line').innerText()).includes('/private'));
   assert.ok((await page.locator('#onair-list .detail').first().innerText()).includes(expected));
   assert.equal(await page.locator('#onair-panel').getAttribute('data-title'),'Parties on server1');
   assert.equal(await page.locator('#onair-list').getByRole('button',{name:'Join party',exact:true}).count(),2);
   await page.locator('#share-now').click();
   assert.equal(await page.evaluate(()=>window.__shares[0].title),`${expected} on nixamp`);
   assert.ok((await page.evaluate(()=>window.__shares[0].url)).startsWith('https://nixamp.com/?play='));
   assert.equal(await page.evaluate(()=>navigator.mediaSession.metadata.title),'Few Words Before We Begin');
   assert.ok((await page.evaluate(()=>navigator.mediaSession.metadata.album)).includes('Playlist'));
   assert.ok((await page.title()).includes(expected));
   await page.evaluate(next=>window.__nextSnapshot(next),{...snapshot,tracks:undefined,revision:2,index:2});
   await page.waitForFunction(()=>document.querySelector('#title-line').textContent==='Maven');
   assert.equal(await page.evaluate(()=>navigator.mediaSession.metadata.title),'Maven');
   assert.ok((await page.locator('#onair-list .detail').first().innerText()).includes('Maven'));
   assert.ok((await page.locator('#album-line').innerText()).includes(config.missing?'3 of 3':'2 of 2'));
   await page.locator('#share-now').click();
   assert.ok((await page.evaluate(()=>window.__shares[1].title)).endsWith('Maven on nixamp'));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert.deepEqual(errors,[]);
   assert.ok(blocked.every(x=>x==='POST /api/track'),JSON.stringify(blocked));
   await page.locator('#title-line').evaluate(el=>el.closest('.panel').scrollIntoView());
   await page.screenshot({path:`${prefix}-${config.width}${config.tv?'-tv':''}${config.missing?'-fallback':''}${config.late?'-late':''}.png`});
   await page.locator('#onair-list').getByRole('button',{name:'Join party',exact:true}).nth(1).click();
   await page.waitForFunction(()=>document.querySelector('#title-line').textContent==='News channel');
   assert.ok(!(await page.locator('#live-line').innerText()).includes('Microservices'));
   assert.ok(!(await page.locator('#album-line').innerText()).includes('Playlist'));
   assert.equal(await page.evaluate(()=>navigator.mediaSession.metadata.title),'News channel');
   assert.deepEqual(errors,[]);
   assert.ok(blocked.every(x=>x==='POST /api/track'),JSON.stringify(blocked));
   results.push({config,channelIsolation:true,lectureChanged:true,shareTitle:true,mediaSession:true,scopedPosition:true,partiesPreserved:true,noPageOverflow:true,blocked});
 }catch(e){console.error({config,errors,blocked,title:await page.locator('#title-line').innerText(),album:await page.locator('#album-line').innerText(),body:(await page.locator('body').innerText()).slice(0,2500)});await page.screenshot({path:prefix+'-failure.png'});throw e;}finally{await context.close();}
}
await browser.close();await writeFile(prefix+'.json',JSON.stringify({base,api:'read-only fixtures; media and mutations blocked',results},null,2)+'\n');console.log(JSON.stringify({base,cases:results.length,passed:true}));
