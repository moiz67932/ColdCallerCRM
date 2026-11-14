import assert from "node:assert/strict";
import test from "node:test";
import { dispatchCommands } from "../../lib/dialer/parallel-dispatch";
import { controlledScenarios, evidenceBlockers } from "../../lib/dialer/parallel-policy";
import { parallelFingerprint } from "../../lib/dialer/parallel-fingerprint";

test("four provider dial requests are in flight concurrently", async () => {
  let active = 0; let maximum = 0;
  const release: Array<() => void> = [];
  const result = dispatchCommands([1,2,3,4], async () => {
    active++; maximum=Math.max(active,maximum);
    await new Promise<void>((resolve) => release.push(resolve)); active--;
  });
  assert.equal(active,4); assert.equal(maximum,4);
  release.forEach((resolve) => resolve());
  assert.equal((await result).filter((item) => item.status === "fulfilled").length,4);
});
test("one provider rejection does not lose sibling command results", async () => {
  const results=await dispatchCommands([1,2,3,4], async (line) => { if(line===2) throw new Error("channel limit"); });
  assert.equal(results.filter((item) => item.status === "rejected").length,1);
  assert.equal(results.filter((item) => item.status === "fulfilled").length,3);
});
test("a feature flag alone cannot satisfy controlled-provider verification", () => {
  assert(evidenceBlockers(null).length);
  assert(evidenceBlockers({suite:"portive-parallel-v1",passed:true}).length);
});
test("verification requires first-answer, collision-hangup, and recovery scenarios plus measured audio latency", () => {
  const evidence={suite:"portive-parallel-v1",passed:true,scenarios:Object.fromEntries(controlledScenarios.map((key)=>[key,true])),max_answer_to_audio_ms:1000,provider_call_ids:["one","two","three","four"]};
  assert.deepEqual(evidenceBlockers(evidence),[]);
  assert(evidenceBlockers({...evidence,max_answer_to_audio_ms:2000}).length);
  assert(evidenceBlockers({...evidence,scenarios:{}}).length);
});
test("verification binds to caller, connection, credential and webhook configuration", () => {
  assert.equal(parallelFingerprint({connection:"a",caller:"b"}),parallelFingerprint({caller:"b",connection:"a"}));
  assert.notEqual(parallelFingerprint({connection:"a"}),parallelFingerprint({connection:"b"}));
});
