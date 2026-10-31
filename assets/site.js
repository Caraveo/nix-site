(() => {
const button=document.querySelector('.menu-toggle'),links=document.getElementById('site-links');
button?.addEventListener('click',()=>{const expanded=button.getAttribute('aria-expanded')==='true';button.setAttribute('aria-expanded',String(!expanded));links.classList.toggle('is-open',!expanded);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&button?.getAttribute('aria-expanded')==='true'){button.setAttribute('aria-expanded','false');links.classList.remove('is-open');button.focus();}});
const legacy={"your-control": "/why#your-control", "builders": "/build#builders", "drivers": "/build#drivers", "architecture": "/architecture#architecture", "intent-flow": "/architecture#intent-flow", "local-ai": "/architecture#local-ai", "references": "/architecture#references", "opencode": "/opencode#opencode", "pods": "/pods#pods", "memories": "/memories#memories", "roadmap": "/plan#roadmap", "decisions": "/plan#decisions"};
if(location.pathname==='/'&&legacy[location.hash.slice(1)])location.replace(legacy[location.hash.slice(1)]);
})();
