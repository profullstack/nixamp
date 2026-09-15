// Real encoders, HLS packaging, and browser decoding; synthetic media only.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {Channels} from '../../src/channels.ts';
const {chromium}=await import(process.env.NIXAMP_PLAYWRIGHT_MODULE || 'playwright');
const root=mkdtempSync(join(tmpdir(),'nixamp-browser-media-'));
const assets=fileURLToPath(new URL('../dist/assets',import.meta.url));
const ff=args=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{timeout:20000});
let browser,channels;
try{
 const files=['red','blue','lime'].map((color,i)=>{
  const file=join(root,`${i}.mp4`);
  ff(['-f','lavfi','-i',`color=c=${color}:s=160x90:r=10:d=2`,'-f','lavfi','-i',`sine=frequency=${440+i*220}:sample_rate=${i===1?44100:48000}:duration=2`,
   '-c:v',i===1?'mpeg4':'libx264','-threads','1','-g','10','-c:a','aac','-t','2',file]);
  return file;
 });
 let finish;const done=new Promise(r=>finish=r);
 channels=new Channels({ffmpeg:['ffmpeg'],ffprobe:['ffprobe'],onEnd:finish});
 const channel=channels.pull('test','Test',files[0],[],'video',false,10000,[],'',{live:true,position:0,playlist:files},{video:'h264',audio:'aac',container:'mp4',width:160,height:90});
 const chunks=[];channel.listen({write(chunk){chunks.push(chunk);return true},end(){}});
 await done;assert.equal(channel.info.error,undefined);
 const mp4=join(root,'live.mp4');writeFileSync(mp4,Buffer.concat(chunks));
 ff(['-i',mp4,'-c','copy','-f','hls','-hls_time','2','-hls_list_size','0','-hls_flags','independent_segments','-hls_segment_filename',join(root,'seg%d.ts'),join(root,'index.m3u8')]);
 const library=readdirSync(assets).filter(name=>/^hls-.*\.js$/.test(name)).sort((a,b)=>statSync(join(assets,b)).size-statSync(join(assets,a)).size)[0];
 browser=await chromium.launch({headless:true,...(process.env.NIXAMP_CHROMIUM_PATH?{executablePath:process.env.NIXAMP_CHROMIUM_PATH}:{}),args:['--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage({serviceWorkers:'block'});
 await page.route('https://media.example/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:'<video autoplay muted></video><canvas width="1" height="1"></canvas>'});
  const file=path.startsWith('/assets/')?join(assets,path.slice(8)):join(root,path.slice(1));
  return route.fulfill({body:readFileSync(file),contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t'});
 });
 await page.goto('https://media.example/');
 await page.evaluate(async library=>{
  const {default:Hls}=await import(`/assets/${library}`);
  const video=document.querySelector('video');
  window.mediaErrors=[];window.colors=[];
  video.addEventListener('error',()=>window.mediaErrors.push(video.error?.message));
  const hls=new Hls();window.testHls=hls;
  hls.on(Hls.Events.ERROR,(_e,d)=>{if(d.fatal||d.details==='fragParsingError')window.mediaErrors.push(d.details)});
  const context=document.querySelector('canvas').getContext('2d');
  video.addEventListener('timeupdate',()=>{
   if(!video.videoWidth)return;
   context.drawImage(video,0,0,1,1);const [r,g,b]=context.getImageData(0,0,1,1).data;
   const color=r>150?'red':b>150?'blue':g>150?'green':'unknown';
   if(color!==window.colors.at(-1))window.colors.push(color);
  });
  hls.attachMedia(video);hls.loadSource('/index.m3u8');await video.play();
 },library);
 await page.waitForFunction(()=>document.querySelector('video').ended,{},{timeout:15000});
 const result=await page.evaluate(()=>({errors:window.mediaErrors,colors:window.colors,time:document.querySelector('video').currentTime}));
 assert.deepEqual(result.errors,[]);assert.deepEqual(result.colors,['red','blue','green']);assert.ok(result.time>=5.9);
 console.log('Real HLS video and audio decode through three files and two source codecs with no parsing or media errors.');
}finally{channels?.stopAll();await browser?.close();rmSync(root,{recursive:true,force:true})}
