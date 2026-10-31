// Own, public-safe fixtures for libdetect. Each source below is AUTHORED HERE as a signature carrier: it contains the
// string literals, property names and class names a real build of the library would keep after minification, wrapped in
// small invented code. None of it is copied library code or site code (PLAN H2/H3). What these tests prove is the
// matching, scoring and provenance logic; how well the signatures match real builds is checked separately by
// calibration.test.js against library files present on this machine (skipped elsewhere).

export const synthetic = {
  // GSAP, banner kept (what an unminified or licence-preserving build looks like)
  gsapBanner: `/*!\n * GSAP 3.12.5\n * https://gsap.com\n * @license Copyright 2024, GreenSock. Subject to the terms at https://gsap.com/standard-license\n */\n` +
    `(function(g){var cfg={autoSleep:120,force3D:"auto",nullTargetWarn:1};g.GreenSockGlobals=g.GreenSockGlobals||{};(g.gsapVersions||(g.gsapVersions=[])).push("3.12.5");` +
    `function warn(t){console.warn("GSAP target "+t+" not found. https://gsap.com")}` +
    `var o={to:function(){},killTweensOf:function(){},lagSmoothing:function(){}};var d={yoyoEase:1,immediateRender:1,staggerTo:1};g.gsap=o;})(window);`,
  // GSAP, banner stripped by a minifier: only API surface and the expando survive
  gsapStripped: `!function(w){var a={yoyoEase:0,immediateRender:!1,staggerTo:1,lagSmoothing:1,autoSleep:60};function t(e){e._gsap=e._gsap||{x:0}}w.q=a}(window);`,
  // GSAP's version literal chain, as a minifier leaves it (no banner)
  gsapVersionLiteral: `!function(){var a={yoyoEase:0,immediateRender:!1,killTweensOf:1,lagSmoothing:1};(window.gsapVersions||(window.gsapVersions=[])).push(a.version);o.version=p.version="3.11.4",x=1}();`,
  scrollTrigger: `/*!\n * ScrollTrigger 3.12.5\n */\nvar S={scrollerProxy:function(){},toggleActions:"play none none none",refresh:1};document.createElement("div").className="pin-spacer";console.warn("Requires GSAP 3.11.0 or later");`,
  // ScrollTrigger-shaped code with nothing that names the GSAP core (host must be implied)
  scrollTriggerOnly: `var S={scrollerProxy:function(){},toggleActions:"play none none none"};S.pinSpacer="pin-spacer";var banner="ScrollTrigger 3.12.5";/* ScrollTrigger 3.12.5 */\n/*! \n * ScrollTrigger 3.12.5\n */`,
  lenis: `!function(){var e="1.3.26";class L{constructor(o){window.lenisVersion=e,window.lenis||(window.lenis={}),this.o=Object.assign({smoothWheel:!0,wheelMultiplier:1,touchMultiplier:1,syncTouch:!1,lerp:.1},o)}` +
    `get className(){let c="lenis";return this.stopped&&(c+=" lenis-stopped"),this.smooth&&(c+=" lenis-smooth"),c}}window.Lenis=L}();`,
  motion: `const o={type:"spring",stiffness:100,damping:10,mass:1,restSpeed:2,restDelta:.5,visualDuration:.3};const p={whileHover:1,whileInView:1,whileTap:1,dragConstraints:1,dragElastic:.5,layoutId:"a",projection:null};` +
    `const f=()=>document.createElement("div").animate({opacity:0},{easing:"linear(0, 1)"});const v="viewTimeline";const x="data-framer-appear-id";`,
  three: `/**\n * @license\n * Copyright 2010-2024 Three.js Authors\n */\nconst REVISION="165";class R{constructor(c){c.setAttribute("data-engine",\`three.js r\${REVISION}\`);this.isWebGLRenderer=!0}}`,
  threeShader: `precision highp float;\nuniform mat4 modelMatrix;\nuniform vec3 cameraPosition;\nuniform bool isOrthographic;\nvoid main(){gl_FragColor=vec4(1.);}`,
  lottie: `window.lottie={};lottie.version="5.12.2";var id=function(){return"__lottie_element_"+(n+=1)};lottie.loadAnimation=1;lottie.goToAndStop=1;lottie.registerAnimation=1;window.bodymovin=window.lottie;`,
  lottieJson: JSON.stringify({ v: '5.7.4', fr: 30, ip: 0, op: 60, w: 100, h: 100, nm: 'x', layers: [] }),
  anime: `var anime={};anime.version="3.2.2";anime.suspendWhenDocumentHidden=!0;anime.setDashoffset=function(){};anime.convertPx=function(){};anime.penner={};`,
  locomotive: `document.documentElement.classList.add("has-scroll-smooth","has-scroll-init");var c="data-scroll-container",s="data-scroll-section",b="c-scrollbar_thumb";`,
  reactSpring: `var config={default:{tension:170,friction:26},gentle:{tension:120,friction:14},wobbly:{tension:180,friction:12},molasses:{tension:280,friction:120}};`,
  // ordinary app code that mentions motion words without being any library
  appCode: `export function ease(t){return t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2}\nlet lerp=(a,b,t)=>a+(b-a)*t;const bounce=3,tension=.5,friction=.2,precision=1e-3,clamp=(v,a,b)=>Math.min(b,Math.max(a,v));\n` +
    `const spring={stiffness:90,damping:12};function render(){requestAnimationFrame(render)}render();const classes=["pin-spacer","swiper","lensish","flick"];`,
  cssCollision: `.pin-spacer{position:relative}.pin-spacer>.inner{display:block}.hero .aos{opacity:1}`,
};

export const htmlWithCdn = `<!doctype html><html><head>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/ScrollTrigger.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/lenis@1.1.9/dist/lenis.min.js"></script>
<script src="https://unpkg.com/three@0.160.0/build/three.module.js"></script>
</head><body><p>cdn only</p></body></html>`;

export const sourceMap = JSON.stringify({
  version: 3, file: 'app.js',
  sources: ['../node_modules/three/build/three.module.js', '../src/main.js', '../node_modules/framer-motion/dist/es/index.mjs'],
  sourcesContent: [null, 'export const x = 1;', null],
});

/** Scroll position after one wheel impulse that ended at t = 0: remaining distance shrinks by `perFrame` every frame. */
export function lerpTrace({ perFrame = 0.1, frameMs = 1000 / 60, distance = 600, frames = 120 } = {}) {
  const samples = []; let r = distance;
  for (let i = 0; i <= frames; i++) { samples.push({ t: i * frameMs, y: Math.round(distance - r) }); r *= 1 - perFrame; }
  return { samples, inputEndT: 0, frameMs };
}
/** Duration-based expo.out tween (Lenis-style `duration` mode): y = d * (1 - 2^(-10 p)) clipped at 1 for p >= 1. */
export function expoTrace({ duration = 1200, frameMs = 1000 / 60, distance = 600 } = {}) {
  const samples = [];
  for (let t = 0; t <= duration + 400; t += frameMs) { const p = Math.min(1, t / duration); samples.push({ t, y: Math.round(distance * Math.min(1, 1.001 - Math.pow(2, -10 * p))) }); }
  return { samples, inputEndT: 0, frameMs };
}
export function linearTrace({ ms = 600, frameMs = 1000 / 60, distance = 600 } = {}) {
  const samples = [];
  for (let t = 0; t <= ms + 200; t += frameMs) samples.push({ t, y: Math.round(distance * Math.min(1, t / ms)) });
  return { samples, inputEndT: 0, frameMs };
}
export function instantTrace({ frameMs = 1000 / 60, distance = 600 } = {}) {
  const samples = []; for (let i = 0; i < 30; i++) samples.push({ t: i * frameMs, y: i === 0 ? 0 : distance });
  return { samples, inputEndT: 0, frameMs };
}
