// Run against the built app with Chromium; CI supplies an isolated Playwright install.
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.NIXAMP_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../dist',import.meta.url));
const report=[];
for(const mode of ['autoplay','gesture','remote']) {
 const browser=await chromium.launch({headless:true,...(process.env.NIXAMP_CHROMIUM_PATH?{executablePath:process.env.NIXAMP_CHROMIUM_PATH}:{}),args:['--no-sandbox',...(mode==='gesture'?['--autoplay-policy=user-gesture-required']:['--autoplay-policy=no-user-gesture-required'])]});
 const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
 const state={revision:1,tracks:[],trackCount:mode==='remote'?1:0,index:0,playing:false,position:0,bars:Array(24).fill(0),levels:[0,0],silent:true,note:'',root:''};
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url()),path=url.pathname;
  if(url.hostname!=='nixamp.com')return route.abort();
  const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(path==='/api/v1/auth/me')return json({error:'Sign in'},401);
  if(path==='/api/v1/auth/providers')return json({providers:[]});
  if(path==='/api/v1/translation-passes')return json({required:false,available:false,balanceMicros:0,expires:null,plans:[],coins:[],orders:[]});
  if(path==='/api/health')return json({name:'nixamp',version:'0.27.4'});
  if(path==='/api/state')return json(state);
  if(path==='/jingles/index.json')return json(['01.mp3']);
  if(path.startsWith('/api/'))return json({error:'Fixture endpoint unavailable'},404);
  const file=Bun.file(root+(path==='/'?'/index.html':path));
  return await file.exists()?route.fulfill({contentType:file.type,body:Buffer.from(await file.arrayBuffer())}):route.fulfill({status:404,body:''});
 });
 await context.addInitScript(({remote,state})=>{
  if(remote)localStorage.setItem('nixamp.listenHere','0');
  window.__jingles=[];window.__analysers=[];window.__samples=[];window.__painted=[];window.__sources=[];
  const A=Audio;window.Audio=class extends A{constructor(...args){super(...args);window.__jingles.push(this);}};
  const C=AudioContext;window.AudioContext=class extends C {
   createAnalyser(){const node=super.createAnalyser();window.__analysers.push(node);return node;}
   createMediaElementSource(media){window.__sources.push(media);return super.createMediaElementSource(media);}
  };
  const paint=CanvasRenderingContext2D.prototype.fillRect;
  CanvasRenderingContext2D.prototype.fillRect=function(x,y,w,h){if(this.canvas.id==='spectrum'&&h>Math.max(8,this.canvas.height*0.05))window.__painted.push(h);return paint.call(this,x,y,w,h);};
  window.EventSource=class { constructor(url){if(url.includes('/api/events')){this.timer=setInterval(()=>{this.onopen?.({});this.onmessage?.({data:JSON.stringify({...state,revision:++state.revision})});},100);}}close(){clearInterval(this.timer);}addEventListener(){}removeEventListener(){}};
  setInterval(()=>{const node=window.__analysers[0];if(node){const bins=new Uint8Array(node.frequencyBinCount);node.getByteFrequencyData(bins);window.__samples.push(Math.max(...bins));}},30);
 },{remote:mode==='remote',state});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto('https://nixamp.com/',{waitUntil:'domcontentloaded'});
  if(mode==='gesture'){
   await page.waitForTimeout(600);
   assert.equal(await page.evaluate(()=>window.__jingles.some(a=>!a.paused)),false,'autoplay should wait for a gesture');
   await page.locator('#remote-url').click();
  }
  await page.waitForFunction(()=>window.__jingles.some(a=>!a.paused&&a.currentTime>.1),undefined,{timeout:12000});
  await page.evaluate(()=>{const field=document.querySelector('#remote-url');field.value='Keep my draft';field.focus({preventScroll:true});field.setSelectionRange(2,5);window.__scroll=scrollY;});
  await page.waitForTimeout(1500);
  const result=await page.evaluate(()=>({peak:Math.max(...window.__samples),bars:window.__painted.length,wired:window.__sources.filter(a=>a.src.includes('/jingles/')).length,remote:document.querySelector('#remote-state').dataset.status,stable:document.activeElement.id==='remote-url'&&document.activeElement.selectionStart===2&&scrollY===window.__scroll}));
  assert.ok(result.peak>30,'intro never reached the FFT');assert.ok(result.bars>50,'spectrum did not draw the intro');assert.equal(result.wired,1,'intro was wired twice');assert.ok(result.stable,'spectrum updates changed focus or scroll');
  if(mode==='remote')assert.equal(result.remote,'live');
  await page.locator('#files').setInputFiles(root+'/jingles/02.mp3');
  await page.waitForFunction(()=>!document.querySelector('#audio').paused,undefined,{timeout:12000});
  assert.ok(await page.evaluate(()=>window.__jingles.every(a=>a.paused)),'intro overlapped the selected song');
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(()=>{const node=window.__analysers[0];const bins=new Uint8Array(node.frequencyBinCount);node.getByteFrequencyData(bins);return Math.max(...bins)>30;}),'regular playback lost the analyzer');
  assert.deepEqual(errors,[]);console.log('INTRO CHECK',mode,JSON.stringify(result));report.push({mode,...result,normalTrack:true,errors});
 }finally{await browser.close();}
}
console.log(JSON.stringify(report));
