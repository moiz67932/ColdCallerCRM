"use client";
import {useEffect,useRef,useState} from 'react';
import type {ParallelAttempt} from '@/lib/dialer/types';
export function ParallelRingCue({attempts,winner}:{attempts:ParallelAttempt[];winner?:string|null}){
 const [enabled,setEnabled]=useState(false);
 const cue=useRef<{context:AudioContext;gain:GainNode;tones:OscillatorNode[]}|null>(null);
 const ringing=!winner&&attempts.some(a=>!a.ended_at&&(a.technical_state==='ringing'||a.technical_state==='initiating'));
 useEffect(()=>{
  function update(){if(cue.current)cue.current.gain.gain.value=enabled&&ringing&&Date.now()%6000<2000?0.025:0;}
  update();const timer=setInterval(update,100);return()=>{clearInterval(timer);if(cue.current)cue.current.gain.gain.value=0;};
 },[enabled,ringing]);
 useEffect(()=>()=>{const c=cue.current;cue.current=null;c?.tones.forEach(t=>t.stop());void c?.context.close();},[]);
 return <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={e=>{
  if(e.target.checked&&!cue.current){const context=new AudioContext(),gain=context.createGain();gain.gain.value=0;gain.connect(context.destination);
   const tones=[440,480].map(f=>{const t=context.createOscillator();t.frequency.value=f;t.connect(gain);t.start();return t;});cue.current={context,gain,tones};}
  if(e.target.checked)void cue.current?.context.resume().catch(()=>setEnabled(false));setEnabled(e.target.checked);
 }}/> Play local dialing tone (simulated; not carrier audio)</label>;
}
