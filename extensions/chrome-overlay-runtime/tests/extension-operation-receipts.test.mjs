import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionOperationReceiptStore } from "../src/agent/extension-operation-receipts.mjs";

const memoryStorage = () => { const data={}; return { async get(key){return {[key]:structuredClone(data[key])};},async set(values){Object.assign(data,structuredClone(values));},data }; };

test("receipt is durable before execution and duplicate delivery never starts twice", async () => {
  const storageArea=memoryStorage(); const first=createExtensionOperationReceiptStore({storageArea,now:()=>100});
  const accepted=await first.receive("op-1",{call_id:"call-1",runtime_id:"runtime-1"});
  assert.equal(accepted.duplicate,false); assert.equal(accepted.receipt.state,"received");
  const afterRestart=createExtensionOperationReceiptStore({storageArea,now:()=>200});
  const duplicate=await afterRestart.receive("op-1",{call_id:"call-1"});
  assert.equal(duplicate.duplicate,true); assert.equal(duplicate.receipt.state,"received");
  await afterRestart.markStarted("op-1"); await afterRestart.markTerminal("op-1",{type:"action_call_output",output:{ok:true,private_text:"do not store me"}});
  const terminal=await first.query("op-1"); assert.equal(terminal.state,"terminal"); assert.equal(terminal.outcome.ok,true);
  assert.doesNotMatch(JSON.stringify(storageArea.data),/do not store me|private_text/);
});

test("capacity and TTL never evict received or started operations", async () => {
  let now=0; const storageArea=memoryStorage(); const store=createExtensionOperationReceiptStore({storageArea,maxReceipts:1,ttlMs:10,now:()=>now});
  await store.receive("received-active"); now=1; await store.receive("started-active"); await store.markStarted("started-active");
  now=2; await store.receive("terminal-old"); await store.markTerminal("terminal-old",{type:"action_call_output",output:{ok:true}});
  now=3; await store.receive("terminal-new"); await store.markTerminal("terminal-new",{type:"action_error",error:{code:"failed",message:"private"}});
  assert.equal((await store.query("received-active")).state,"received");
  assert.equal((await store.query("started-active")).state,"started");
  assert.equal(await store.query("terminal-old"),null);
  assert.equal((await store.query("terminal-new")).state,"terminal");
  now=100; await store.receive("trigger-gc");
  assert.equal((await store.query("received-active")).state,"received");
  assert.equal((await store.query("started-active")).state,"started");
});

test("receipt retention is bounded and excludes original request data", async () => {
  let now=0; const storageArea=memoryStorage(); const store=createExtensionOperationReceiptStore({storageArea,maxReceipts:2,ttlMs:50,now:()=>now});
  await store.receive("one",{call_id:"1",arguments:{secret:"must-not-persist"}}); await store.markTerminal("one",{type:"action_call_output",output:{ok:true}});
  now=1; await store.receive("two"); await store.markTerminal("two",{type:"action_call_output",output:{ok:true}});
  now=2; await store.receive("three"); await store.markTerminal("three",{type:"action_call_output",output:{ok:true}});
  assert.equal(await store.query("one"),null); assert.doesNotMatch(JSON.stringify(storageArea.data),/must-not-persist/);
  now=100; await store.receive("four"); assert.equal(await store.query("two"),null); assert.equal(await store.query("three"),null);
});
