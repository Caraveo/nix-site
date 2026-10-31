(() => {
const button=document.querySelector('.menu-toggle'),links=document.getElementById('site-links');
button?.addEventListener('click',()=>{const expanded=button.getAttribute('aria-expanded')==='true';button.setAttribute('aria-expanded',String(!expanded));links.classList.toggle('is-open',!expanded);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&button?.getAttribute('aria-expanded')==='true'){button.setAttribute('aria-expanded','false');links.classList.remove('is-open');button.focus();}});
const themes=['black','white','pallet'];
const themeColors={black:'#000000',white:'#ffffff',pallet:'#f4eeeb'};
const themeGroup=document.querySelector('.theme-toggle');
function applyTheme(theme,persist){if(!themes.includes(theme))theme='pallet';document.documentElement.dataset.theme=theme;const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.setAttribute('content',themeColors[theme]);if(persist){try{localStorage.setItem('nix-theme',theme);}catch(e){}}document.querySelectorAll('[data-theme-choice]').forEach(btn=>{const on=btn.dataset.themeChoice===theme;btn.setAttribute('aria-checked',String(on));btn.tabIndex=on?0:-1;});}
applyTheme(document.documentElement.dataset.theme||'pallet',false);
themeGroup?.addEventListener('click',e=>{const choice=e.target.closest('[data-theme-choice]');if(choice)applyTheme(choice.dataset.themeChoice,true);});
themeGroup?.addEventListener('keydown',e=>{const buttons=[...themeGroup.querySelectorAll('[data-theme-choice]')];const index=buttons.findIndex(btn=>btn.getAttribute('aria-checked')==='true');let next=index;if(e.key==='ArrowRight')next=(index+1)%buttons.length;else if(e.key==='ArrowLeft')next=(index-1+buttons.length)%buttons.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=buttons.length-1;else return;e.preventDefault();applyTheme(buttons[next].dataset.themeChoice,true);buttons[next].focus();});
const legacy={"your-control": "/why#your-control", "builders": "/custom#builders", "drivers": "/custom#drivers", "architecture": "/architecture#architecture", "intent-flow": "/architecture#intent-flow", "local-ai": "/architecture#local-ai", "references": "/architecture#references", "opencode": "/opencode#opencode", "pods": "/pods#pods", "memories": "/memories#memories", "roadmap": "/plan#roadmap", "decisions": "/plan#decisions"};
if(location.pathname==='/'&&legacy[location.hash.slice(1)])location.replace(legacy[location.hash.slice(1)]);
})();
