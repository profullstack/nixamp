import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const {chromium} = await import(process.env.NIXAMP_PLAYWRIGHT_MODULE || 'playwright');
import {readFile,writeFile} from 'node:fs/promises';
const root=fileURLToPath(new URL('../dist', import.meta.url));
const browser=await chromium.launch({headless:true, ...(process.env.NIXAMP_CHROMIUM_PATH ? {executablePath:process.env.NIXAMP_CHROMIUM_PATH} : {})});
const context=await browser.newContext({viewport:{width:1280,height:900},locale:'en-US',serviceWorkers:'block'});
const title='01. A deliberately long lecture filename describing security engineering and application architecture.mp4';
const long='Complete course/01. Introduction/01. Lessons/'+title;
const state={revision:1,tracks:[{title,artist:'',album:'',duration:2,video:true,folder:''}],trackCount:1,index:0,playing:false,position:0,bars:[],levels:[0,0],silent:true,note:'',root:'/private/root'};
const air={server:{name:'Test',nowPlaying:'',tracks:1,playing:false,live:false,code:'',url:'https://server.example/view/test'},channels:[{id:'review',name:'Review live',via:'pull',listeners:1,startedAt:Date.now(),kind:'audio',playlist:[long,long.replace('01. A','02. A')],entry:0,live:true}]};
let directoryRequests=[];
const silence=Buffer.alloc(44+8000*60*2);
silence.write('RIFF',0);silence.writeUInt32LE(silence.length-8,4);silence.write('WAVEfmt ',8);
silence.writeUInt32LE(16,16);silence.writeUInt16LE(1,20);silence.writeUInt16LE(1,22);
silence.writeUInt32LE(8000,24);silence.writeUInt32LE(16000,28);silence.writeUInt16LE(2,32);silence.writeUInt16LE(16,34);
silence.write('data',36);silence.writeUInt32LE(silence.length-44,40);
async function fixtures(context) {
await context.addInitScript(({state})=>{
 localStorage.setItem('nixamp.welcome','hidden');
 const media=new WeakMap();
 Object.defineProperty(HTMLMediaElement.prototype,'paused',{get(){return !media.get(this)}});
 HTMLMediaElement.prototype.play=async function(){media.set(this,true);this.dispatchEvent(new Event('play'));this.dispatchEvent(new Event('playing'))};
 HTMLMediaElement.prototype.pause=function(){media.set(this,false);this.dispatchEvent(new Event('pause'))};
 HTMLMediaElement.prototype.load=function(){};
 class Source{static all=[];readyState=1;constructor(url){this.url=String(url);Source.all.push(this);if(this.url.includes('/api/events'))setTimeout(()=>{this.onopen?.({});this.onmessage?.({data:JSON.stringify(state)})},40)}close(){}addEventListener(){}removeEventListener(){}}
 window.EventSource=Source;
 window.reviewTick=()=>{for(const s of Source.all)if(s.url.includes('/api/events'))s.onmessage?.({data:JSON.stringify({...state,tracks:undefined,revision:++state.revision,position:state.revision/10})})};
},{state});
await context.route('**/*',async route=>{
 const url=new URL(route.request().url()),path=url.pathname;
 const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 if(!['https://nixamp.com','https://server.example'].includes(url.origin))return route.abort();
 if(path==='/api/v1/auth/me')return json({},401);
 if(path==='/api/v1/auth/providers')return json({providers:[]});
 if(path==='/api/state')return json(state);
 if(path==='/api/health')return json({name:'nixamp',version:'fixture'});
 if(path==='/api/streams')return json(air);
 if(path==='/api/directory'){directoryRequests.push(Date.now());await new Promise(r=>setTimeout(r,250));return json({streams:[]})}
 if(path==='/api/catalogs')return json({catalogs:[]});
 if(path==='/jingles/index.json')return json([]);
 if(path.startsWith('/api/channels/'))return route.fulfill({status:200,contentType:'audio/wav',body:silence});
 if(path.startsWith('/api/'))return json({},404);
 if(url.origin!=='https://nixamp.com')return route.abort();
 try{const file=root+(path==='/'?'/index.html':path);const body=await readFile(file);return route.fulfill({body,contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404,body:''})}
});
}
await fixtures(context);
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('https://nixamp.com/?url=https%3A%2F%2Fserver.example%2Fview%2Ftest&play=channel%3Areview');
 await page.locator('#live-playlist .row').first().waitFor();
 await page.waitForTimeout(150);
 const geometry=await page.evaluate(()=>{
  const one=sel=>{const e=document.querySelector(sel),r=e.getBoundingClientRect(),c=getComputedStyle(e);return {x:r.x,width:r.width,height:r.height,padding:c.padding,display:c.display,textAlign:c.textAlign,grid:c.gridTemplateColumns,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth}};
  return {live:one('#live-playlist .row'),liveNumber:one('#live-playlist .n'),liveLabel:one('#live-playlist .row-label'),liveTitleViewport:one('#live-playlist .row-label .row-value'),liveTitle:one('#live-playlist .row-file'),livePath:one('#live-playlist .row-path'),file:one('#playlist .row'),fileTitle:one('#playlist .row-file'),filePath:one('#playlist .row-path')};
 });
 await page.evaluate(()=>{window.reviewLive=document.querySelector('#live-playlist .row');window.reviewFile=document.querySelector('#playlist .row');window.reviewSpinner=document.querySelector('#parties-panel .panel-loading-spinner')});
 const pan=page.locator('#live-playlist .row > .row-value').first();
 await pan.scrollIntoViewIfNeeded();const rect=await pan.boundingBox();
 await page.mouse.move(rect.x+rect.width-4,rect.y+rect.height/2);await page.waitForTimeout(700);
 const before=await pan.evaluate(e=>({shift:e.firstChild.style.getPropertyValue('--path-shift'),pan:e.firstChild.dataset.pan}));
 await page.evaluate(()=>window.reviewTick());await page.waitForTimeout(40);
 const after=await page.evaluate(()=>({liveSame:window.reviewLive===document.querySelector('#live-playlist .row'),liveAttached:window.reviewLive.isConnected,fileSame:window.reviewFile===document.querySelector('#playlist .row'),spinnerSame:window.reviewSpinner===document.querySelector('#parties-panel .panel-loading-spinner'),pan:document.querySelector('#live-playlist .row > .row-value').firstChild.dataset.pan,shift:document.querySelector('#live-playlist .row > .row-value').firstChild.style.getPropertyValue('--path-shift')}));
 assert.equal(after.liveSame,true,'playback ticks must preserve the live row');
 assert.equal(after.fileSame,true);
 assert.equal(after.spinnerSame,true);
 assert.equal(after.pan,'true');
 assert.ok(Math.abs(geometry.liveTitle.x-geometry.livePath.x)<1,'title and full path must align');
 assert.ok(Math.abs(geometry.fileTitle.x-geometry.filePath.x)<1);
 const end=await pan.evaluate(e=>{
   const text=e.firstChild, box=e.getBoundingClientRect(), edge=text.getBoundingClientRect().right;
   return {edge, right:box.right-parseFloat(getComputedStyle(e).paddingRight)};
 });
 assert.ok(Math.abs(end.edge-end.right)<2,'far-right mouse position exposes the last character');
 const height=await page.locator('#live-playlist .row').first().evaluate(e=>e.getBoundingClientRect().height);
 // Repeated notifications while moving used to detach the row and reset its pan.
 for(let i=0;i<20;i++) {
   await page.mouse.move(rect.x+rect.width*(0.1+i/25),rect.y+rect.height/2);
   await page.evaluate(()=>window.reviewTick());
 }
 await page.mouse.move(rect.x-20,rect.y-10);
 await page.waitForTimeout(800);
 const left=await pan.evaluate(e=>({height:e.closest('.row').getBoundingClientRect().height,shift:e.firstChild.style.getPropertyValue('--path-shift'),nowrap:getComputedStyle(e.firstChild).whiteSpace}));
 assert.equal(left.height,height,'leaving must never wrap or change desktop row height');
 assert.equal(left.shift,''); assert.equal(left.nowrap,'nowrap');
 await page.locator('input[type=search]').first().focus();
 await page.evaluate(()=>{window.reviewFocus=document.activeElement;window.reviewScroll=scrollY;for(let i=0;i<20;i++)window.reviewTick()});
 await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>document.activeElement===window.reviewFocus&&scrollY===window.reviewScroll),true);
 await page.waitForTimeout(10500);
 const intervals=directoryRequests.slice(1).map((v,i)=>v-directoryRequests[i]).filter(v=>v>1000);
 assert.ok(intervals.length>=2);
 assert.ok(intervals.every(v=>v>=4500),'quiet directory polling runs every five seconds');
 assert.equal(await page.locator('#parties-panel').getAttribute('data-loading'),null);
 assert.deepEqual(errors,[]);
 air.channels[0].entry=1;
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await page.locator('#live-playlist .row[data-index="1"][aria-current="true"]').waitFor({timeout:7000});
 assert.equal(await page.evaluate(()=>window.reviewLive===document.querySelector('#live-playlist .row')),true);
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
 await fixtures(mobile);
 const phone=await mobile.newPage();
 await phone.goto('https://nixamp.com/?url=https%3A%2F%2Fserver.example%2Fview%2Ftest&play=channel%3Areview');
 await phone.locator('#live-playlist .row').first().waitFor();
 const wrapped=await phone.locator('#live-playlist .row-path').first().evaluate(e=>({whiteSpace:getComputedStyle(e).whiteSpace,height:e.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(e).lineHeight)}));
 assert.equal(wrapped.whiteSpace,'normal');
 assert.ok(wrapped.height>wrapped.lineHeight*2,'touch users can read the complete wrapped path');
 assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await mobile.close();
 console.log('Live and file rows retain identity, align, pan to both ends, return without wrapping, preserve focus/scroll, and poll quietly every five seconds.');
}finally{await browser.close()}
