// @ts-nocheck -- numeric DSP ported from the single-file prototype; typed loosely on purpose.
/**
 * Instant mode: a zero-model, low-latency (~0.2 s) instrument splitter.
 *  - drums: harmonic/percussive separation (median filtering across time vs. across frequency)
 *  - vocals: the singer's pitch (harmonic comb, found by harmonic summation over centred tones),
 *            or everything centred in the stereo mix
 *  - bass: steady tones below 150 Hz;  other: the remaining steady tones
 * Optional clean-up passes chain more instances that re-apply the vocal comb anywhere in the mix,
 * using the pitch relayed from the first instance (lag = latency of one instance, in frames).
 * Stems order on the port: [vocals, drums, bass, other].
 */

const N=4096,HOP=1024,NB=N/2+1,L=9,D=4,M=16384,FW=16;
function med(a,n){for(let i=1;i<n;i++){const x=a[i];let j=i-1;while(j>=0&&a[j]>x){a[j+1]=a[j];j--}a[j+1]=x}return a[n>>1]}
class Kara extends AudioWorkletProcessor{
 constructor(){super();this.iL=new Float32Array(N);this.iR=new Float32Array(N);this.out=[new Float32Array(M),new Float32Array(M)];
  this.n=0;this.w=new Float32Array(N);for(let i=0;i<N;i++)this.w[i]=.5-.5*Math.cos(2*Math.PI*i/N);
  this.G=new Float32Array(NB).fill(1);this.aR=new Float32Array(N);this.aI=new Float32Array(N);this.bR=new Float32Array(N);this.bI=new Float32Array(N);
  this.rev=new Uint32Array(N);const bits=Math.log2(N);for(let i=0;i<N;i++){let r=0;for(let b=0;b<bits;b++)r|=((i>>b)&1)<<(bits-1-b);this.rev[i]=r}
  this.cs=new Float32Array(N/2);this.sn=new Float32Array(N/2);for(let i=0;i<N/2;i++){this.cs[i]=Math.cos(-2*Math.PI*i/N);this.sn[i]=Math.sin(-2*Math.PI*i/N)}
  const mk=()=>Array.from({length:L},()=>new Float32Array(NB));this.rAR=mk();this.rAI=mk();this.rBR=mk();this.rBI=mk();this.rM=mk();this.ri=0;
  this.tmp=new Float32Array(2*FW+1);this.Hm=new Float32Array(NB);
  this.kb=Math.round(150/sampleRate*N);
  this.mHa=new Float32Array(NB);this.tca=new Float32Array(NB);this.V=new Float32Array(NB);this.comb=new Float32Array(NB);this.Pk=new Float32Array(NB);
  this.cand=[];for(let f=80;f<=1000;f*=Math.pow(2,1/48))this.cand.push(f);this.nC=this.cand.length;
  this.hw=[0];for(let h=1;h<=10;h++)this.hw.push(Math.pow(.86,h-1));this.vth=.06;this.lag=0;this.extP=0;this.ph=new Float32Array(64);this.pf=0;this.hold=0;this.pitchAcc=0;this.vmode=0;this.kv=Math.round(8000/sampleRate*N);
  this.mode=new Uint8Array(NB);this.on=[1,1,1,1];this.cur=[1,1,1,1];this.acc=[0,0,0,0];this.fc=0;
  this.port.onmessage=e=>{const d=e.data;if(d.modes)this.mode.set(d.modes);if(d.stems)this.on=d.stems.slice();if(d.vmode!=null)this.vmode=d.vmode;if(d.lag!=null)this.lag=d.lag;if(d.p!=null)this.extP=d.p}}
 fft(re,im,inv){const rev=this.rev;for(let i=0;i<N;i++){const j=rev[i];if(j>i){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t}}
  for(let size=2;size<=N;size<<=1){const h=size>>1,step=N/size;for(let i=0;i<N;i+=size)for(let j=0;j<h;j++){const k=j*step,wr=this.cs[k],wi=inv?-this.sn[k]:this.sn[k],a=i+j,b=a+h;
   const tr=re[b]*wr-im[b]*wi,ti=re[b]*wi+im[b]*wr;re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti}}}
 frame(){const{iL,iR,w,aR,aI,bR,bI,G,n}=this,p=n%N;
  for(let j=0;j<N;j++){const q=(p+j)%N;aR[j]=iL[q]*w[j];aI[j]=0;bR[j]=iR[q]*w[j];bI[j]=0}
  this.fft(aR,aI,false);this.fft(bR,bI,false);
  // store this frame, then work on the frame D hops back so the time median can see the future too
  const ri=this.ri;this.rAR[ri].set(aR.subarray(0,NB));this.rAI[ri].set(aI.subarray(0,NB));this.rBR[ri].set(bR.subarray(0,NB));this.rBI[ri].set(bI.subarray(0,NB));
  const mg=this.rM[ri];for(let k=0;k<NB;k++)mg[k]=Math.hypot(aR[k],aI[k])+Math.hypot(bR[k],bI[k]);
  this.ri=(ri+1)%L;const ti=(ri-D+L)%L,TM=this.rM[ti],tmp=this.tmp;
  for(let k=0;k<NB;k++){for(let f=0;f<L;f++)tmp[f]=this.rM[f][k];this.Hm[k]=med(tmp,L)}
  for(let i=0;i<4;i++)this.cur[i]+=(this.on[i]-this.cur[i])*.25;
  const[cv,cd,cb,co]=this.cur,A=this.acc;
  const tAR=this.rAR[ti],tAI=this.rAI[ti],tBR=this.rBR[ti],tBI=this.rBI[ti];
  // pass 1: drum/tone split (mH) and how centred each slice is (tc)
  const mHa=this.mHa,tca=this.tca,V=this.V;
  for(let k=0;k<NB;k++){
   let c=0;for(let f=-FW;f<=FW;f++){const kk=k+f;tmp[c++]=kk<0||kk>=NB?0:TM[kk]}const P=med(tmp,c),H=this.Hm[k];
   const mH=H*H/(H*H+P*P+1e-12);
   const xr=tAR[k],xi=tAI[k],yr=tBR[k],yi=tBI[k],pl=xr*xr+xi*xi,pr=yr*yr+yi*yi,cr=xr*yr+xi*yi;
   const sim=2*cr/(pl+pr+1e-12),t0=Math.min(1,Math.max(0,(sim-.55)/.4));
   mHa[k]=mH;tca[k]=t0*t0*(3-2*t0);V[k]=this.vmode===2?mH*TM[k]:mH*tca[k]*TM[k]}
  const Pk=this.Pk;for(let k=0;k<NB;k++)Pk[k]=k>0&&k<NB-1&&V[k]>=V[k-1]&&V[k]>V[k+1]?V[k]:0;
  // pass 2: find the singer's note by harmonic summation over the centred tones
  const bh=sampleRate/N,comb=this.comb;comb.fill(0);let best=0,bf=0,tot=0;
  for(let k=Math.round(80/bh);k<Math.round(5000/bh);k++)tot+=V[k];
  for(let ci=0;ci<this.nC;ci++){const f0=this.cand[ci];let sc=0;
   for(let h=1;h<=10;h++){const x=h*f0/bh;if(x>=NB-2)break;const i=Math.round(x);sc+=this.hw[h]*Math.max(Pk[i-1],Pk[i],Pk[i+1])}
   if(sc>best){best=sc;bf=f0}}
  const conf=tot>0?best/tot:0;let voiced=conf>this.vth&&tot>1e-3;
  this.ph[this.fc&63]=this.extP;if(this.lag>0){bf=this.ph[(this.fc-this.lag)&63];voiced=bf>0}
  if(voiced&&this.pf>0&&Math.abs(Math.log2(bf/this.pf))>.9&&this.hold<2){this.hold++;bf=this.pf}else this.hold=0;
  this.pf=voiced?bf:0;
  if(voiced){for(let h=1;h<=40;h++){const fc=h*bf;if(fc>9000)break;const x=fc/bh,core=Math.max(1.5,fc*.02/bh);
   for(let i=Math.max(0,Math.floor(x-core-2));i<=Math.min(NB-1,Math.ceil(x+core+2));i++){const d=Math.max(0,Math.abs(i-x)-core)/.6;comb[i]=Math.max(comb[i],Math.exp(-d*d))}}}
  this.pitchAcc=voiced?bf:0;if(this.lag===0)this.port.postMessage({p:this.pitchAcc});
  // pass 3: per-slice gain from the instrument switches
  const pitchMode=this.vmode!==1,anyPos=this.vmode===2;
  for(let k=0;k<NB;k++){
   const mH=mHa[k],mP=1-mH,t=tca[k],xr=tAR[k],xi=tAI[k],yr=tBR[k],yi=tBI[k],pw=(xr*xr+xi*xi+yr*yr+yi*yi)/2;
   const fb=k<this.kb?mH:0,fv=k>=this.kb&&k<this.kv?(anyPos?mH*comb[k]:pitchMode?mH*comb[k]*(.3+.7*t):mH*t):0,fo=Math.max(0,mH-fb-fv);
   A[0]+=pw*fv;A[1]+=pw*mP;A[2]+=pw*fb;A[3]+=pw*fo;
   let g=cd*mP+cb*fb+cv*fv+co*fo;const md=this.mode[k];if(md===2)g=0;else if(md===1)g*=1-t;
   G[k]+=(g-G[k])*(g<G[k]?.7:.4);g=G[k];
   aR[k]=xr*g;aI[k]=xi*g;bR[k]=yr*g;bI[k]=yi*g;if(k>0&&k<N/2){const m=N-k;aR[m]=aR[k];aI[m]=-aI[k];bR[m]=bR[k];bI[m]=-bI[k]}}
  if(++this.fc%4===0){this.port.postMessage({lv:A.map(x=>10*Math.log10(x/4+1e-12)),f0:this.pitchAcc});A.fill(0)}
  this.fft(aR,aI,true);this.fft(bR,bI,true);const s=1/(N*1.5),o0=this.out[0],o1=this.out[1];
  for(let j=0;j<N;j++){const q=(n+HOP+j)%M;o0[q]+=aR[j]*w[j]*s;o1[q]+=bR[j]*w[j]*s}}
 process(ins,outs){const i=ins[0],o=outs[0];if(!o||!o[0])return true;const Lc=i&&i[0],Rc=i&&(i[1]||i[0]),len=o[0].length,o0=this.out[0],o1=this.out[1];
  for(let k=0;k<len;k++){const n=this.n,q=n%M;this.iL[n%N]=Lc?Lc[k]:0;this.iR[n%N]=Rc?Rc[k]:0;o[0][k]=o0[q];if(o[1])o[1][k]=o1[q];o0[q]=0;o1[q]=0;
   this.n=n+1;if(this.n%HOP===0)this.frame()}
  return true}}
registerProcessor('inmusic-instant',Kara);
