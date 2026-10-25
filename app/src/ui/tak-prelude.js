(()=>{'use strict';
// Run before telegram-export-beautifier reorganizes the exported DOM. The
// genuine grouped_id album is already a single message bubble in the generator.
const qs=new URLSearchParams(location.search);
const allowed=['classic','original','reconstructed','minute','sender','media'];
let mode=qs.get('mode')||'classic';
if(!allowed.includes(mode))mode='classic';
document.documentElement.dataset.takMerge=mode;
let last=null;
for(const el of document.querySelectorAll('.history > .message')){
 if(!el.classList.contains('default')){last=null;continue}
 const p=last,ts=Number(el.dataset.takTs||0),prevTS=Number(p?.dataset.takTs||0);
 const same=!!p && p.dataset.takFrom===el.dataset.takFrom && ts>0 && prevTS>0 && ts>=prevTS;
 const delta=same?ts-prevTS:Infinity;
 const hasMedia=!!el.querySelector('.media_wrap > a');
 const prevHasMedia=!!p?.querySelector('.media_wrap > a');
 const safe=hasMedia&&prevHasMedia && !el.querySelector('.reply_to, .forwarded') && !p?.querySelector('.reply_to, .forwarded');
 let joined=el.classList.contains('joined');
 if(mode==='original'||mode==='reconstructed')joined=false; // Only source grouped_id albums remain intact; never infer groups by time
 else if(mode==='minute')joined=same&&Math.floor(ts/60)===Math.floor(prevTS/60);
 else if(mode==='sender')joined=same&&delta<=3600;
 else if(mode==='media')joined=same&&safe&&delta<=180;
 el.classList.toggle('joined',!!joined);
 last=el;
}
})();
