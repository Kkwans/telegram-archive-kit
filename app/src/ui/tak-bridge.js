(()=>{'use strict';
const qs=(s,r=document)=>r.querySelector(s),qsa=(s,r=document)=>[...r.querySelectorAll(s)];
const params=new URLSearchParams(location.search);
if(params.get('embed')==='1')document.addEventListener('DOMContentLoaded',()=>document.body.classList.add('tak-embedded'));
let rows=window.__TAK_SEARCH__||[],sel=0,filtered=[],keyboardSelection=false;
const takLocateTimers=new WeakMap();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function currentPage(){const path=location.protocol==='about:'?new URL(document.baseURI).pathname:location.pathname;const m=path.match(/(?:strict-)?messages(\d*)\.html$/i);return m?(m[1]?Number(m[1]):1):1}
function targetHref(r){
 const prefix=params.get('mode')==='original'?'strict-':'';
 const file=r.Page<=1?`${prefix}messages.html`:`${prefix}messages${r.Page}.html`;
 const query=new URLSearchParams();if(params.get('embed')==='1')query.set('embed','1');
 query.set('merge',['original','reconstructed'].includes(params.get('mode'))?'0':'1');query.set('mode',params.get('mode')||'classic');
 return `${file}?${query.toString()}#message${encodeURIComponent(r.ID)}`;
}
function safeMediaURL(path){
 if(!path||typeof path!=='string')return '';
 try{const url=new URL(path,document.baseURI);if(!['file:','http:','https:'].includes(url.protocol))return '';
   // Media paths are generated inside this chat workspace. Prevent local-search
   // data or a crafted archive from making a preview request to a different host.
   if(url.origin!==new URL(document.baseURI).origin&&url.protocol!=='file:')return '';
   return url.href;
 }catch{return ''}
}
function addSearch(){
 if(qs('.tak-search-trigger'))return;
 const btn=document.createElement('button');btn.type='button';btn.className='tak-search-trigger';
 btn.title='搜索全部消息（/）';btn.setAttribute('aria-label','搜索全部消息');
 btn.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
 document.body.appendChild(btn);
 const modal=document.createElement('div');modal.className='tak-search-modal';
 modal.innerHTML='<div class="tak-search-panel" role="dialog" aria-modal="true" aria-label="搜索全部消息"><div class="tak-search-head"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#667eea" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input placeholder="搜索消息、发送者、文件名或 Message ID…" aria-label="搜索关键字"><button title="关闭搜索" aria-label="关闭搜索">×</button></div><div class="tak-search-results"></div></div>';
 document.body.appendChild(modal);
 const input=qs('input',modal),close=qs('.tak-search-head button',modal),host=qs('.tak-search-results',modal);
 const syncSearchHint=()=>{input.placeholder=innerWidth<=760?'搜索消息、文件或发送者':'搜索消息、发送者、文件名或 Message ID…'};syncSearchHint();window.addEventListener('resize',syncSearchHint);
 let priorFocus=null;
 btn.onclick=()=>open();close.onclick=()=>hide();modal.addEventListener('click',e=>{if(e.target===modal)hide()});
 input.addEventListener('input',render);
 input.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'){e.preventDefault();sel=Math.min(sel+1,Math.max(0,filtered.length-1));keyboardSelection=true;paint()}
  else if(e.key==='ArrowUp'){e.preventDefault();sel=Math.max(sel-1,0);keyboardSelection=true;paint()}
  else if(e.key==='Enter'&&filtered[sel])go(filtered[sel]);else if(e.key==='Escape')hide()
 });
 // Wheel events must never chain from a saturated result list to the timeline.
 // Keep the backdrop's native wheel behaviour so scrolling OUTSIDE the dialog
 // still controls the message timeline, as it did before this change.
 const resultScroller=host;
 const scrollWheel=(e)=>{
  if(e.ctrlKey||e.metaKey||e.defaultPrevented)return;
  const unit=e.deltaMode===1?16:e.deltaMode===2?resultScroller.clientHeight:1;
  const delta=e.deltaY*unit;
  if(!delta)return;
  // Wheel on the search bar / help text also scrolls the result list.
  if(!resultScroller.contains(e.target)){
   e.preventDefault();resultScroller.scrollTop+=delta;return;
  }
  const limit=resultScroller.scrollHeight-resultScroller.clientHeight;
  if((delta<0&&resultScroller.scrollTop<=0)||(delta>0&&resultScroller.scrollTop>=limit-1)||limit<=0){e.preventDefault()}
  e.stopPropagation();
 };
 qs('.tak-search-panel',modal).addEventListener('wheel',scrollWheel,{passive:false});
 function open(){priorFocus=document.activeElement;modal.classList.add('open');input.focus({preventScroll:true});render()}
 function hide(){modal.classList.remove('open');priorFocus?.focus?.({preventScroll:true})}
 function render(){const q=input.value.trim().toLowerCase();
  filtered=(q?rows.filter(r=>(`${r.ID} ${r.From||''} ${r.Text||''} ${(r.Media||[]).join(' ')}`).toLowerCase().includes(q)):rows.slice(-80).reverse()).slice(0,160);
  sel=0;keyboardSelection=false;paint();
 }
 function paint(){
  if(!filtered.length){host.innerHTML='<div class="tak-search-empty">没有找到匹配消息</div>';return}
  host.innerHTML=filtered.map((r,i)=>{
   const kind=r.PreviewKind==='video'?'video':r.PreviewKind==='image'?'image':'';
   const preview=safeMediaURL(r.Preview),mediaSrc=safeMediaURL(r.MediaSource);
   let cover='';
   if(kind){
    // For video without FFmpeg poster, load metadata in a small muted preview.
    const thumb=preview?`<img alt="" loading="lazy" src="${esc(preview)}">`:kind==='video'&&mediaSrc?`<video muted playsinline preload="none" data-poster-src="${esc(mediaSrc)}"></video>`:'';
    cover=`<span class="tak-search-cover" ${thumb?'':'data-missing="true"'}>${thumb}${kind==='video'?'<span class="tak-search-play"><span>▶</span></span>':''}</span>`;
   }
   return `<button type="button" class="tak-search-result ${keyboardSelection&&i===sel?'tak-keyboard-selected':''}" data-i="${i}">${cover}<span class="tak-search-copy"><span class="meta"><span>#${esc(r.ID)}</span><span>${esc(r.From||'')}</span>${r.Media?.length?`<span>${r.Media.length} 个媒体</span>`:''}</span><span class="preview">${esc(r.Text||(r.Media||[]).join(' · ')||'媒体消息')}</span></span></button>`;
  }).join('');
  qsa('[data-i]',host).forEach(b=>b.onclick=()=>go(filtered[Number(b.dataset.i)]));
  if(keyboardSelection)qsa('[data-i]',host)[sel]?.scrollIntoView({block:'nearest'});
  // Probe video posters only once they scroll into view, not for all 160 hits.
  const posters=qsa('video[data-poster-src]',host);
  const prepare=v=>{if(v.dataset.takLoading)return;v.dataset.takLoading='1';v.src=v.dataset.posterSrc;v.preload='auto';
    v.addEventListener('loadedmetadata',()=>{try{v.currentTime=Math.min(.15,Math.max(0,(v.duration||1)*.02))}catch{}},{once:true});
  };
  if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){observer.unobserve(entry.target);prepare(entry.target)}}),{root:host,rootMargin:'180px 0px'});posters.forEach(v=>observer.observe(v))}
  else posters.slice(0,6).forEach(prepare);
 }
 function go(r){
  const url=targetHref(r);
  // Same-page hits should not unnecessarily reload the entire media-heavy chat.
  if(Number(r.Page)===currentPage()){hide();try{history.replaceState(null,'',url)}catch{location.hash='#message'+encodeURIComponent(r.ID)}locate()}
  else location.href=url;
 }
 document.addEventListener('keydown',e=>{if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)){e.preventDefault();open()}else if(e.key==='Escape'&&modal.classList.contains('open')){e.preventDefault();hide()}});
 window.addEventListener('message',e=>{if(e.source===parent&&e.data?.type==='tak-open-search')open()});
}
/* Beautifier merges .joined messages by setting display:none and moving their media.
   Preserve EVERY Message ID on the visible owning card so full-text search can
   locate it even after a same-sender merge. This runs after upstream init. */
function rehomeMergedMessageAnchors(){
 let owner=null;
 for(const msg of qsa('.history > .message.default')){
  const hidden=getComputedStyle(msg).display==='none';
  if(!hidden){owner=msg;continue}
  if(!owner)continue;
  const ids=[msg,...qsa('[id^="message"]',msg)].filter(el=>/^message[^\s]+$/.test(el.id||''));
  const host=qs('.body',owner)||owner;
  for(const node of ids){
   const id=node.id;node.removeAttribute('id');
   if(document.getElementById(id))continue;
   const anchor=document.createElement('span');anchor.className='tak-album-anchor tak-search-alias';
   anchor.id=id;host.prepend(anchor);
  }
 }
}
function locate(){
 const anchor=location.hash.replace(/^#/,'');const selectedDate=params.get('date');if(!anchor&&!selectedDate)return;
 let attempts=0;
 function tryLocate(){
  const dest=anchor?document.getElementById(anchor):null;
  const messages=qsa('.history .message.default');
  // Some Beautifier modes merge adjacent nodes. An album anchor may be a
  // zero-height child, but the highlighting target must always be its card.
  let card=dest?.closest('.message.default')||null;
  if(card && (getComputedStyle(card).display==='none'||!card.getClientRects().length))card=null;
  if(!card&&anchor.startsWith('message')){
   const id=anchor.slice(7);card=messages.find(m=>(m.id==='message'+id||m.querySelector(`[id="${CSS.escape('message'+id)}"]`))&&m.getClientRects().length)||null;
  }
  if(anchor.startsWith('message')){
    if(!card&&attempts++<30){setTimeout(tryLocate,110);return}
    if(!card)return; // Never silently redirect a failed message search to a date separator.
    card.scrollIntoView({block:'center',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    // Allow smooth scrolling to begin before pulsing the destination card.
    // A repeated search can target the same card before its previous pulse ends.
    // Cancel BOTH stale timers: an old removal must never interrupt a new pulse.
    const previous=takLocateTimers.get(card);
    if(previous){clearTimeout(previous.start);clearTimeout(previous.stop)}
    const task={start:0,stop:0};takLocateTimers.set(card,task);
    task.start=setTimeout(()=>{
      if(!card.isConnected||takLocateTimers.get(card)!==task)return;
      // The card itself never changes positioning/compositing mode. A persistent
      // child halo pulses and fades to zero. Retaining that transparent child
      // prevents an end-of-animation repaint of the whole message card.
      let halo=qs(':scope > .tak-search-highlight',card);
      if(!halo){halo=document.createElement('span');halo.className='tak-search-highlight';halo.setAttribute('aria-hidden','true');card.appendChild(halo)}
      halo.classList.remove('is-active');void halo.offsetWidth;
      // Never toggle `tak-locating` on the message itself: the legacy CSS
      // changes animation-name, and removing it replays upstream slideIn
      // from zero opacity, producing the user-visible blink.
      halo.classList.add('is-active');
      task.stop=setTimeout(()=>{
        if(takLocateTimers.get(card)!==task)return;
        halo.classList.remove('is-active');takLocateTimers.delete(card);
      },2050);
    },240);
    return;
  }
  // Date navigation remains a separate behavior; only explicit date targets use it.
  if(selectedDate){const day=qsa('.history .message.service .body.details[data-date]').find(d=>d.dataset.date===selectedDate);
    if(!day&&attempts++<30){setTimeout(tryLocate,110);return}
    const service=day?.closest('.message.service');if(service&&typeof window.scrollToDate==='function')window.scrollToDate(service);
    else service?.scrollIntoView({block:'center',behavior:'smooth'});
  }
 }
 setTimeout(tryLocate,200);
}
function unifyBeautifierJumpButtons(){
 for(const el of qsa('button, a')){
  const text=(el.textContent||'').trim();const title=(el.title||'').trim();
  if((text==='顶部'||text==='底部'||title==='回到顶部'||title==='跳到底部')&&!el.classList.contains('tak-search-trigger'))el.classList.add('tak-scroll-glass');
 }
}
function initPager(){
 const pagers=qsa('.tak-pagination');
 for(const pager of pagers){
  const picker=qs('.tak-page-picker',pager),options=qs('.tak-page-options',pager);
  if(!picker||!options)continue;
  const links=qsa('a[role="option"]',options),owner=qs('.tak-page-jump',pager);
  const close=()=>{options.hidden=true;options.classList.remove('tak-page-portal');picker.setAttribute('aria-expanded','false');if(options.parentNode!==owner)owner.appendChild(options)};
  const place=()=>{
   // options is portalled into document.body: all coordinates MUST be viewport
   // coordinates (position:fixed), never page/scroll coordinates.
   const r=picker.getBoundingClientRect(),w=Math.ceil(r.width),margin=8;
   options.style.width=w+'px';options.style.left=Math.max(margin,Math.min(innerWidth-w-margin,r.left))+'px';
   // Measure the NATURAL height without an old max-height or scroll bar. The
   // former code capped a 5-item list at 330px despite enough viewport space,
   // often leaving a 1-3px overflow and an unnecessary native scrollbar.
   options.style.maxHeight='none';options.style.overflowY='hidden';
   const natural=Math.ceil(options.scrollHeight+2);
   const below=Math.max(0,innerHeight-r.bottom-margin-8),above=Math.max(0,r.top-margin-8);
   const preferred=Math.min(natural,360,Math.floor(innerHeight*.68));
   const down=below>=preferred||(below>=above&&below>100);
   const available=Math.max(60,down?below:above);
   const allowed=Math.min(preferred,Math.floor(available));
   options.style.maxHeight=allowed+'px';
   options.style.top=(down?Math.min(innerHeight-margin-allowed,r.bottom+8):Math.max(margin,r.top-allowed-8))+'px';
   // If all options fit, don't create a scroll container at all. Longer lists
   // still scroll with wheel, touch, PageUp/Down and keyboard focus.
   options.style.overflowY=natural<=allowed?'hidden':'auto';
  };
  picker.addEventListener('click',()=>{
   const shouldOpen=options.hidden;
   qsa('.tak-page-portal').forEach(n=>{n.hidden=true;n.classList.remove('tak-page-portal');n.__takOwner?.appendChild(n)});
   qsa('.tak-page-picker').forEach(n=>n.setAttribute('aria-expanded','false'));
   if(shouldOpen){options.__takOwner=owner;document.body.appendChild(options);options.classList.add('tak-page-portal');options.hidden=false;place();picker.setAttribute('aria-expanded','true');(links.find(a=>a.getAttribute('aria-selected')==='true')||links[0])?.focus({preventScroll:true})}
   else close();
  });
  options.addEventListener('keydown',e=>{const i=links.indexOf(document.activeElement);
   if(e.key==='Escape'){e.preventDefault();close();picker.focus()}
   else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const j=e.key==='Home'?0:e.key==='End'?links.length-1:e.key==='ArrowDown'?(i+1)%links.length:(i-1+links.length)%links.length;links[j]?.focus({preventScroll:true})}
  });
  const outside=e=>{if(!options.hidden&&!pager.contains(e.target)&&!options.contains(e.target))close()};
  document.addEventListener('pointerdown',outside,true);
  document.addEventListener('focusin',outside);
  window.addEventListener('blur',close);
  window.addEventListener('resize',()=>{if(!options.hidden)place()});
  window.addEventListener('scroll',e=>{if(!options.hidden&&!options.contains(e.target))requestAnimationFrame(place)},true);
 }
}
function ensureJumpButtons(){
 // Upstream may use either an icon-only or a text+icon jump; preserve the
 // buttons, remove only their redundant visible words.
 for(const el of qsa('.scroll-to-top,.scroll-to-bottom,.scroll-top,.scroll-bottom,.scroll-to-top-btn,.scroll-to-bottom-btn,.scroll-btn,.scroll-button,.scroll-buttons button')){
  const t=(el.textContent||'').trim(),hint=(el.getAttribute('title')||'').trim();
  const top=/顶部|回到顶部|向上|Top/i.test(t+' '+hint+' '+el.className);
  const bottom=/底部|回到底部|向下|Bottom/i.test(t+' '+hint+' '+el.className);
  if(!top&&!bottom)continue;
  el.classList.add('tak-scroll-glass',top?'tak-jump-top':'tak-jump-bottom');
  el.dataset.takUnavailable='true';
  el.setAttribute('aria-label',top?'返回顶部':'跳至底部');
  el.title=top?'返回顶部':'跳至底部';
  el.innerHTML=top?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 10 6 6 6-6"/></svg>';
 }
}
/* Native Beautifier may fade or disable these controls. Derive availability
   from actual scroll position instead of forcing both buttons visible. */
function syncJumpAvailability(){
 const wrap=qs('.scroll-buttons');if(!wrap)return;
 const top=qs('.tak-jump-top',wrap),bottom=qs('.tak-jump-bottom',wrap);
 if(!top&&!bottom)return;
 const root=document.scrollingElement||document.documentElement;
 let el=root;
 for(const selector of ['.page_wrap','.page_body','.history']){
  const candidate=qs(selector);
  if(candidate && candidate.scrollHeight-candidate.clientHeight>90 &&
     getComputedStyle(candidate).overflowY.match(/auto|scroll/)){el=candidate;break}
 }
 const y=el===root?(window.scrollY||root.scrollTop||0):el.scrollTop;
 const remaining=Math.max(0,el.scrollHeight-el.clientHeight-y);
 if(top)top.dataset.takUnavailable=String(y<=24);
 if(bottom)bottom.dataset.takUnavailable=String(remaining<=24);
 wrap.setAttribute('aria-label','页面滚动导航');
}
function installJumpAvailability(){
 let queued=false;
 const update=()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;syncJumpAvailability()})};
 window.addEventListener('scroll',update,{passive:true,capture:true});
 window.addEventListener('resize',update,{passive:true});
 document.addEventListener('click',e=>{if(e.target.closest('.scroll-buttons .scroll-btn'))requestAnimationFrame(update)},true);
 update();setTimeout(update,40);setTimeout(update,250);setTimeout(update,700);
}
/* In embedded mode, stop Beautifier's iframe-local lightbox click handler and
   ask the parent window to render its own full-viewport overlay instead.
   Standalone mode retains the untouched upstream viewer (including gestures). */
let parentViewerReady=false;
window.addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='tak-parent-viewer-ready'){parentViewerReady=true;document.documentElement.dataset.takViewerReady='1'}});
function installParentViewer(){
 if(params.get('embed')!=='1'&&document.documentElement.dataset.takEmbed!=='1'||parent===window)return;
 const absolute=path=>{if(!path)return'';try{return new URL(path.replace(/#/g,'%23'),document.baseURI).href}catch{return''}};
 document.addEventListener('click',event=>{
  if(!parentViewerReady)return;  // backward compatibility with older Library index.html
  const link=event.target.closest?.('.photo_wrap,.video_file_wrap');
  if(!link)return;
  const upstream=typeof mediaItems!=='undefined'&&Array.isArray(mediaItems)&&mediaItems.length?mediaItems:[];
  const elements=upstream.length?upstream.map(m=>m.element):qsa('.photo_wrap,.video_file_wrap');
  const index=elements.indexOf(link);if(index<0)return;
  const items=upstream.length?upstream.map(m=>({type:m.type,src:absolute(m.src),thumb:absolute(m.thumb||m.element?.querySelector('img')?.getAttribute('src'))})):elements.map(node=>({type:node.classList.contains('video_file_wrap')?'video':'image',src:absolute(node.getAttribute('href')),thumb:absolute(node.querySelector('img')?.getAttribute('src'))}));
  event.preventDefault();event.stopImmediatePropagation();
  parent.postMessage({type:'tak-global-lightbox-open',items,index},'*');
 },true);
}
function stabilizeVideoArrows(){
 document.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;const video=document.getElementById('current-video');if(!video)return;
 const lb=document.getElementById('lightbox');if(!lb?.classList.contains('active'))return;
 // Beautifier already owns changeMedia() and seek logic. Correct the input
 // hover state before its handler runs; do not install a competing navigator.
 const pt=window.__takPointer;const r=video.getBoundingClientRect();const inside=!!(pt&&pt.x>=r.left&&pt.x<=r.right&&pt.y>=r.top&&pt.y<=r.bottom);
 if(!inside){try{isVideoHovered=false}catch{}}
 },true);
 document.addEventListener('pointermove',e=>{window.__takPointer={x:e.clientX,y:e.clientY}}, {passive:true});
}

// Mobile immersive-mode control: share the search FAB's exact material and
// stacking context, so date/search panels ALWAYS render above it. Keep a single
// button in both states and change only icon and accessible name.
function installMobileFocusControl(){
 if(params.get('embed')!=='1'||window===parent||qs('.tak-focus-trigger'))return;
 const enter='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
 const exit='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5"/></svg>';
 const btn=document.createElement('button');btn.type='button';btn.className='tak-search-trigger tak-focus-trigger';btn.dataset.focusActive='false';
 const sync=(active)=>{btn.dataset.focusActive=String(!!active);btn.innerHTML=active?exit:enter;btn.setAttribute('aria-label',active?'退出沉浸模式':'进入沉浸模式');btn.title=btn.getAttribute('aria-label');btn.setAttribute('aria-pressed',String(!!active))};
 sync(false);document.body.appendChild(btn);document.body.classList.add('tak-has-mobile-focus');
 btn.addEventListener('click',()=>{try{parent.postMessage({type:'tak-toggle-focus'},(location.protocol==='file:'?'*':location.origin))}catch{}});
 window.addEventListener('message',e=>{if(e.source!==parent||!(e.origin===location.origin||(location.protocol==='file:'&&e.origin==='null'))||e.data?.type!=='tak-focus-state')return;sync(e.data.active)});
}
function hydrateVideoThumbs(){const wraps=qsa('.video_file_wrap');if(!wraps.length)return;const load=w=>{if(w.dataset.takPoster==='1')return;w.dataset.takPoster='1';if(w.querySelector('img.tak-video-thumbnail'))return;const src=w.getAttribute('href');if(!src)return;const v=document.createElement('video');v.muted=true;v.playsInline=true;v.preload='metadata';v.src=src;const fail=()=>{try{v.removeAttribute('src');v.load()}catch{}};let armed=false;v.addEventListener('loadedmetadata',()=>{if(!isFinite(v.duration)||v.duration<=0){fail();return}try{v.currentTime=Math.min(.15,Math.max(0,v.duration*.02));armed=true}catch{fail()}},{once:true});v.addEventListener('seeked',()=>{if(!armed)return;try{const cw=Math.min(720,v.videoWidth||480),ch=Math.max(1,Math.round(cw*(v.videoHeight||270)/(v.videoWidth||480)));const c=document.createElement('canvas');c.width=cw;c.height=ch;const x=c.getContext('2d');x.drawImage(v,0,0,cw,ch);const img=document.createElement('img');img.className='video_file tak-video-thumbnail';img.alt='Video';img.loading='lazy';img.src=c.toDataURL('image/jpeg',.72);(w.querySelector('.tak-video-poster')||w).insertBefore(img,(w.querySelector('.tak-video-poster')||w).firstChild)}catch{}finally{fail()}},{once:true});v.addEventListener('error',fail,{once:true})};if('IntersectionObserver'in window){const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){io.unobserve(e.target);load(e.target)}}),{rootMargin:'600px 0px'});wraps.forEach(w=>io.observe(w))}else wraps.slice(0,40).forEach(load)}document.addEventListener('keydown',e=>{if(e.key==='Escape'&&params.get('embed')==='1'){const lb=document.getElementById('lightbox');if(lb&&lb.classList.contains('active'))return;try{parent!==window&&parent.postMessage({type:'tak-exit-focus'},'*')}catch{}}});function patchPaging(){const merge=['original','reconstructed'].includes(params.get('mode'))?'0':'1',embed=params.get('embed')==='1';qsa('a.pagination, .tak-page-options a[role=option]').forEach(a=>{try{const u=new URL(a.getAttribute('href'),location.href);u.searchParams.set('merge',merge);u.searchParams.set('mode',params.get('mode')||'classic');if(embed)u.searchParams.set('embed','1');a.setAttribute('href',u.pathname.split('/').pop()+u.search+u.hash)}catch{}});qsa('.tak-page-jump select option').forEach(o=>{const u=new URL(o.value,location.href);u.searchParams.set('mode',params.get('mode')||'classic');u.searchParams.set('merge',merge);if(embed)u.searchParams.set('embed','1');o.value=u.pathname.split('/').pop()+u.search})}document.addEventListener('DOMContentLoaded',()=>{rehomeMergedMessageAnchors();addSearch();installMobileFocusControl();unifyBeautifierJumpButtons();ensureJumpButtons();installJumpAvailability();initPager();installParentViewer();stabilizeVideoArrows();hydrateVideoThumbs();patchPaging();locate();try{parent!==window&&parent.postMessage({type:'tak-chat-ready',title:document.title,page:currentPage(),count:qsa('.history > .message.default').length},'*')}catch{}});window.addEventListener('hashchange',locate)})();
