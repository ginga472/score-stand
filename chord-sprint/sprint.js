"use strict";
// In the iPad app the page runs inside Piano Practice: the app records sessions and shows its own
// recording timer, and "Music" switches back to the Score Stand library.
const IN_APP=!!window.__pianoApp;
const $=id=>document.getElementById(id);
const LET="CDEFGAB",NAT=[0,2,4,5,7,9,11],ACC={"-1":"♭","0":"♮","1":"♯"};
const KEYS=[["C",0,0,0],["G",4,0,1],["F",3,0,-1],["D",1,0,2],["A",5,0,3],["E",2,0,4],["B♭",6,-1,-2],["E♭",2,-1,-3]]
  .map(([name,l,a,sig])=>({name,l,a,sig}));
const SHARP_ORDER=[3,0,4,1,5,2,6],FLAT_ORDER=[6,2,5,1,4,0,3];
const SHARP_POS=[38,35,39,36,33,37,34],FLAT_POS=[34,37,33,36,32,35,31]; // treble steps; bass is 14 lower
const ROMAN=["I","II","III","IV","V","VI","VII"],INV_NAME=["root position","1st inversion","2nd inversion"];
// Diatonic step d = octave*7 + letter. Treble bottom line E4 = 30, bass bottom line G2 = 18.
const CLEF={treble:{bottom:30,lo:28,hi:40,mid:34},bass:{bottom:18,lo:16,hi:28,mid:22}};

// ---------- settings + stats (saved through the iPad app, or localStorage in a browser) ----------
const DEF={keys:["C"],degs:[0,1,2,3,4,5],inv:true,clef:"both",exact:true,dur:60,stats:{},best:{},history:[]};
function load(){let o=null;
  try{if(typeof window.__nativeStore==="string"&&window.__nativeStore)o=JSON.parse(window.__nativeStore)}catch(e){}
  if(!o)try{o=JSON.parse(localStorage.getItem("chordSprint")||"null")}catch(e){}
  return Object.assign({},DEF,o||{})}
const S=load();
function save(){const s=JSON.stringify(S);
  try{window.webkit.messageHandlers.store.postMessage(s)}catch(e){}
  try{localStorage.setItem("chordSprint",s)}catch(e){}}

// ---------- music helpers ----------
const keyAcc=(key,l)=>key.sig>0?(SHARP_ORDER.slice(0,key.sig).includes(l)?1:0):key.sig<0?(FLAT_ORDER.slice(0,-key.sig).includes(l)?-1:0):0;
const midiOf=(d,a)=>12*(Math.floor(d/7)+1)+NAT[((d%7)+7)%7]+a;
const SP_SHARP=[[0,0],[0,1],[1,0],[1,1],[2,0],[3,0],[3,1],[4,0],[4,1],[5,0],[5,1],[6,0]];
const SP_FLAT=[[0,0],[1,-1],[1,0],[2,-1],[2,0],[3,0],[4,-1],[4,0],[5,-1],[5,0],[6,-1],[6,0]];
function spell(m,key){ // midi -> {d,a}, using the key's own spelling where possible
  const pc=m%12;let la=null;
  for(let l=0;l<7;l++){const a=keyAcc(key,l);if(((NAT[l]+a)%12+12)%12===pc){la=[l,a];break}}
  if(!la)la=(key.sig<0?SP_FLAT:SP_SHARP)[pc];
  const o=Math.round((m-NAT[la[0]]-la[1])/12)-1;return{d:o*7+la[0],a:la[1]}}
function triad(key,deg,inv,clef){
  const rl=key.l+deg,rel=[[0,2,4],[2,4,7],[4,7,9]][inv],C=CLEF[clef];
  const cands=[];for(let o=1;o<=6;o++){const ds=rel.map(r=>rl+r+7*o);if(ds[0]>=C.lo&&ds[2]<=C.hi)cands.push(ds)}
  cands.sort((a,b)=>Math.abs(a[1]-C.mid)-Math.abs(b[1]-C.mid));
  const ds=cands[0];
  const notes=ds.map(d=>{const a=keyAcc(key,((d%7)+7)%7);return{d,a,m:midiOf(d,a)}});
  const root=notes[[0,2,1][inv]],third=notes[[1,0,2][inv]],fifth=notes[[2,1,0][inv]];
  const i3=((third.m-root.m)%12+12)%12,i5=((fifth.m-root.m)%12+12)%12;
  const q=i3===4?"":i5===6?"°":"m";
  const rn=ROMAN[deg];const roman=q===""?rn:rn.toLowerCase()+(q==="°"?"°":"");
  const rootName=LET[((rl%7)+7)%7]+(root.a?ACC[root.a]:"");
  return{deg,inv,clef,notes,midis:notes.map(n=>n.m),name:rootName+q,roman,state:"todo",missed:false}}
const statKey=c=>c.name+"|"+c.inv+"|"+c.clef;
function weight(c){const st=S.stats[statKey(c)];if(!st)return 2;
  return 1+4*(st.miss/st.n)+Math.min(4,Math.max(0,st.t-1.5))}

// ---------- game ----------
const G={lines:[],cur:0,held:new Set(),phase:"ready",start:0,end:0,score:0,clean:0,chordAt:0,log:[],last:null,raf:0};
function pickKey(){const ks=KEYS.filter(k=>S.keys.includes(k.name));return ks[Math.floor(Math.random()*ks.length)]||KEYS[0]}
function newLine(){
  const key=pickKey(),chords=[];
  const clefs=S.clef==="both"?["bass","treble"]:[S.clef],invs=S.inv?[0,1,2]:[0];
  const pool=[];
  S.degs.forEach(deg=>invs.forEach(inv=>clefs.forEach(clef=>{const c=triad(key,deg,inv,clef);
    pool.push({c,w:weight(c)*(S.clef==="both"&&clef==="bass"?1.5:1)})})));
  for(let i=0;i<4;i++){
    const prev=chords[i-1]||G.last;
    const opts=pool.filter(p=>!prev||statKey(p.c)!==statKey(prev)||pool.length<2);
    let r=Math.random()*opts.reduce((s,p)=>s+p.w,0),pick=opts[0];
    for(const p of opts){r-=p.w;if(r<=0){pick=p;break}}
    chords.push(Object.assign({},pick.c,{notes:pick.c.notes.map(n=>({...n}))}));
  }
  G.last=chords[3];
  return{key,chords}}
function reset(){
  G.lines=[newLine(),newLine()];G.cur=0;G.phase="ready";G.score=0;G.clean=0;G.log=[];G.held.clear();
  G.lines[0].chords[0].state="cur";
  cancelAnimationFrame(G.raf);tick();render()}
const curChord=()=>G.lines[0].chords[G.cur];

function noteOn(m){
  if(R.on){R.notes++;R.last=Date.now()}
  if(!$("session").hidden)return;
  if(!$("settings").hidden||!$("results").hidden||!$("history").hidden)return;
  G.held.add(m);
  if(G.phase==="ready")beginRound();
  if(G.phase!=="play")return;
  evaluate();render()}
function noteOff(m){G.held.delete(m);if(G.phase!=="over")render()}
function evaluate(){
  const c=curChord(),held=[...G.held];let wrong,ok;
  if(S.exact){wrong=held.some(m=>!c.midis.includes(m));ok=!wrong&&c.midis.every(m=>G.held.has(m))}
  else{const pcs=new Set(c.midis.map(m=>m%12));wrong=held.some(m=>!pcs.has(m%12));ok=!wrong&&[...pcs].every(p=>held.some(m=>m%12===p))}
  if(wrong&&!c.missed){c.missed=true;const s=$("sheet");s.classList.remove("shake");void s.offsetWidth;s.classList.add("shake")}
  if(ok)complete(false)}
function beginRound(){
  G.phase="play";G.start=performance.now();G.end=S.dur?G.start+S.dur*1000:0;G.chordAt=G.start;tick();
  nat("marker",{k:"round_start",keys:S.keys,degs:S.degs,inv:S.inv,clef:S.clef,exact:S.exact,dur:S.dur})}
function complete(skipped){
  const c=curChord(),now=performance.now(),t=Math.min(15,(now-G.chordAt)/1000);
  nat("marker",{k:"chord",name:c.name,roman:c.roman,key:(c.key||G.lines[0].key).name,inv:c.inv,clef:c.clef,midis:c.midis,sec:+((now-G.chordAt)/1000).toFixed(2),missed:c.missed||skipped,skipped});
  c.state=skipped?"skipped":"ok";if(skipped)c.missed=true;
  if(!skipped){G.score++;if(!c.missed)G.clean++}
  G.log.push({c,t,skipped});
  const k=statKey(c),st=S.stats[k]||{n:0,miss:0,t};
  st.n++;st.miss+=c.missed?1:0;st.t=st.n===1?t:.7*st.t+.3*t;S.stats[k]=st;
  G.chordAt=now;G.cur++;
  if(G.cur>=4){G.lines=[G.lines[1],newLine()];G.cur=0}
  curChord().state="cur";
  render()}
function tick(){
  cancelAnimationFrame(G.raf);
  let left=S.dur;
  if(G.phase==="play"&&S.dur){left=Math.max(0,(G.end-performance.now())/1000);if(left<=0){finish();return}}
  $("time").textContent=S.dur?Math.ceil(left):"∞";
  $("timebar").style.transform="scaleX("+(S.dur?left/S.dur:1)+")";
  if(G.phase==="play")G.raf=requestAnimationFrame(tick)}
function finish(){
  if(G.phase==="play")nat("marker",{k:"round_end",score:G.score,clean:G.clean});
  G.phase="over";cancelAnimationFrame(G.raf);$("time").textContent=S.dur?"0":"∞";$("timebar").style.transform="scaleX(0)";save();
  const done=G.log.filter(l=>!l.skipped);
  const elapsed=((S.dur?S.dur*1000:performance.now()-G.start)/1000);
  $("r-title").textContent=S.dur?"Time!":"Round finished";
  $("r-score").textContent=G.score;
  $("r-avg").textContent=G.score?(elapsed/G.score).toFixed(1):"–";
  $("r-acc").textContent=G.score?Math.round(100*G.clean/G.score)+"%":"–";
  const bk=[S.keys.slice().sort().join(""),S.degs.join(""),S.inv,S.clef,S.exact,S.dur].join("|");
  const prev=S.best[bk];
  if(G.score)S.history.push({t:Date.now(),n:G.score,spc:+(elapsed/G.score).toFixed(2),acc:+(G.clean/G.score).toFixed(2),
    dur:S.dur,keys:S.keys.slice(),clef:S.clef,inv:S.inv,exact:S.exact});
  if(S.history.length>3000)S.history=S.history.slice(-3000);
  if(S.dur){if(!prev||G.score>prev)S.best[bk]=G.score;
    $("r-best").textContent=!prev?"First round with these settings.":G.score>prev?"New best! Previous best was "+prev+".":"Best with these settings: "+prev+"."}
  else $("r-best").textContent="";
  save();
  const seen=new Set(),slow=G.log.slice().sort((a,b)=>(b.skipped-a.skipped)||(b.c.missed-a.c.missed)||(b.t-a.t))
    .filter(l=>{const k=statKey(l.c);if(seen.has(k))return false;seen.add(k);return true}).slice(0,3);
  $("r-slowwrap").hidden=!slow.length;
  $("r-slow").innerHTML=slow.map(l=>'<figure>'+miniSVG(l.c)+'<figcaption><b>'+l.c.name+'</b> · '+INV_NAME[l.c.inv]+'<br>'+(l.skipped?"skipped":l.t.toFixed(1)+" s"+(l.c.missed?", wrong note first":""))+'</figcaption></figure>').join("");
  $("results").hidden=false}

// ---------- drawing ----------
const W=1000,X0=150,BW=(W-10-X0)/4,TT=70,BT=TT+48+90,H=BT+48+80,SP=6;
const yT=d=>TT+48-(d-30)*SP,yB=d=>BT+48-(d-18)*SP;
const yOf=(clef,d)=>clef==="treble"?yT(d):yB(d);
function ledgers(clef,d,x,cls){const b=CLEF[clef].bottom;let s="";
  for(let l=b-2;l>=d;l-=2)s+='<line class="'+(cls||"")+'" x1="'+(x-17)+'" x2="'+(x+17)+'" y1="'+yOf(clef,l)+'" y2="'+yOf(clef,l)+'"/>';
  for(let l=b+10;l<=d;l+=2)s+='<line class="'+(cls||"")+'" x1="'+(x-17)+'" x2="'+(x+17)+'" y1="'+yOf(clef,l)+'" y2="'+yOf(clef,l)+'"/>';
  return s}
function head(x,y){return '<ellipse class="hd" cx="'+x+'" cy="'+y+'" rx="10.5" ry="7"/><ellipse class="hole" cx="'+x+'" cy="'+y+'" rx="5" ry="3.6" transform="rotate(-40 '+x+' '+y+')"/>'}
function keySig(key,y0fn,shift,x){let s="";const n=Math.abs(key.sig),pos=key.sig>0?SHARP_POS:FLAT_POS;
  for(let i=0;i<n;i++){const y=y0fn(pos[i]-shift);s+='<text class="acc" x="'+(x+i*14)+'" y="'+(y+(key.sig>0?7:4))+'" font-size="26" text-anchor="middle">'+(key.sig>0?"♯":"♭")+'</text>'}return s}
function staffLines(x1,x2){let s="";for(let i=0;i<5;i++){s+='<line x1="'+x1+'" x2="'+x2+'" y1="'+(TT+i*12)+'" y2="'+(TT+i*12)+'"/>';s+='<line x1="'+x1+'" x2="'+x2+'" y1="'+(BT+i*12)+'" y2="'+(BT+i*12)+'"/>'}return s}
function systemSVG(line,isCur){
  const c0=isCur?G.cur:-1;let s='<svg viewBox="0 0 '+W+' '+H+'" class="'+(isCur?"":"next")+'" role="img" aria-label="Line of chords in '+line.key.name+' major">';
  line.chords.forEach((c,i)=>{if(i===c0)s+='<rect class="'+(c.missed?"badbar":"curbar")+'" x="'+(X0+i*BW+2)+'" y="'+(TT-40)+'" width="'+(BW-4)+'" height="'+(BT+48+40-TT+40)+'" rx="10"/>'});
  s+=staffLines(20,W-10);
  s+='<line class="bl" x1="20" x2="20" y1="'+TT+'" y2="'+(BT+48)+'"/>';
  s+='<text class="clef" x="26" y="'+(TT+53)+'" font-size="70">𝄞</text><text class="clef" x="28" y="'+(BT+37)+'" font-size="46">𝄢</text>';
  s+=keySig(line.key,yT,0,94)+keySig(line.key,yB,14,94);
  for(let i=1;i<=4;i++){const x=X0+i*BW;s+='<line class="'+(i===4?"bl":"bl")+'" x1="'+x+'" x2="'+x+'" y1="'+TT+'" y2="'+(BT+48)+'"/>'}
  line.chords.forEach((c,i)=>{
    const x=X0+i*BW+BW/2,cls=c.state==="ok"?"ok":(i===c0?"":"");
    s+='<g class="'+cls+'">';
    c.notes.forEach(n=>{const held=i===c0&&G.held.has(n.m)||(i===c0&&!S.exact&&[...G.held].some(m=>m%12===n.m%12));
      s+='<g class="'+(held?"held":"")+'">'+ledgers(c.clef,n.d,x)+head(x,yOf(c.clef,n.d))+'</g>'});
    s+='</g>';
    if(c.state==="ok"||c.state==="skipped")s+='<text class="'+(c.state==="skipped"?"name skip":"name")+'" x="'+x+'" y="'+(BT+48+46)+'"'+'>'+c.name+'</text><text class="roman" x="'+x+'" y="'+(BT+48+68)+'">'+c.roman+'</text>';
    if(i===c0){ // wrong notes currently held, drawn just right of the chord
      const tgt=S.exact?new Set(c.midis):null,pcs=new Set(c.midis.map(m=>m%12));
      [...G.held].filter(m=>S.exact?!tgt.has(m):!pcs.has(m%12)).forEach(m=>{
        const sp=spell(m,line.key),C=CLEF[c.clef];
        const clef=(sp.d>=C.lo-5&&sp.d<=C.hi+5)?c.clef:(m>=60?"treble":"bass"),wx=x+36,y=yOf(clef,sp.d);
        s+='<g class="wrong">'+ledgers(clef,sp.d,wx,"")+head(wx,y)+(sp.a!==keyAcc(line.key,((sp.d%7)+7)%7)?'<text class="acc" x="'+(wx+20)+'" y="'+(y+(sp.a<0?4:7))+'" font-size="24" text-anchor="middle">'+ACC[sp.a]+'</text>':'')+'</g>'})}
  });
  return s+'</svg>'}
function miniSVG(c){ // one chord on its own clef, for the results card
  const key=c.key||KEYS[0],clef=c.clef,w=220,h=170,top=50,b=CLEF[clef].bottom,y=d=>top+48-(d-b)*SP;
  let s='<svg viewBox="0 0 '+w+' '+h+'">';
  for(let i=0;i<5;i++)s+='<line x1="6" x2="'+(w-6)+'" y1="'+(top+i*12)+'" y2="'+(top+i*12)+'"/>';
  s+=clef==="treble"?'<text class="clef" x="10" y="'+(top+53)+'" font-size="70">𝄞</text>':'<text class="clef" x="12" y="'+(top+37)+'" font-size="46">𝄢</text>';
  const n=Math.abs(key.sig),pos=key.sig>0?SHARP_POS:FLAT_POS,shift=clef==="bass"?14:0;
  for(let i=0;i<n;i++)s+='<text class="acc" x="'+(72+i*14)+'" y="'+(y(pos[i]-shift)+(key.sig>0?7:4))+'" font-size="26" text-anchor="middle">'+(key.sig>0?"♯":"♭")+'</text>';
  const x=160;
  c.notes.forEach(nn=>{for(let l=b-2;l>=nn.d;l-=2)s+='<line x1="'+(x-17)+'" x2="'+(x+17)+'" y1="'+y(l)+'" y2="'+y(l)+'"/>';
    for(let l=b+10;l<=nn.d;l+=2)s+='<line x1="'+(x-17)+'" x2="'+(x+17)+'" y1="'+y(l)+'" y2="'+y(l)+'"/>';s+=head(x,y(nn.d))});
  return s+'</svg>'}
function render(){
  G.lines.forEach(l=>l.chords.forEach(c=>c.key=l.key));
  $("sheet").innerHTML=systemSVG(G.lines[0],true)+systemSVG(G.lines[1],false);
  $("score").textContent=G.score;
  const k=G.lines[0].key;
  $("keyline").textContent=k.name+" major"+(k.sig?" · "+Math.abs(k.sig)+(k.sig>0?" sharp":" flat")+(Math.abs(k.sig)>1?"s":""):"")+" · "+(S.exact?"exact notes":"any octave");
  $("status").innerHTML=G.phase==="ready"?(midiReady?"<b>Play the first chord to start the clock</b>":"<b>Plug in the piano to start</b>"):
    G.phase==="play"&&!S.dur?"Untimed":"";
  $("finish").hidden=!(G.phase==="play"&&!S.dur);
}

// ---------- MIDI input ----------
let midiReady=false;
window.midiIn=function(st,d1,d2){const t=st&0xf0;
  if(t===0x90&&d2>0)noteOn(d1);else if(t===0x80||(t===0x90&&d2===0))noteOff(d1)};
window.midiDevices=function(names){midiReady=names.length>0;
  $("dot").classList.toggle("on",midiReady);$("devname").textContent=midiReady?names.join(", "):"No piano";render()};
if(!window.webkit?.messageHandlers?.store&&navigator.requestMIDIAccess){
  navigator.requestMIDIAccess().then(acc=>{const hook=()=>{const names=[];
      acc.inputs.forEach(inp=>{inp.onmidimessage=e=>window.midiIn(e.data[0],e.data[1],e.data[2]);if(inp.state==="connected")names.push(inp.name)});
      window.midiDevices(names)};
    acc.onstatechange=hook;hook()}).catch(()=>{});
}

// ---------- settings UI ----------
function chips(id,opts,isOn,onTap){$(id).innerHTML=opts.map(([v,l])=>'<button data-v="'+v+'" aria-pressed="'+isOn(v)+'">'+l+'</button>').join("");
  $(id).querySelectorAll("button").forEach(b=>b.onclick=()=>{onTap(b.dataset.v);drawSettings()})}
function toggle(arr,v){const i=arr.indexOf(v);if(i>=0){if(arr.length>1)arr.splice(i,1)}else arr.push(v)}
function drawSettings(){
  chips("o-keys",KEYS.map(k=>[k.name,k.name]),v=>S.keys.includes(v),v=>toggle(S.keys,v));
  chips("o-degs",ROMAN.map((r,i)=>[i,["I","ii","iii","IV","V","vi","vii°"][i]]),v=>S.degs.includes(+v),v=>toggle(S.degs,+v));
  chips("o-inv",[["0","Root position only"],["1","All inversions"]],v=>S.inv===(v==="1"),v=>S.inv=v==="1");
  chips("o-clef",[["bass","Bass"],["both","Both"],["treble","Treble"]],v=>S.clef===v,v=>S.clef=v);
  chips("o-exact",[["1","Exact octave"],["0","Any octave"]],v=>S.exact===(v==="1"),v=>S.exact=v==="1");
  chips("o-dur",[["60","1 minute"],["120","2 minutes"],["0","Untimed"]],v=>S.dur===+v,v=>S.dur=+v)}
$("finish").onclick=()=>finish();
$("gear").onclick=()=>{drawSettings();$("settings").hidden=false};
$("o-done").onclick=()=>{$("settings").hidden=true;S.degs.sort();save();reset()};
$("r-again").onclick=()=>{$("results").hidden=true;reset()};
$("histbtn").onclick=()=>{if(G.phase==="play")return;drawHistory();$("history").hidden=false};
$("r-hist").onclick=()=>{$("results").hidden=true;drawHistory();$("history").hidden=false};
$("h-done").onclick=()=>{$("history").hidden=true;if(G.phase==="over")reset()};
function drawHistory(){
  const H=S.history||[];
  if(!H.length){$("h-body").innerHTML='<p class="hint">No rounds yet. Finish a round and it shows up here.</p>';return}
  // daily summary: average seconds per chord and total chords, last 30 practice days
  const days=new Map();H.forEach(r=>{const d=new Date(r.t),k=d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate();
    const e=days.get(k)||{date:d,n:0,secs:0,clean:0,rounds:0};e.n+=r.n;e.secs+=r.spc*r.n;e.clean+=r.acc*r.n;e.rounds++;days.set(k,e)});
  const ds=[...days.values()].slice(-30),w=600,h=220,L=44,R=12,T=14,B=34;
  const ys=ds.map(d=>d.secs/d.n),max=Math.max(2,Math.ceil(Math.max(...ys))),x=i=>L+(ds.length<2?(w-L-R)/2:i*(w-L-R)/(ds.length-1)),y=v=>T+(1-v/max)*(h-T-B);
  let svg='<svg viewBox="0 0 '+w+' '+h+'">';
  for(let v=0;v<=max;v+=max>8?2:1)svg+='<line class="grid" x1="'+L+'" x2="'+(w-R)+'" y1="'+y(v)+'" y2="'+y(v)+'"/><text class="ax" x="'+(L-8)+'" y="'+(y(v)+4)+'" text-anchor="end">'+v+'s</text>';
  const fmt=d=>d.toLocaleDateString(undefined,{month:"short",day:"numeric"});
  svg+='<text class="ax" x="'+x(0)+'" y="'+(h-10)+'" text-anchor="'+(ds.length<2?"middle":"start")+'">'+fmt(ds[0].date)+'</text>';
  if(ds.length>1)svg+='<text class="ax" x="'+x(ds.length-1)+'" y="'+(h-10)+'" text-anchor="end">'+fmt(ds[ds.length-1].date)+'</text>';
  svg+='<polyline points="'+ys.map((v,i)=>x(i)+","+y(v)).join(" ")+'"/>'+ys.map((v,i)=>'<circle cx="'+x(i)+'" cy="'+y(v)+'" r="4"/>').join("")+'</svg>';
  const rows=H.slice(-25).reverse().map(r=>{const d=new Date(r.t);
    return '<tr><td>'+fmt(d)+' '+d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})+'</td><td>'+r.n+'</td><td>'+r.spc.toFixed(1)+'s</td><td>'+Math.round(r.acc*100)+'%</td><td>'+r.keys.join(" ")+' · '+r.clef+(r.inv?"":" · root only")+(r.exact?"":" · any 8ve")+' · '+(r.dur?r.dur/60+" min":"untimed")+'</td></tr>'}).join("");
  $("h-body").innerHTML='<div class="row"><span class="lbl">Seconds per chord, by day (lower is better)</span>'+svg+'</div>'+
    '<p class="hint">'+H.length+' rounds · '+H.reduce((s,r)=>s+r.n,0)+' chords played over '+days.size+' day'+(days.size>1?"s":"")+'</p>'+
    '<table><thead><tr><th>When</th><th>Chords</th><th>Each</th><th>First try</th><th>Settings</th></tr></thead><tbody>'+rows+'</tbody></table>'}
$("r-settings").onclick=()=>{$("results").hidden=true;drawSettings();$("settings").hidden=false};
$("skip").onclick=()=>{if(G.phase==="ready")beginRound();
  if(G.phase==="play")complete(true)};
// ---------- practice session recording (handled by the iPad app; the page only shows state) ----------
const R={on:false,startMs:0,notes:0,last:0,sessions:[],delArm:null};
function nat(cmd,payload){try{window.webkit.messageHandlers.session.postMessage(Object.assign({cmd},payload||{}));return true}catch(e){return false}}
const hasNative=()=>!!(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.session);
const clock=ms=>{const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor(s/60)%60,ss=String(s%60).padStart(2,"0");return h?h+":"+String(m).padStart(2,"0")+":"+ss:m+":"+ss};
window.sessionState=function(st){
  if(st.event==="started"){R.notes=0;R.last=Date.now()}
  R.on=!!st.recording;R.startMs=st.startedMs||0;if(st.sessions)R.sessions=st.sessions;drawSession()};
function drawSession(){
  $("rec").hidden=!R.on||IN_APP;$("sessbtn").hidden=R.on&&!IN_APP;
  $("rectext").textContent=R.on?clock(Date.now()-R.startMs)+" · "+R.notes+" notes":"";
  const t=$("s-toggle");t.textContent=R.on?"Stop & save":"Start recording";t.className=R.on?"big-btn stop":"primary big-btn";$("s-now").textContent=R.on?"Recording · "+clock(Date.now()-R.startMs)+" · "+R.notes+" notes":"";t.disabled=!hasNative();
  if(!hasNative())$("s-hint").textContent="Recording works in the iPad app.";
  if(!R.sessions.length){$("s-list").innerHTML='<p class="hint">No saved sessions yet.</p>';return}
  $("s-list").innerHTML='<table><thead><tr><th>When</th><th>Length</th><th>Playing</th><th>Notes</th><th></th></tr></thead><tbody>'+
    R.sessions.map(x=>{const d=new Date(x.started);
      return '<tr><td>'+d.toLocaleDateString(undefined,{month:"short",day:"numeric"})+' '+d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})+'</td><td>'+clock(x.durationMs)+'</td><td>'+clock(x.playingMs)+'</td><td>'+x.notes+'</td><td><button data-share="'+x.name+'">Share</button> <button data-del="'+x.name+'">'+(R.delArm===x.name?"Tap to confirm":"Delete")+'</button></td></tr>'}).join("")+'</tbody></table>';
  $("s-list").querySelectorAll("[data-share]").forEach(b=>b.onclick=()=>nat("share",{name:b.dataset.share}));
  $("s-list").querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{const n=b.dataset.del;
    if(R.delArm===n){R.delArm=null;nat("delete",{name:n})}else{R.delArm=n;drawSession()}})}
$("sessbtn").onclick=$("rec").onclick=()=>{R.delArm=null;nat("list");drawSession();$("session").hidden=false};
$("s-done").onclick=()=>{$("session").hidden=true};
$("s-toggle").onclick=()=>{nat(R.on?"stop":"start")};
setInterval(()=>{if(!R.on)return;
  if(Date.now()-R.last>20*60e3){nat("marker",{k:"auto_stop_silence"});nat("stop");return} // 20 quiet minutes ends the session
  $("rectext").textContent=clock(Date.now()-R.startMs)+" · "+R.notes+" notes";
  $("s-now").textContent="Recording · "+$("rectext").textContent},1000);
if(IN_APP){$("musicbtn").hidden=false;$("musicbtn").onclick=()=>{try{window.webkit.messageHandlers.nav.postMessage({to:"music"})}catch(e){}}}
reset();
