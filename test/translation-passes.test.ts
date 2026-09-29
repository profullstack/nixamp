import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { TranslationPasses, translationCost, verifyTranslationPayment, TRANSLATION_PLANS, coinpayKeyFrom, readCoinpayWebhook, verifyCoinpaySignature } from "../src/translation-passes.ts";
import { SpeechError, encodeWav } from "../src/speech.ts";
import { LiveVoice } from "../src/live-voice.ts";
import { EmptyEngine, createServer } from "../src/server.ts";
import type { Accounts } from "../src/accounts.ts";
import type { AddressInfo } from "node:net";

const id = randomUUID();
test("400% markup is five times the base cost; only exact, confirmed USD payments match", () => {
  assert.deepEqual(translationCost("voice", 500), { cost: 25000, charge: 125000 });
  assert.deepEqual(translationCost("transcription", 96000), { cost: 367, charge: 1835 });
  for (const units of [NaN, Infinity, -1, 0, 0.5, 601]) assert.throws(() => translationCost("voice", units));
  assert.throws(() => translationCost("transcription", 241601));
  const payment = { id, status: "confirmed", currency: "USD", amount: "5.00000000" };
  assert.equal(verifyTranslationPayment(payment, id, 500), true);
  for (const change of [{id:randomUUID()}, {status:"pending"}, {status:"refunded"}, {amount:"5.001"}, {amount:4.99}, {amount:0}, {amount:"5e0"}, {currency:"USDC"}]) assert.equal(verifyTranslationPayment({...payment,...change}, id, 500), false);
  assert.deepEqual(TRANSLATION_PLANS.map(plan => [plan.days, plan.priceCents]), [[1,100],[30,500]]);
});

test("paid provider calls reserve before use, refund failures, and cached audio requires paid access", async () => {
  const calls: string[] = []; let funded = true, providerOK = true, now = 0;
  const meter = { require: async () => { if (!funded) throw new SpeechError("Buy a pass",402); }, reserve: async (_by: string,kind:string,units:number) => { calls.push(`reserve:${kind}:${units}`); return "r"; }, commit: async () => { calls.push("commit"); }, refund: async () => { calls.push("refund"); } };
  const voice = new LiveVoice({apiKey:"test",billing:meter,now:()=>now,fetcher:(async (url) => {
    if (String(url).includes("/voices?")) return Response.json({voices:[{voice_id:"stock",name:"Voice"}]});
    calls.push("provider");
    if (!providerOK) return new Response("",{status:500});
    if (String(url).includes("speech-to-text")) return Response.json({language_code:"en",words:[]});
    return new Response(new Uint8Array([0,0,1,0]));
  }) as typeof fetch});
  const ask = {text:"Hello",language:"de"};
  await (await voice.stream(ask,"alice")).arrayBuffer();
  assert.deepEqual(calls,["reserve:voice:5","provider","commit"]);
  calls.length=0;
  await (await voice.stream(ask,"bob")).arrayBuffer();
  assert.deepEqual(calls,["reserve:voice:5","commit"],"reuse still sells access without another provider call");
  funded=false;
  await assert.rejects(voice.stream(ask,"alice"),/Buy a pass/);
  await assert.rejects(voice.grant("alice","channel"),/Buy a pass/);
  await assert.rejects(voice.hear(new Uint8Array(encodeWav(new Float32Array(32000).fill(.1))),"alice"),/Buy a pass/);
  funded=true;providerOK=false;calls.length=0;
  await assert.rejects(voice.stream({...ask,text:"Unavailable"},"alice"),/temporarily unavailable/);
  assert.deepEqual(calls,["reserve:voice:11","provider","refund"]);
  calls.length=0;
  await assert.rejects(voice.hear(new Uint8Array(encodeWav(new Float32Array(32000).fill(.1))),"alice"),/temporarily unavailable/);
  assert.deepEqual(calls,[],"a provider cooldown does not reserve credit or call the provider");
  now=10_001;
  await assert.rejects(voice.hear(new Uint8Array(encodeWav(new Float32Array(32000).fill(.1))),"alice"),/temporarily unavailable/);
  assert.deepEqual(calls,["reserve:transcription:32000","provider","refund"]);
});

test("PostgreSQL: payment verification, idempotent activation, concurrent debit, expiry and route authorization", {skip:!process.env["NIXAMP_TEST_DATABASE_URL"]}, async () => {
  const connectionString=process.env["NIXAMP_TEST_DATABASE_URL"]!;
  const admin=new pg.Pool({connectionString});const schema=`translation_test_${randomUUID().replaceAll("-","")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new pg.Pool({connectionString,options:`-c search_path=${schema}`});
  let now=Date.now(), creates=0, status="pending", amount=1;
  const paymentId=randomUUID(), business=randomUUID();
  const service=new TranslationPasses({db,key:"test-key",site:"https://nixamp.com",now:()=>now,fetcher:(async(url,init)=>{
    if (String(url).endsWith("supported-coins")) return Response.json({success:true,business_id:business,coins:[{symbol:"USDC_POL",is_active:true,has_wallet:true}]});
    if (String(url).endsWith("create")) { creates++; const body=JSON.parse(String(init?.body)); assert.equal(body.amount_usd,1); assert.equal(body.business_id,business); assert.equal(body.payment_method,"crypto"); assert.ok(new Headers(init?.headers).get("idempotency-key")); return Response.json({success:true,payment:{id:paymentId}}); }
    return Response.json({success:true,payment:{id:paymentId,status,amount,currency:"USD"}});
  })as typeof fetch});
  try {
    await service.access();await assert.rejects(service.require("alice"),/Buy/);
    const key=randomUUID(), order=await service.checkout("alice","day","USDC_POL",key);
    assert.deepEqual(await service.checkout("alice","day","USDC_POL",key),order);assert.equal(creates,1);
    await assert.rejects(service.checkout("alice","month","USDC_POL",key),/different pass/);
    await assert.rejects(service.checkout("alice","free","USDC_POL",randomUUID()),/Choose/);
    await assert.rejects(service.check("bob",order.id),/not found/);
    assert.equal((await service.check("alice",order.id)).status,"pending");
    status="confirmed";amount=0.01;
    await service.check("alice",order.id);assert.equal((await service.access("alice")).balanceMicros,0);
    amount=1;
    await Promise.all(Array.from({length:12},()=>service.check("alice",order.id)));
    assert.equal((await service.access("alice")).balanceMicros,1_000_000,"confirmed once across concurrent requests");
    // Exactly 8 x $0.125 debits fit; the other ten must fail atomically.
    const attempts=await Promise.allSettled(Array.from({length:50},()=>service.reserve("alice","voice",500)));
    const paid=attempts.filter((result):result is PromiseFulfilledResult<string>=>result.status==="fulfilled");
    assert.equal(paid.length,8);assert.equal((await service.access("alice")).balanceMicros,0);
    await Promise.all(Array.from({length:8},()=>service.refund(paid[0]!.value)));
    assert.equal((await service.access("alice")).balanceMicros,125000,"refund once");
    await service.commit(paid[1]!.value);await service.refund(paid[1]!.value);
    assert.equal((await service.access("alice")).balanceMicros,125000,"accepted voice cannot be refunded by canceling playback");
    await db.query("INSERT INTO translation_wallets VALUES ('bob',125000,$1)", [new Date(now+86400000)]);
    const batch = await service.reserveMany(["alice", "bob", "bob", "unfunded"], "voice", 500);
    assert.deepEqual(batch.map(row => row.by).sort(), ["alice", "bob"]);
    assert.equal((await service.access("alice")).balanceMicros,0);
    assert.equal((await service.access("bob")).balanceMicros,0,"a duplicate connection is charged once");
    await service.refundMany([...batch.map(row => row.id), paid[2]!.value, paid[3]!.value]);
    assert.equal((await service.access("alice")).balanceMicros,375000,"batch refund sums multiple reservations for an account");
    await service.refundMany(batch.map(row => row.id));
    assert.equal((await service.access("bob")).balanceMicros,125000,"batch refund is idempotent");
    const finalBatch=await service.reserveMany(["alice","bob"],"voice",500);
    await service.commitMany(finalBatch.map(row=>row.id));await service.refundMany(finalBatch.map(row=>row.id));
    assert.equal((await service.access("alice")).balanceMicros,250000,"accepted batch stays charged");
    now+=86_400_001;await assert.rejects(service.require("alice"),/Buy/);assert.equal((await service.access("alice")).balanceMicros,0);
    const server=createServer(new EmptyEngine(),{web:null,media:false,version:"test",translationPasses:service,accounts:{whoIs:async(token:string)=>token==="alice"?{id:"alice"}:token==="bob"?{id:"bob"}:null}as unknown as Accounts});
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const base=`http://127.0.0.1:${(server.address()as AddressInfo).port}/api/v1/translation-passes`;
    try {
      assert.equal((await fetch(base)).status,200);
      assert.equal((await fetch(`${base}/checkout`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({plan:"day",coin:"USDC_POL",requestKey:randomUUID(),priceCents:1,paid:true})})).status,401);
      assert.equal((await fetch(`${base}/orders/${order.id}`,{headers:{authorization:"Bearer bob"}})).status,404);
      assert.equal((await fetch(`${base}/orders/${order.id}`,{headers:{authorization:"Bearer alice"}})).status,200);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }finally{await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

const sign = (raw: string, secret: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

test("CoinPay webhooks: signature over the raw body, nested payload, own key before the fleet key", () => {
  const raw = JSON.stringify({ id: "evt_x_1", type: "payment.forwarded", data: { payment_id: id, status: "forwarded", amount: 5 } });
  assert.equal(verifyCoinpaySignature(raw, sign(raw, "whsec"), "whsec"), true);
  assert.equal(verifyCoinpaySignature(raw, sign(raw, "other"), "whsec"), false);
  assert.equal(verifyCoinpaySignature(raw + " ", sign(raw, "whsec"), "whsec"), false);
  assert.equal(verifyCoinpaySignature(raw, sign(raw, "whsec", Math.floor(Date.now() / 1000) - 301), "whsec"), false, "older than 300 s");
  assert.equal(verifyCoinpaySignature(raw, sign(raw, "whsec"), ""), false, "no secret, no trust");
  assert.equal(verifyCoinpaySignature(raw, undefined, "whsec"), false);
  assert.equal(verifyCoinpaySignature(raw, "t=1,v1=zz", "whsec"), false);
  // The top-level id is the EVENT; the payment is under data.
  assert.deepEqual(readCoinpayWebhook(JSON.parse(raw)), { type: "payment.forwarded", paymentId: id, status: "forwarded" });
  assert.deepEqual(readCoinpayWebhook({ id, status: "CONFIRMED" }), { type: "", paymentId: id, status: "confirmed" }, "older flat test sender");
  assert.deepEqual(readCoinpayWebhook(null), { type: "", paymentId: "", status: "" });
  assert.equal(coinpayKeyFrom({ COINPAY_API_KEY: "own", COINPAY_X402_KEY: "fleet" }), "own");
  assert.equal(coinpayKeyFrom({ COINPAY_X402_KEY: "fleet" }), "fleet");
  assert.equal(coinpayKeyFrom({}), "");
});

test("PostgreSQL: a signed CoinPay webhook settles its order once, by asking CoinPay", {skip:!process.env["NIXAMP_TEST_DATABASE_URL"]}, async () => {
  const connectionString=process.env["NIXAMP_TEST_DATABASE_URL"]!;
  const admin=new pg.Pool({connectionString});const schema=`translation_hook_${randomUUID().replaceAll("-","")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new pg.Pool({connectionString,options:`-c search_path=${schema}`});
  const paymentId=randomUUID(), business=randomUUID(); let status="pending", lookups=0;
  const service=new TranslationPasses({db,key:"test-key",site:"https://nixamp.com",fetcher:(async(url)=>{
    if (String(url).endsWith("supported-coins")) return Response.json({success:true,business_id:business,coins:[{symbol:"USDC_POL",is_active:true,has_wallet:true}]});
    if (String(url).endsWith("create")) return Response.json({success:true,payment:{id:paymentId}});
    lookups++; return Response.json({success:true,payment:{id:paymentId,status,amount:"1.00",currency:"USD"}});
  })as typeof fetch});
  const server=createServer(new EmptyEngine(),{web:null,media:false,version:"test",translationPasses:service,coinpayWebhookSecret:"whsec",accounts:{whoIs:async()=>null}as unknown as Accounts});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const hook=`http://127.0.0.1:${(server.address()as AddressInfo).port}/api/v1/webhooks/coinpay`;
  const post=(body:unknown,secret="whsec")=>{const raw=JSON.stringify(body);return fetch(hook,{method:"POST",headers:{"content-type":"application/json","x-coinpay-signature":sign(raw,secret)},body:raw});};
  const event=(type:string,payment:string,state:string)=>({id:`evt_${payment}_1`,type,data:{payment_id:payment,status:state,amount:1,amount_usd:1,metadata:{app:"nixamp"}}});
  try {
    const order=await service.checkout("alice","day","USDC_POL",randomUUID());
    let answer=await post(event("payment.forwarded",randomUUID(),"forwarded"));
    assert.equal(answer.status,200);assert.deepEqual(await answer.json(),{settled:false,reason:"unknown payment"});
    assert.equal(lookups,0,"an unknown payment costs no CoinPay call");
    assert.equal((await post(event("payment.forwarded",paymentId,"forwarded"),"wrong")).status,401);
    assert.equal((await fetch(hook,{method:"POST",body:"{}"})).status,401,"unsigned");
    assert.equal((await fetch(hook)).status,405);
    // The body says confirmed; CoinPay still says pending. Nothing is credited.
    answer=await post(event("payment.confirmed",paymentId,"confirmed"));
    assert.equal(answer.status,200);assert.deepEqual(await answer.json(),{settled:false,status:"pending"});
    assert.equal((await service.access("alice")).balanceMicros,0);
    status="forwarded";
    for (const type of ["payment.confirmed","payment.forwarded","payment.forwarded"]) {
      answer=await post(event(type,paymentId,"forwarded"));
      assert.equal(answer.status,200);assert.deepEqual(await answer.json(),{settled:true,status:"paid"});
    }
    assert.equal((await service.access("alice")).balanceMicros,1_000_000,"credited once across repeated deliveries");
    assert.equal((await service.check("alice",order.id)).status,"paid");
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

test("CoinPay webhook route refuses everything without a configured secret", async () => {
  const server=createServer(new EmptyEngine(),{web:null,media:false,version:"test"});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const raw="{}";
    const answer=await fetch(`http://127.0.0.1:${(server.address()as AddressInfo).port}/api/v1/webhooks/coinpay`,{method:"POST",headers:{"x-coinpay-signature":sign(raw,"")},body:raw});
    assert.equal(answer.status,503);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
