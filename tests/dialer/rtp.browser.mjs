// Two local WebRTC peers exchange generated tones. No microphone, PSTN, Telnyx,
// external ICE servers or production APIs are used.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from 'playwright';
const script=ts.transpileModule(readFileSync('lib/dialer/rtp.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
try {
 const page=await browser.newPage(); await page.route('**/*',r=>r.abort());
 await page.addScriptTag({type:'module',content:script+'\nwindow.audioRtp=audioRtp;'});
 await page.waitForFunction(()=>Boolean(window.audioRtp));
 await page.evaluate(async()=>{
  const context=new AudioContext();await context.resume();
  const left=new RTCPeerConnection({iceServers:[]}),right=new RTCPeerConnection({iceServers:[]});
  const tones=[];const players=[];const nodes=[];
  for(const [peer,frequency] of [[left,440],[right,660]]) {
   const tone=context.createOscillator(),gain=context.createGain(),out=context.createMediaStreamDestination();
   tone.frequency.value=frequency;gain.gain.value=0.01;tone.connect(gain);gain.connect(out);tone.start();tones.push(tone);nodes.push(gain,out);
   peer.addTrack(out.stream.getAudioTracks()[0],out.stream);
   peer.ontrack=e=>{const audio=document.createElement('audio');audio.autoplay=true;audio.srcObject=e.streams[0];document.body.append(audio);players.push(audio);void audio.play();};
  }
  left.onicecandidate=e=>{if(e.candidate)void right.addIceCandidate(e.candidate);};
  right.onicecandidate=e=>{if(e.candidate)void left.addIceCandidate(e.candidate);};
  await left.setLocalDescription(await left.createOffer());await right.setRemoteDescription(left.localDescription);
  await right.setLocalDescription(await right.createAnswer());await left.setRemoteDescription(right.localDescription);
  window.fixture={context,left,right,tones,players,nodes};
 });
 let result;
 for(let i=0;i<40;i++) {
  result=await page.evaluate(async()=>{const f=window.fixture;return {left:window.audioRtp(await f.left.getStats()),right:window.audioRtp(await f.right.getStats()),states:[f.left.connectionState,f.right.connectionState],context:f.context.state,playing:f.players.length===2&&f.players.every(p=>!p.paused&&p.readyState>=2)};});
  if(result.left.receivedBytes>0&&result.left.sentBytes>0&&result.right.receivedBytes>0&&result.right.sentBytes>0&&result.playing)break;
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 assert(result.left.receivedBytes>0&&result.left.sentBytes>0&&result.right.receivedBytes>0&&result.right.sentBytes>0&&result.playing,JSON.stringify(result));
 await page.evaluate(async()=>{const f=window.fixture;f.left.close();f.right.close();f.tones.forEach(t=>t.stop());await f.context.close();});
 console.log('PASS: real local WebRTC DTLS, bidirectional audio RTP and browser playback. This does not verify Telnyx or human audibility.');
} finally {await browser.close();}
