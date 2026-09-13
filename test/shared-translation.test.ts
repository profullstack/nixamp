import { test } from "node:test";
import assert from "node:assert/strict";
import { SharedTranslations, publicStreamAddress, sharedSource, type SharedEvent } from "../src/shared-translation.ts";
import { LiveVoice } from "../src/live-voice.ts";
import { decodeWav, SpeechError } from "../src/speech.ts";
const pause=()=>new Promise(resolve=>setTimeout(resolve,30));

test("shared live sources reject local addresses, redirects' target shapes and embedded credentials",()=>{
  for(const ip of ["127.0.0.1","10.2.3.4","169.254.169.254","100.64.0.1","192.168.1.1","::1","::ffff:127.0.0.1","fc00::1","2001:db8::1","2002:7f00:1::"])assert.equal(publicStreamAddress(ip),false,ip);
  for(const ip of ["1.1.1.1","104.152.209.195","2606:4700:4700::1111"])assert.equal(publicStreamAddress(ip),true,ip);
  for(const url of ["file:///etc/passwd","https://user:secret@example.com/api/channels/nfl","https://example.com/movie.m3u8","https://example.com/api/channels/nfl?redirect=http://local"])assert.throws(()=>sharedSource(url));
  assert.equal(sharedSource("https://example.com/api/channels/nfl?k=view").pathname,"/api/channels/nfl");
});

test("N+1 live listeners share recognition and PCM; remaining listeners keep the source, last departure stops it",async()=>{
  let opens=0,stops=0,heard=0,spoken=0,translated=0;let pcm!:(bytes:Buffer)=>void;
  const eventsA:SharedEvent[]=[],eventsB:SharedEvent[]=[];const charges:string[]=[];const funded=new Set(["alice","bob"]);
  const billing={require:async(by:string)=>{if(!funded.has(by))throw new SpeechError("Buy a pass",402);},reserve:async(by:string,kind:string)=>{if(!funded.has(by))throw new SpeechError("Balance expired",402);charges.push(`${by}:${kind}`);return String(charges.length);},commit:async()=>{},refund:async()=>{}};
  const voice=new LiveVoice({apiKey:"test",fetcher:(async(url,init)=>{
    if(String(url).includes("/voices?"))return Response.json({voices:[{voice_id:"one",name:"Speaker"}]});
    if(String(url).includes("speech-to-text")){
      heard++;const form=init?.body as FormData;const wav=decodeWav(new Uint8Array(await(form.get("file")as Blob).arrayBuffer()));const seconds=wav.samples.length/16000;
      return Response.json({language_code:"spa",words:[{text:`Frase ${heard}.`,start:seconds-1.4,end:seconds-.4,type:"word",speaker_id:"speaker_0"}]});
    }
    spoken++;return new Response(new Uint8Array([0,0,10,0,20,0]));
  })as typeof fetch});
  const shared=new SharedTranslations({voice,billing,translator:{translate:async(texts:string[])=>{translated++;return{texts: texts.map(text=>`Deutsch: ${text}`),from:"es",to:"de",model:"test"};}},open:async(_source,take)=>{opens++;pcm=take;return{stop:()=>{stops++;}};}});
  await assert.rejects(shared.join("https://example.com/api/channels/nfl","de","stranger",()=>{},()=>{}),/Buy/);
  const a=await shared.join("https://example.com/api/channels/nfl","de","alice",e=>eventsA.push(e),()=>{});
  const b=await shared.join("https://example.com/api/channels/nfl","de","bob",e=>eventsB.push(e),()=>{});
  await pause();assert.equal(opens,1);
  const fresh=Buffer.alloc(64000);for(let i=0;i<32000;i++)fresh.writeInt16LE(Math.round(8000*Math.sin(i/20)),i*2);
  pcm(fresh);await pause();await pause();
  assert.equal(heard,1);assert.equal(spoken,1);assert.equal(translated,1);
  assert.deepEqual(eventsA.filter(e=>e.type==="audio"),eventsB.filter(e=>e.type==="audio"));
  assert.equal(eventsB.filter(e=>e.type==="audio").length,1);
  assert.deepEqual(charges.sort(),["alice:transcription","alice:voice","bob:transcription","bob:voice"].sort());
  a();assert.equal(shared.size,1);assert.equal(stops,0);
  await new Promise(resolve=>setTimeout(resolve,2050));
  pcm(fresh);await pause();await pause();assert.equal(heard,2);assert.equal(spoken,2);assert.equal(opens,1);
  assert.equal(eventsA.filter(e=>e.type==="line").length,1);assert.equal(eventsB.filter(e=>e.type==="line").length,2);
  b();assert.equal(shared.size,0);assert.equal(stops,1);
  pcm(fresh);await pause();assert.equal(heard,2,"no provider work after last departure");
});

test("a rejected voice phrase does not stop the shared source or charge a retry", async () => {
  let pcm!: (bytes: Buffer) => void, opened = 0, spoken = 0, stopped = 0;
  const events: SharedEvent[] = [];
  const voice = {
    available: () => true, voices: async () => [],
    hear: async (bytes: Uint8Array) => {
      const seconds = decodeWav(bytes).samples.length / 16000;
      return { language: "es", turns: [{ speaker: "a", profile: "lower", start: seconds - 1.5, end: seconds - 0.4,
        words: [{ text: "La pelea sigue.", start: seconds - 1.5, end: seconds - 0.4 }] }] };
    },
    stream: async () => { if (++spoken === 1) throw new SpeechError("Temporary voice outage", 502); return new Response(new Uint8Array([0, 64])); },
  } as unknown as LiveVoice;
  const shared = new SharedTranslations({ voice, translator: { translate: async texts => ({ texts, from: "es", to: "de", model: "test" }) },
    open: async (_source, take) => { opened++; pcm = take; return { stop() { stopped++; } }; } });
  const leave = await shared.join("https://example.com/api/channels/nfl", "de", "alice", event => events.push(event), () => {});
  try {
    await pause(); pcm(Buffer.alloc(64000)); await pause(); assert.equal(spoken, 1); assert.equal(shared.size, 1);
    await new Promise(resolve => setTimeout(resolve, 2050)); pcm(Buffer.alloc(64000)); await pause();
    assert.equal(spoken, 2); assert.equal(opened, 1); assert.equal(stopped, 0);
    assert.equal(events.filter(event => event.type === "audio").length, 1);
    assert.equal(events.filter(event => event.type === "error").length, 0);
  } finally { leave(); }
});
