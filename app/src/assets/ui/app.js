(()=>{'use strict';
const LIB=window.__TAK_LIBRARY__||{chats:[]};
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>new Intl.NumberFormat('zh-CN').format(Number(n||0));
const fmtDate=v=>{if(!v)return'—';const d=new Date(v);return isNaN(d)?'—':new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(d)};
const fmtTS=v=>v?fmtDate(Number(v)*1000):'—';
const icons={
  home:'<svg viewBox="0 0 24 24"><path d="m4 11 8-7 8 7v9H4Z"/></svg>',
  panelOpen:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16M14 9l3 3-3 3"/></svg>',
  panelClose:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16m7-11-3 3 3 3"/></svg>', 
  focus:'<svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>',
  external:'<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 13v6H5V5h6"/></svg>',
  info:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  calendar:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/></svg>',
  menu:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  search:'<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
};
const plane=()=>'<img class="brand-app-icon" src="favicon.ico" width="38" height="38" alt="" aria-hidden="true">';
let mergeMenuAbort=null;
const homeSortFields=[['updated_at','更新时间'],['imported_at','创建时间'],['last_ts','最新消息'],['messages','消息数量'],['media_files','媒体数量']];
const homeSortDefaults={field:'updated_at',direction:'desc'};
const homeSort={...homeSortDefaults};
try{const saved=JSON.parse(localStorage.getItem('tak-home-sort')||'{}');if(homeSortFields.some(([id])=>id===saved.field))homeSort.field=saved.field;if(['asc','desc'].includes(saved.direction))homeSort.direction=saved.direction}catch{}
function sortedHomeChats(){
 const list=filteredChats().map((chat,index)=>({chat,index}));
 const key=homeSort.field,mult=homeSort.direction==='asc'?1:-1;
 function value(chat){if(key==='updated_at'||key==='imported_at'){
   const stamp=Date.parse(chat[key]||'');return Number.isFinite(stamp)?stamp:null;
  }if(key==='last_ts'){const stamp=Number(chat.last_ts);return chat.last_ts!=null&&Number.isFinite(stamp)&&stamp>0?stamp:null}
  const n=Number(chat[key]);return Number.isFinite(n)?n:null}
 list.sort((a,b)=>{const x=value(a.chat),y=value(b.chat);if(x===null||y===null){if(x===null&&y===null)return a.index-b.index;return x===null?1:-1}return x===y?a.index-b.index:(x-y)*mult});
 return list.map(({chat})=>chat);
}
function persistHomeSort(){try{localStorage.setItem('tak-home-sort',JSON.stringify(homeSort))}catch{}}
function changeHomeSort(field,direction){if(homeSortFields.some(([id])=>id===field))homeSort.field=field;if(['asc','desc'].includes(direction))homeSort.direction=direction;persistHomeSort();if(!current())renderMain()}
function homeSortControls(){const label=homeSortFields.find(([id])=>id===homeSort.field)?.[1]||'更新时间',dir=homeSort.direction==='desc'?'降序':'升序';return `<div class="home-sort" data-home-sort-root><div class="home-sort-picker-wrap"><button type="button" class="home-sort-picker" data-home-sort-picker aria-label="选择聊天排序字段" aria-haspopup="listbox" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M4 12h8M4 17h6"/></svg><span>${label}</span><svg class="home-sort-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="home-sort-menu" role="listbox" aria-label="聊天排序字段" hidden>${homeSortFields.map(([id,text])=>`<button type="button" role="option" data-home-sort-field="${id}" aria-selected="${id===homeSort.field}">${text}${id===homeSort.field?'<span aria-hidden="true">✓</span>':''}</button>`).join('')}</div></div><button type="button" data-home-sort-direction class="home-sort-direction" aria-label="切换排序方向，当前${dir}" title="当前${dir} · 点击切换">${homeSort.direction==='desc'?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h12M4 12h8M4 17h4M19 5v14m-4-4 4 4 4-4"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h4M4 12h8M4 17h12M19 19V5m-4 4 4-4 4 4"/></svg>'}</button></div>`}
function bindHomeSort(){
 const root=$('[data-home-sort-root]');if(!root)return;
 const picker=$('[data-home-sort-picker]',root),menu=$('.home-sort-menu',root),items=$$('[data-home-sort-field]',root);
 const close=()=>{menu.hidden=true;picker.setAttribute('aria-expanded','false')};
 const open=()=>{menu.hidden=false;picker.setAttribute('aria-expanded','true')};
 picker.addEventListener('click',()=>menu.hidden?open():close());
 items.forEach(btn=>btn.addEventListener('click',()=>changeHomeSort(btn.dataset.homeSortField,homeSort.direction)));
 $('[data-home-sort-direction]',root)?.addEventListener('click',()=>changeHomeSort(homeSort.field,homeSort.direction==='desc'?'asc':'desc'));
 menu.addEventListener('keydown',event=>{const i=items.indexOf(document.activeElement);if(event.key==='Escape'){event.preventDefault();close();picker.focus()}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowDown'?(i+1+items.length)%items.length:(i-1+items.length)%items.length;items[next]?.focus()}else if(event.key==='Enter'||event.key===' '){event.preventDefault();document.activeElement?.click()}});
 // One delegated listener for the lifetime of the page. Re-rendering the home
 // is frequent during filtering; document listeners must not accumulate.
}

const state={chat:'',q:'',collapsed:true,focus:false,mobile:false,hintTimer:0,merge:'classic',page:1,pageItems:0,anchor:'',dateTarget:'',dates:[],dateCache:{},dateLoading:false};
try{state.merge=localStorage.getItem('tak-merge-mode')||(localStorage.getItem('tak-merge-messages')==='0'?'original':'classic')}catch{}
if(state.merge==='none')state.merge='original';if(!['classic','original','reconstructed','minute','sender','media'].includes(state.merge))state.merge='classic';
function avatarStyle(seed){let h=0;for(const c of String(seed||''))h=(h*31+c.charCodeAt(0))>>>0;const p=[['#5aaef5','#667eea'],['#667eea','#946ae8'],['#38ad98','#558de7'],['#df8b5b','#d5698e']][h%4];return`--a:${p[0]};--b:${p[1]}`}
function letters(name){const a=[...String(name||'TG').trim()];return esc((a[0]||'T')+(a[1]||''))}
function generatorLabel(){return String(LIB.generator||'1.0').replace(/^TelegramArchiveKit\//,'')}
function parseHash(){try{return new URLSearchParams(location.hash.replace(/^#/,'')).get('chat')||''}catch{return''}}
function current(){return LIB.chats.find(c=>c.slug===state.chat)||null}
function filteredChats(){const q=state.q.trim().toLowerCase();return LIB.chats.filter(c=>!q||`${c.name} ${c.id||''} ${c.type||''}`.toLowerCase().includes(q))}
function setHash(slug){const p=new URLSearchParams();if(slug)p.set('chat',slug);const h='#'+p.toString();try{history.replaceState(null,'',h)}catch{if(location.hash!==h)location.hash=h}}
function remember(slug){try{localStorage.setItem('tak-last-chat',slug)}catch{}}
function chatRow(c){const active=c.slug===state.chat,missing=Number(c.missing||0);return`<button class="chat ${active?'active':''}" data-chat="${esc(c.slug)}" aria-current="${active?'page':'false'}" title="${esc(c.name)}"><span class="avatar" style="${avatarStyle(c.id||c.name)}">${letters(c.name)}</span><span class="chat-copy"><span class="chat-name">${esc(c.name)}</span><span class="chat-meta ${missing?'chat-warn':''}">${fmt(c.messages)} 条消息 · ${fmt(c.media_files)} 媒体${missing?` · 缺 ${fmt(missing)}`:''}</span></span></button>`}
function mobileArchiveStats(c){
 const n=key=>Math.max(0,Number(c[key])||0);
 const stats=[['messages','消息'],['images','图片'],['videos','视频']];
 if(n('audio'))stats.push(['audio','音频']);
 if(n('files'))stats.push(['files','文件']);
 const other=Math.max(0,n('media_files')-n('images')-n('videos')-n('audio')-n('files'));
 const parts=stats.map(([key,label])=>`<span><b>${fmt(n(key))}</b> ${label}</span>`);
 if(other)parts.push(`<span><b>${fmt(other)}</b> 其他媒体</span>`);
 parts.push(`<span><b>${n('pages')?fmt(n('pages')):'—'}</b> 页</span>`);
 if(n('missing'))parts.push(`<span class="chat-warn"><b>${fmt(n('missing'))}</b> 缺失</span>`);
 return parts.join('');
}
function homeMarkup(){const rows=sortedHomeChats();return`<div class="home"><div class="home-head"><div class="home-head-copy"><div class="home-kicker">Telegram Archive Library</div><div class="home-title">聊天档案</div></div>${homeSortControls()}</div>${rows.length?`<div class="home-grid">${rows.map(c=>`<button class="home-card" data-chat="${esc(c.slug)}"><div class="home-card-top"><span class="avatar" style="${avatarStyle(c.id||c.name)}">${letters(c.name)}</span><span><h3>${esc(c.name)}</h3><p>${esc(c.type||'Telegram chat')}</p></span></div><div class="home-stats home-stats-desktop"><span><b>${fmt(c.messages)}</b> 消息</span><span><b>${fmt(c.media_files)}</b> 媒体</span><span><b>${c.pages>0?fmt(c.pages):'—'}</b> 页</span>${c.missing?`<span class="chat-warn"><b>${fmt(c.missing)}</b> 缺失</span>`:''}<span><b>${fmt(c.images)}</b> 图片</span><span><b>${fmt(c.videos)}</b> 视频</span>${c.official_exports?`<span><b>${fmt(c.official_exports)}</b> 官方导出</span>`:''}</div><div class="home-stats home-stats-mobile">${mobileArchiveStats(c)}</div><div class="home-card-timeline"><span>创建时间 <b>${fmtDate(c.imported_at)}</b></span><span>更新时间 <b>${fmtDate(c.updated_at)}</b></span><span>最新消息 <b>${fmtTS(c.last_ts)}</b></span></div></button>`).join('')}</div>`:'<div class="empty">暂无聊天。请回到 TelegramArchiveKit 导入聊天记录。</div>'}</div>`}

function appMarkup(){return`<div class="shell sidebar-collapsed"><aside class="sidebar"><div class="brand"><button class="brand-logo" data-home title="档案库首页" aria-label="档案库首页">${plane()}</button><div class="brand-copy"><div class="brand-title">Prism Archive</div><div class="brand-sub">Telegram 离线档案库</div></div></div><div class="side-search"><div class="searchbox">${icons.search}<input data-chat-search placeholder="搜索聊天…" autocomplete="off"></div></div><div class="side-label">全部聊天 · <span data-chat-count>${fmt(LIB.chats.length)}</span></div><div class="chat-list" data-chat-list></div><div class="side-foot"><button class="collapse-btn" data-side title="收起 / 展开侧边栏">${icons.panelOpen}<span class="collapse-label">展开侧边栏</span></button><span class="library-version">TAK ${esc(generatorLabel())}</span></div></aside><header class="topbar"><button class="iconbtn mobile-menu" data-mobile-menu type="button" title="打开聊天列表" aria-label="打开聊天列表">${icons.panelOpen}</button><div class="current" data-current></div><div class="top-actions" data-chat-actions></div><button class="iconbtn desktop-focus" data-focus title="沉浸阅读（Esc 退出）" aria-label="沉浸阅读">${icons.focus}</button></header><main class="main" data-main></main><div class="focus-hint" data-focus-hint>沉浸阅读 · 按 Esc 退出</div><div class="mobile-overlay" data-overlay></div><div class="modal" data-date-modal><div class="modal-card date-card"><div class="modal-head"><div class="modal-title">全库日期导航</div><button class="modal-close" data-date-close aria-label="关闭">×</button></div><div class="date-list" data-date-list></div></div></div><div class="modal" data-detail-modal><div class="modal-card"><div class="modal-head"><div class="modal-title" data-detail-title>档案信息</div><button class="modal-close" data-detail-close aria-label="关闭">×</button></div><div class="details" data-detail-body></div></div></div></div>`}
function renderChatList(){const list=$('[data-chat-list]');if(!list)return;list.innerHTML=filteredChats().map(chatRow).join('')||'<div class="chat-empty">没有匹配的聊天</div>';$$('[data-chat]',list).forEach(b=>b.addEventListener('click',()=>selectChat(b.dataset.chat)))}
function detailMarkup(c){return`<div class="detail-grid"><div class="detail-item"><span>Chat ID</span><b>${esc(c.id||'未记录（仅官方 HTML）')}</b></div><div class="detail-item"><span>工作区目录</span><b>${esc(c.folder_name||c.slug)}</b></div><div class="detail-item"><span>消息</span><b>${fmt(c.messages)}</b></div><div class="detail-item"><span>媒体文件</span><b>${fmt(c.media_files)}${c.missing?` · 缺 ${fmt(c.missing)}`:''}</b></div><div class="detail-item"><span>图片 / 视频</span><b>${fmt(c.images||0)} / ${fmt(c.videos||0)}</b></div><div class="detail-item"><span>音频 / 文件</span><b>${fmt(c.audio||0)} / ${fmt(c.files||0)}</b></div><div class="detail-item"><span>最早消息</span><b>${fmtTS(c.first_ts)}</b></div><div class="detail-item"><span>最新消息</span><b>${fmtTS(c.last_ts)}</b></div><div class="detail-item"><span>首次纳入 Library</span><b>${fmtDate(c.imported_at)}</b></div><div class="detail-item"><span>最近更新</span><b>${fmtDate(c.updated_at)}</b></div><div class="detail-item"><span>官方 ChatExport</span><b>${fmt(c.official_exports||0)} 份</b></div><div class="detail-item"><span>生成器</span><b>TelegramArchiveKit ${esc(generatorLabel())}</b></div></div>`}
function openDetails(){const c=current();if(!c)return;const modal=$('[data-detail-modal]'),body=$('[data-detail-body]');body.innerHTML=detailMarkup(c);const title=$('[data-detail-title]');if(title)title.innerHTML=`<span class="avatar detail-head-avatar" style="${avatarStyle(c.id||c.name)}">${letters(c.name)}</span><span class="detail-head-name">${esc(c.name)}<small>${esc(c.type||'Telegram chat')}</small></span>`;modal.classList.add('open')}
function closeDetails(){$('[data-detail-modal]')?.classList.remove('open')}
function changeMerge(mode){
  state.merge=['classic','original','reconstructed','minute','sender','media'].includes(mode)?mode:'classic';
  try{localStorage.setItem('tak-merge-mode',state.merge);localStorage.setItem('tak-merge-messages',['original','reconstructed'].includes(state.merge)?'0':'1')}catch{}
  renderHeader();renderMain();
}
function closeDates(){$('[data-date-modal]')?.classList.remove('open')}
function previewURL(c,src){if(!src)return'';if(/^file:\/\//i.test(src))return src;return `chats/${encodeURIComponent(c.slug)}/${src.split('/').map(encodeURIComponent).join('/')}`}
function renderDates(){
 const c=current(),host=$('[data-date-list]'),summary=$('[data-date-summary]');if(!c||!host)return;
 const rows=state.dateCache[c.slug]||[];
 if(summary)summary.textContent='';
 host.innerHTML=rows.length?rows.map((r,i)=>`<button class="date-row" data-date-i="${i}" title="前往 ${esc(r.date)}"><span class="date-preview">${r.preview?`<img class="date-preview" loading="lazy" alt="" src="${esc(previewURL(c,r.preview))}">`:'◷'}</span><span class="date-row-main"><b>${esc(r.date)}</b><small>第 ${fmt(r.page)} 页 · 消息 #${esc(r.id)}</small></span><span class="date-count">${fmt(r.count)} 条</span></button>`).join(''):'<p class="empty">没有可以导航的日期</p>';
 $$('[data-date-i]',host).forEach(b=>b.onclick=()=>{const r=rows[Number(b.dataset.dateI)];if(!r)return;state.page=Number(r.page)||1;state.anchor='';state.dateTarget=r.date;closeDates();renderMain()});
}
function openDates(){const c=current();if(!c)return;$('[data-date-modal]')?.classList.add('open');if(state.dateCache[c.slug]){renderDates();return}
 const old=window.__TAK_DATES__;window.__TAK_DATES__=undefined;
 const script=document.createElement('script');script.src=`chats/${encodeURIComponent(c.slug)}/data/date-index.js`;
 script.onload=()=>{state.dateCache[c.slug]=Array.isArray(window.__TAK_DATES__)?window.__TAK_DATES__:[];renderDates()};
 script.onerror=()=>{state.dateCache[c.slug]=[];renderDates()};document.head.appendChild(script)
}

function renderHeader(){const c=current(),cur=$('[data-current]'),actions=$('[data-chat-actions]');
 if(cur)cur.innerHTML=c?`<span class="top-avatar avatar" style="${avatarStyle(c.id||c.name)}">${letters(c.name)}</span><span class="current-copy"><span class="current-title">${esc(c.name)}</span><span class="current-sub">${fmt(c.messages)} 条消息 · ${fmt(c.images||0)} 图片 · ${fmt(c.videos||0)} 视频 · ${fmt((c.audio||0)+(c.files||0))} 音频/文件${c.official_exports?` · ${fmt(c.official_exports)} 份官方导出`:''}${c.missing?` · 缺 ${fmt(c.missing)}`:''}</span></span>`:`<span class="current-copy"><span class="current-title">Telegram Archive Library</span><span class="current-sub">${fmt(LIB.chats.length)} 个聊天</span></span>`;
 if(actions){
  if(mergeMenuAbort){mergeMenuAbort.abort();mergeMenuAbort=null}
  document.querySelectorAll('body>.tak-merge-portal').forEach(n=>n.remove());
  const mergeLabels={classic:'智能合并',original:'原版（严格）',reconstructed:'原版（还原）',minute:'同分钟合并',sender:'同发送者合并',media:'媒体批次合并'};
  actions.innerHTML=c?`<div class="merge-control" data-merge-control data-merge-mode><button class="merge-picker" data-merge-trigger type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="消息呈现方式"><span class="merge-current">${mergeLabels[state.merge]||mergeLabels.classic}</span><svg class="tak-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="merge-options" data-merge-options role="listbox" aria-label="选择消息合并方式" hidden><button role="option" data-merge-choice="classic" title="同发送者、相邻且满足安全条件的消息，900 秒以内合并">智能合并</button><button role="option" data-merge-choice="original" title="只使用 Telegram 的 grouped_id，还原原始消息结构">原版（严格）</button><button role="option" data-merge-choice="reconstructed" title="在真实 grouped_id 基础上谨慎推断连续文件批次">原版（还原）</button><div class="merge-menu-separator" role="separator"></div><button role="option" data-merge-choice="minute" title="按同发送者、同一分钟合并">同分钟合并</button><button role="option" data-merge-choice="sender" title="相同发送者的一小时内连续消息合并">同发送者合并</button><button role="option" data-merge-choice="media" title="相同发送者的安全连续媒体（180 秒内）合并">媒体批次合并</button></div></div><button class="iconbtn" data-date-open title="完整日期导航（跨分页）" aria-label="完整日期导航">${icons.calendar}</button><button class="iconbtn" data-info title="聊天详情" aria-label="聊天详情">${icons.info}</button><button class="iconbtn" data-external title="独立打开当前聊天" aria-label="独立打开当前聊天">${icons.external}</button>`:'';
 const control=$('[data-merge-control]',actions),trigger=$('[data-merge-trigger]',actions),options=$('[data-merge-options]',actions);
 if(control&&trigger&&options){
  const events=new AbortController();mergeMenuAbort=events;
  const close=()=>{options.hidden=true;options.classList.remove('tak-merge-portal');trigger.setAttribute('aria-expanded','false');if(options.parentNode!==control)control.appendChild(options)};
  const position=()=>{
   const rect=trigger.getBoundingClientRect(),w=Math.ceil(rect.width);
   options.style.width=w+'px';options.style.left=Math.max(8,Math.min(innerWidth-w-8,rect.left))+'px';
   const h=Math.min(options.scrollHeight||290,innerHeight*.68);
   options.style.top=(innerHeight-rect.bottom>=h+10?rect.bottom+7:Math.max(8,rect.top-h-7))+'px';
  };
  const open=()=>{document.body.appendChild(options);options.classList.add('tak-merge-portal');options.hidden=false;position();trigger.setAttribute('aria-expanded','true');options.querySelector(`[data-merge-choice="${state.merge}"]`)?.focus({preventScroll:true})};
  trigger.addEventListener('click',()=>options.hidden?open():close(),{signal:events.signal});
  $$('[data-merge-choice]',options).forEach(b=>{b.setAttribute('aria-selected',String(b.dataset.mergeChoice===state.merge));b.addEventListener('click',()=>{close();changeMerge(b.dataset.mergeChoice)},{signal:events.signal})});
  options.addEventListener('keydown',e=>{const items=$$('[data-merge-choice]',options),i=items.indexOf(document.activeElement);if(e.key==='Escape'){e.preventDefault();close();trigger.focus()}else if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();const j=e.key==='Home'?0:e.key==='End'?items.length-1:e.key==='ArrowDown'?(i+1)%items.length:(i-1+items.length)%items.length;items[j]?.focus({preventScroll:true})}else if(e.key==='Enter'||e.key===' '){e.preventDefault();document.activeElement?.click()}},{signal:events.signal});
  const outside=e=>{if(!options.hidden&&!control.contains(e.target)&&!options.contains(e.target))close()};
  document.addEventListener('pointerdown',outside,{capture:true,signal:events.signal});
  document.addEventListener('focusin',outside,{signal:events.signal});
  window.addEventListener('blur',close,{signal:events.signal});
  window.addEventListener('resize',()=>{if(!options.hidden)position()},{signal:events.signal});
  window.addEventListener('scroll',e=>{if(!options.hidden&&!options.contains(e.target))close()},{capture:true,signal:events.signal});
 }

 $('[data-date-open]',actions)?.addEventListener('click',openDates);
 $('[data-info]',actions)?.addEventListener('click',openDetails);
 $('[data-external]',actions)?.addEventListener('click',()=>{const now=current();if(now)(()=>{const url=new URL(iframeSrc(now),location.href);url.searchParams.delete('embed');window.open(url.href,'_blank','noopener')})()})
 }
}
function iframeSrc(c){let rel=c.messages_rel||`chats/${c.slug}/messages.html`;if(state.page>1){rel=rel.replace(/messages(?:\d+)?\.html(?:\?.*)?$/i,`messages${state.page}.html`)}if(state.merge==='original'){rel=rel.replace(/(\/)(messages\d*\.html)/i,'$1strict-$2')}const sep=rel.includes('?')?'&':'?';return`${rel}${sep}embed=1&mode=${encodeURIComponent(state.merge)}&merge=${['original','reconstructed'].includes(state.merge)?'0':'1'}${state.dateTarget?'&date='+encodeURIComponent(state.dateTarget):''}${state.anchor?'#'+encodeURIComponent(state.anchor):''}`}
function renderMain(){const c=current(),main=$('[data-main]');if(!main)return;if(!c){main.innerHTML=homeMarkup();bindHomeSort();$$('[data-chat]',main).forEach(b=>b.addEventListener('click',()=>selectChat(b.dataset.chat)));return}main.innerHTML=`<iframe id="chat-frame" class="frame" src="${esc(iframeSrc(c))}" title="${esc(c.name)}"></iframe>`}
function selectChat(slug,{updateHash=true}={}){if(slug&&!LIB.chats.some(c=>c.slug===slug))slug='';if(slug!==state.chat){state.page=1;state.pageItems=0;state.anchor='';state.dateTarget=''}state.chat=slug;state.mobile=false;window.TAKLightbox?.close();if(slug)remember(slug);if(updateHash)setHash(slug);$('.shell')?.classList.remove('mobile-open');renderChatList();renderHeader();renderMain()}
function toggleSidebar(){const shell=$('.shell');if(!shell)return;if(innerWidth<=820){state.mobile=!state.mobile;shell.classList.toggle('mobile-open',state.mobile);const btn=$('[data-side]');if(btn){btn.title=state.mobile?'收起侧边栏':'展开侧边栏';btn.setAttribute('aria-label',btn.title);const label=btn.querySelector('.collapse-label');if(label)label.textContent=btn.title}}else{state.collapsed=!state.collapsed;shell.classList.toggle('sidebar-collapsed',state.collapsed);const lab=$('.collapse-label');if(lab)lab.textContent=state.collapsed?'展开侧边栏':'收起侧边栏';const btn=$('[data-side]');if(btn){const svg=btn.querySelector('svg');if(svg)svg.outerHTML=state.collapsed?icons.panelOpen:icons.panelClose;btn.title=state.collapsed?'展开侧边栏':'收起侧边栏';btn.setAttribute('aria-label',btn.title)}}}
function showFocusHint(){const el=$('[data-focus-hint]');if(!el)return;clearTimeout(state.hintTimer);el.classList.add('show');state.hintTimer=setTimeout(()=>el.classList.remove('show'),1400)}
function toggleFocus(force){state.focus=typeof force==='boolean'?force:!state.focus;$('.shell')?.classList.toggle('focus',state.focus);const frame=$('#chat-frame');if(frame?.contentWindow)frame.contentWindow.postMessage({type:'tak-focus-state',active:state.focus},(location.protocol==='file:'?'*':location.origin));if(state.focus&&innerWidth>820)showFocusHint()}
function bindStatic(){document.addEventListener('pointerdown',e=>{const root=$('[data-home-sort-root]');if(root&&!root.contains(e.target)){const m=$('.home-sort-menu',root),picker=$('[data-home-sort-picker]',root);if(m&&!m.hidden){m.hidden=true;picker?.setAttribute('aria-expanded','false')}}},true);document.addEventListener('keydown',e=>{if(e.key==='Escape'){const root=$('[data-home-sort-root]'),m=root&&$('.home-sort-menu',root);if(m&&!m.hidden){e.stopPropagation();m.hidden=true;$('[data-home-sort-picker]',root)?.setAttribute('aria-expanded','false');$('[data-home-sort-picker]',root)?.focus()}}});$('[data-mobile-menu]')?.addEventListener('click',()=>{state.mobile=true;$('.shell')?.classList.add('mobile-open');const btn=$('[data-side]');if(btn){btn.title='收起侧边栏';btn.setAttribute('aria-label',btn.title);const label=btn.querySelector('.collapse-label');if(label)label.textContent=btn.title}});$('[data-side]')?.addEventListener('click',toggleSidebar);$('[data-focus]')?.addEventListener('click',()=>toggleFocus());$$('[data-home]').forEach(b=>b.addEventListener('click',()=>selectChat('')));$('[data-overlay]')?.addEventListener('click',()=>{state.mobile=false;$('.shell')?.classList.remove('mobile-open')});const search=$('[data-chat-search]');search?.addEventListener('input',e=>{state.q=e.target.value;renderChatList();if(!current())renderMain()});$('[data-detail-close]')?.addEventListener('click',closeDetails);$('[data-date-close]')?.addEventListener('click',closeDates);$('[data-date-modal]')?.addEventListener('click',e=>{if(e.target===e.currentTarget)closeDates()});$('[data-detail-modal]')?.addEventListener('click',e=>{if(e.target===e.currentTarget)closeDetails()})}
function init(){$('#app').innerHTML=appMarkup();bindStatic();let initial=parseHash();if(initial&&!LIB.chats.some(c=>c.slug===initial))initial='';if(!initial){try{const last=localStorage.getItem('tak-last-chat');if(last&&LIB.chats.some(c=>c.slug===last))initial=last}catch{}}if(!initial&&LIB.chats.length===1)initial=LIB.chats[0].slug;selectChat(initial,{updateHash:false});const lab=$('.collapse-label');if(lab)lab.textContent='展开侧边栏'}
window.addEventListener('hashchange',()=>{const h=parseHash();if(h!==state.chat)selectChat(h,{updateHash:false})});window.addEventListener('message',e=>{if(e.data?.type==='tak-chat-ready'){const frame=$('#chat-frame');if(frame&&e.source===frame.contentWindow){frame.contentWindow.postMessage({type:'tak-parent-viewer-ready'},(location.protocol==='file:'?'*':location.origin));frame.contentWindow.postMessage({type:'tak-focus-state',active:state.focus},(location.protocol==='file:'?'*':location.origin))}if(Number(e.data.page)>0)state.page=Number(e.data.page);state.pageItems=Number(e.data.count||0);state.anchor='';state.dateTarget='';const c=current();if(c){document.title=`${c.name} · Prism Archive`;renderHeader()}}else if(e.data?.type==='tak-global-lightbox-open'){const frame=$('#chat-frame');if(frame&&e.source===frame.contentWindow)window.TAKLightbox?.open(e.data.items,e.data.index)}else if(e.data?.type==='tak-toggle-focus'){const frame=$('#chat-frame');if(frame&&e.source===frame.contentWindow&&(e.origin===location.origin||(location.protocol==='file:'&&e.origin==='null')))toggleFocus()}else if(e.data?.type==='tak-exit-focus'&&state.focus)toggleFocus(false)});window.addEventListener('keydown',e=>{if(e.key==='Escape'){if($('[data-date-modal]')?.classList.contains('open')){closeDates();return}if($('[data-detail-modal]')?.classList.contains('open')){closeDetails();return}if(state.focus)toggleFocus(false)}});init();
})();
