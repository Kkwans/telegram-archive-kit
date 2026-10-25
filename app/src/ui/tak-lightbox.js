/* TAK v9.9.6 parent-owned media viewer. The chat iframe is never resized or hidden. */
(()=>{'use strict';
  const $=(s,r=document)=>r.querySelector(s);
  const state={items:[],index:0,filter:'all',generation:0,timer:0,visible:false,zoom:1,x:0,y:0,drag:null,preloads:new Map(),focus:null,ratio:0,box:null};
  const icon=(path)=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  const el=document.createElement('div');el.className='tak-global-lightbox';el.hidden=true;el.tabIndex=-1;el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-label','媒体查看器');
  el.innerHTML=`<div class="tak-lb-shade" data-close></div><div class="tak-lb-filters" role="group" aria-label="媒体筛选"><button data-filter="all">全部</button><button data-filter="image">图片</button><button data-filter="video">视频</button></div><button class="tak-lb-close" data-close aria-label="关闭灯箱" title="关闭 (Esc)">${icon('M18 6 6 18M6 6l12 12')}</button><button class="tak-lb-arrow tak-lb-prev" data-prev aria-label="上一项" title="上一项 (←)">${icon('m15 18-6-6 6-6')}</button><div class="tak-lb-stage" data-stage><div class="tak-lb-content" data-content></div><div class="tak-lb-wait" data-wait aria-hidden="true"><span class="tak-lb-spinner"></span></div><div class="tak-lb-error" data-error hidden>媒体加载失败。可以尝试打开原文件。</div></div><button class="tak-lb-arrow tak-lb-next" data-next aria-label="下一项" title="下一项 (→)">${icon('m9 18 6-6-6-6')}</button><div class="tak-lb-counter"><span data-counter></span><a data-source target="_blank" rel="noopener" title="在新标签页打开原文件">打开原文件 ↗</a></div>`;
  document.body.appendChild(el);
  const content=$('[data-content]',el),wait=$('[data-wait]',el),error=$('[data-error]',el),stage=$('[data-stage]',el),source=$('[data-source]',el);
  const filtered=()=>state.filter==='all'?state.items:state.items.filter(m=>m.type===state.filter);
  const current=()=>filtered()[state.index];
  const clearTimer=()=>{clearTimeout(state.timer);state.timer=0;wait.classList.remove('show')};
  const validURL=s=>{try{const u=new URL(s,location.href);return ['file:','https:','http:','blob:'].includes(u.protocol)?u.href:''}catch{return''}};
  function resetZoom(){state.zoom=1;state.x=0;state.y=0;state.drag=null;if(state.box){state.box.style.transform='';state.box.style.transition='';state.box.classList.remove('zoomed')}content.classList.remove('zoomed')}
  function applyZoom(){if(!state.box)return;state.box.style.transform=`translate3d(${state.x}px,${state.y}px,0) scale(${state.zoom})`;state.box.classList.toggle('zoomed',state.zoom>1);content.classList.toggle('zoomed',state.zoom>1)}
  function startWait(g){clearTimer();state.timer=setTimeout(()=>{if(state.generation===g&&state.visible)wait.classList.add('show')},280)}
  // Preserve each file's intrinsic aspect ratio. The visual/media hit area is
  // exactly its onscreen content rectangle, not a viewport-wide 1180px pane.
  function sizeMedia(box,ratio){
    if(!box||!box.isConnected)return;
    ratio=Number(ratio);if(!Number.isFinite(ratio)||ratio<=0)ratio=1;
    ratio=Math.max(.05,Math.min(20,ratio));state.ratio=ratio;state.box=box;
    const r=stage.getBoundingClientRect(),w=Math.max(1,r.width),h=Math.max(1,r.height);
    const width=Math.min(w,h*ratio),height=width/ratio;
    box.style.width=`${width}px`;box.style.height=`${height}px`;box.style.visibility='visible';
  }
  // Recompute only on viewport changes, never during thumbnail->original replacement.
  window.addEventListener('resize',()=>{if(state.visible&&state.box)sizeMedia(state.box,state.ratio)});
  function previewRatio(img,box,g){
    if(g!==state.generation||!state.visible||state.ratio)return;
    if(img.naturalWidth&&img.naturalHeight)sizeMedia(box,img.naturalWidth/img.naturalHeight);
  }
  function decodeImage(url){const image=new Image();image.decoding='async';image.src=url;return new Promise((resolve,reject)=>{const done=()=>image.decode?image.decode().then(()=>resolve(image)).catch(()=>resolve(image)):resolve(image);if(image.complete){image.naturalWidth?done():reject(new Error('image missing'))}else{image.onload=done;image.onerror=reject}})}
  function preloadNeighbors(){const arr=filtered(),idx=state.index;for(const d of [-2,-1,1,2]){const m=arr[(idx+d+arr.length)%arr.length];if(!m||m.type!=='image'||state.preloads.has(m.src))continue;const p=decodeImage(m.src).catch(()=>null);state.preloads.set(m.src,p);if(state.preloads.size>12)state.preloads.delete(state.preloads.keys().next().value)}}
  function show(){
    const m=current();if(!m){close();return}
    state.generation++;const g=state.generation;clearTimer();resetZoom();error.hidden=true;state.ratio=0;state.box=null;
    source.href=m.src;source.style.display=m.src?'':'none';const list=filtered();
    $('[data-counter]',el).textContent=`${state.index+1} / ${list.length}`;
    el.querySelectorAll('[data-filter]').forEach(b=>{b.classList.toggle('active',b.dataset.filter===state.filter);b.setAttribute('aria-pressed',String(b.dataset.filter===state.filter))});
    const both=list.length>1;el.querySelector('[data-prev]').disabled=!both;el.querySelector('[data-next]').disabled=!both;
    const previous=$('video',content);if(previous){previous.pause();previous.removeAttribute('src');previous.load()}
    content.replaceChildren();
    // The media box occupies the same stage throughout loading and switching.
    // Previews and full-resolution media overlay one another without reflow.
    const box=document.createElement('div');box.className='tak-lb-media-box';content.appendChild(box);sizeMedia(box,1);state.ratio=0;box.style.visibility='hidden';
    if(m.type==='image'){
      if(m.thumb){
        const preview=document.createElement('img');preview.className='tak-lb-image tak-lb-preview';
        preview.alt='正在加载原图（显示预览）';preview.draggable=false;preview.src=m.thumb;
        preview.addEventListener('load',()=>previewRatio(preview,box,g),{once:true});preview.addEventListener('error',()=>preview.remove(),{once:true});box.appendChild(preview);if(preview.complete)previewRatio(preview,box,g);
      }
      startWait(g);
      const task=state.preloads.get(m.src)||decodeImage(m.src);
      Promise.resolve(task).then(img=>{
        if(g!==state.generation||!state.visible)return;
        if(!img)throw Error('image failed');clearTimer();if(img.naturalWidth&&img.naturalHeight)sizeMedia(box,img.naturalWidth/img.naturalHeight);
        // Match preview and original to the exact same box from first frame.
        img.className='tak-lb-image tak-lb-full';img.alt='媒体图片';img.draggable=false;
        box.replaceChildren(img);preloadNeighbors();
      }).catch(()=>{if(g!==state.generation)return;clearTimer();error.hidden=false});
    }else{
      const video=document.createElement('video');video.className='tak-lb-video';video.controls=true;
      video.autoplay=true;video.playsInline=true;video.preload='auto';video.setAttribute('aria-label','媒体视频');
      if(m.thumb){video.poster=m.thumb;const preview=document.createElement('img');
        preview.className='tak-lb-image tak-lb-preview';preview.alt='视频预览';preview.src=m.thumb;
        preview.addEventListener('load',()=>previewRatio(preview,box,g),{once:true});preview.addEventListener('error',()=>preview.remove(),{once:true});box.appendChild(preview);if(preview.complete)previewRatio(preview,box,g)}
      video.style.visibility='hidden';box.appendChild(video);startWait(g);
      let settled=false;
      const ready=()=>{if(settled||g!==state.generation||!state.visible)return;settled=true;clearTimer();
        box.querySelector('.tak-lb-preview')?.remove();video.style.visibility='visible';
        video.play().catch(()=>{/* user gesture policy */})};
      video.addEventListener('loadedmetadata',()=>{
        if(g!==state.generation)return;
        // When the thumbnail was stretched/cropped, video metadata is authoritative.
        // This happens while the poster is shown; not every file gets a universal 16:9 box.
        if(video.videoWidth&&video.videoHeight)sizeMedia(box,video.videoWidth/video.videoHeight);
      },{once:true});
      video.addEventListener('loadeddata',ready,{once:true});video.addEventListener('canplay',ready,{once:true});
      video.addEventListener('error',()=>{if(g!==state.generation)return;clearTimer();video.style.visibility='hidden';error.hidden=false},{once:true});
      video.src=m.src;video.load();
    }
  }
  function open(items,index){const safe=(Array.isArray(items)?items:[]).slice(0,10000).map(m=>({type:m.type==='video'?'video':'image',src:validURL(m.src),thumb:validURL(m.thumb)})).filter(m=>m.src);
    if(!safe.length)return;state.items=safe;state.filter='all';state.index=Math.min(Math.max(Number(index)||0,0),safe.length-1);state.focus=document.activeElement;state.visible=true;el.hidden=false;document.body.classList.add('tak-viewing-media');show();el.focus({preventScroll:true})}
  function close(){if(!state.visible)return;state.generation++;state.visible=false;clearTimer();const v=$('video',content);if(v){v.pause();v.removeAttribute('src');v.load()}content.replaceChildren();state.box=null;state.ratio=0;el.hidden=true;document.body.classList.remove('tak-viewing-media');resetZoom();try{state.focus?.focus?.({preventScroll:true})}catch{}}
  function step(d){const n=filtered().length;if(!n)return;state.index=(state.index+d+n)%n;show()}
  function changeFilter(mode){const was=current();state.filter=mode;const next=filtered();if(!next.length){state.filter='all';return}state.index=Math.max(0,next.findIndex(m=>m.src===was?.src));show()}
  el.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',close));
  // The backdrop visible inside the stage must behave exactly like the shade.
  // In 9.9.6 it was occupied by a full-screen content element instead.
  stage.addEventListener('click',e=>{if(e.target===stage)close()});$('[data-prev]',el).addEventListener('click',()=>step(-1));$('[data-next]',el).addEventListener('click',()=>step(1));el.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>changeFilter(b.dataset.filter)));
  document.addEventListener('keydown',e=>{if(!state.visible)return;if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();return}if(['ArrowLeft','ArrowRight'].includes(e.key)){const v=$('video',content);if(v&&v.matches(':hover')){v.currentTime=Math.max(0,Math.min(v.duration||Infinity,v.currentTime+(e.key==='ArrowRight'?5:-5)));return}e.preventDefault();e.stopPropagation();step(e.key==='ArrowRight'?1:-1)}} ,true);
  content.addEventListener('click',e=>{if(e.target.tagName!=='IMG'||state.drag?.moved||content.dataset.dragged)return;state.zoom=state.zoom>1?1:2;state.x=0;state.y=0;applyZoom()});
  content.addEventListener('wheel',e=>{if(e.target.tagName!=='IMG')return;e.preventDefault();state.zoom=Math.max(1,Math.min(6,state.zoom+(e.deltaY<0?.25:-.25)));if(state.zoom===1){state.x=0;state.y=0}applyZoom()},{passive:false});
  content.addEventListener('pointerdown',e=>{if(e.target.tagName!=='IMG'||state.zoom<=1||e.pointerType==='touch')return;state.drag={id:e.pointerId,startX:e.clientX,startY:e.clientY,x:state.x,y:state.y,moved:false};state.box.style.transition='none'});
  content.addEventListener('pointermove',e=>{if(!state.drag||e.pointerId!==state.drag.id)return;const dx=e.clientX-state.drag.startX,dy=e.clientY-state.drag.startY;const firstMove=!state.drag.moved&&Math.hypot(dx,dy)>4;state.drag.moved=state.drag.moved||firstMove;if(firstMove)content.setPointerCapture(e.pointerId);state.x=state.drag.x+dx;state.y=state.drag.y+dy;applyZoom()});
  content.addEventListener('pointerup',e=>{if(state.drag?.id!==e.pointerId)return;const moved=state.drag.moved;state.drag=null;if(state.box)state.box.style.transition='';if(moved){content.dataset.dragged='1';setTimeout(()=>delete content.dataset.dragged,160)}});
  // Mobile: pinch to zoom and one-finger pan the actual image; gestures never
  // turn into a backdrop click and never alter the iframe or parent layout.
  let touchGesture=null;
  content.addEventListener('touchstart',e=>{
    if(e.target.tagName!=='IMG')return;
    if(e.touches.length===2){
      const a=e.touches[0],b=e.touches[1];
      touchGesture={kind:'pinch',distance:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),zoom:state.zoom,x:state.x,y:state.y,moved:false};
      e.preventDefault();
    }else if(e.touches.length===1&&state.zoom>1){
      touchGesture={kind:'pan',sx:e.touches[0].clientX,sy:e.touches[0].clientY,x:state.x,y:state.y,moved:false};
    }
  },{passive:false});
  content.addEventListener('touchmove',e=>{
    if(!touchGesture)return;
    if(touchGesture.kind==='pinch'&&e.touches.length===2){
      e.preventDefault();const a=e.touches[0],b=e.touches[1],dist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
      state.zoom=Math.max(1,Math.min(6,touchGesture.zoom*dist/Math.max(touchGesture.distance,1)));
      if(state.zoom<=1){state.x=0;state.y=0}applyZoom();touchGesture.moved=true;
    }else if(touchGesture.kind==='pan'&&e.touches.length===1){
      e.preventDefault();state.x=touchGesture.x+e.touches[0].clientX-touchGesture.sx;state.y=touchGesture.y+e.touches[0].clientY-touchGesture.sy;
      applyZoom();touchGesture.moved=true;
    }
  },{passive:false});
  content.addEventListener('touchend',()=>{
    if(touchGesture?.moved){content.dataset.dragged='1';setTimeout(()=>delete content.dataset.dragged,250)}
    touchGesture=null;
  },{passive:true});
  let swipe=null;stage.addEventListener('touchstart',e=>{if(e.touches.length===1)swipe={x:e.touches[0].clientX,y:e.touches[0].clientY}},{passive:true});stage.addEventListener('touchend',e=>{if(!swipe||state.zoom>1)return;const dx=e.changedTouches[0].clientX-swipe.x,dy=e.changedTouches[0].clientY-swipe.y;if(Math.abs(dx)>75&&Math.abs(dx)>Math.abs(dy)*1.4)step(dx>0?-1:1);swipe=null},{passive:true});
  window.TAKLightbox={open,close,isOpen:()=>state.visible};
})();
