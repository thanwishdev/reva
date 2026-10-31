// Motion-library signature table (PLAN M4 / P4: bundle-signature motion-library detection).
//
// Why string literals and property names: a minifier renames identifiers but must keep string literals, object property
// names, CSS class names, attribute names and licence banners. So every signature below is one of those, never a
// local variable name. Signatures are matched per DISTINCT signature id (ten hits of one literal count once), then the
// weights add up:
//   5 = definitive (one hit is enough), 4 = strong, 3 = medium, 2 = weak, 1 = trace (never enough alone).
//   score >= 5 -> "detected", 3..4 -> "probable", 1..2 -> "hint".
//
// Signature spec:  { id, w, s | re | all, in?, role?, note? }
//   s    exact substring            re  RegExp (no g flag, bounded quantifiers)      all  every substring must occur
//   in   restrict to module kinds (js|html|css|json|glsl|text|path); default: every kind except glsl and path
//   role 'impl' (default: library code is present) | 'usage' (app code calls the API; the library may come from a CDN)
// DOM spec (runtime evidence from probe.js):  { id, w, kind: class|classPrefix|attr|attrPrefix|global|expando|engine|tag, value, fires? }
//   fires = true: the thing is created by the library at run time, so observing it is firing proof (PLAN §3).
//
// Calibration (H6, no silent claims): `calibration.state`
//   'calibrated'       signatures were run against a real build of the library (listed in `builds`) and every signature
//                      claimed there matched;
//   'api-literals-only' signatures come from the library's documented API/class names; no real build was available
//                      offline when this table was written, so it is not verified against minified output.
// The calibration builds are library files only (no site code); the table itself holds no site-derived value (H2).

/** Package-style evidence is generated from `packages` for every library: module path, source-map source, CDN URL. */
export const LIBRARIES = [
  {
    id: 'gsap', name: 'GSAP', category: 'tween-engine', packages: ['gsap'], files: [/(^|[\\/._-])gsap([\\/._-]|$)/i],
    calibration: { state: 'calibrated', builds: ['gsap 3.9.1 min', 'gsap-core 3.x unminified', 'gsap 3.x esm bundle chunk'] },
    signatures: [
      { id: 'greensock-globals', w: 5, s: 'GreenSockGlobals' },
      { id: 'gsap-versions-array', w: 5, s: 'gsapVersions' },
      { id: 'core-api-surface', w: 5, all: ['yoyoEase', 'killTweensOf', 'immediateRender', 'lagSmoothing'], note: 'GSAP core option and method names' },
      { id: 'banner', w: 4, re: /\*\s+GSAP \d+\.\d+\.\d+/ },
      { id: 'license-url', w: 3, re: /greensock\.com\/(?:standard-)?licen[cs]e|gsap\.com\/standard-license/ },
      { id: 'warn-url', w: 3, re: /GSAP target [^"'`]{0,40}not found\. https:\/\/(?:gsap|greensock)\.com/ },
      { id: 'expando', w: 2, re: /[.\[]_gsap\b|"_gsap"/, note: 'per-target state object GSAP stores on animated elements' },
      { id: 'lag-smoothing', w: 2, s: 'lagSmoothing' },
      { id: 'auto-sleep', w: 2, s: 'autoSleep' },
      { id: 'tween-options', w: 2, all: ['staggerTo', 'immediateRender'] },
      { id: 'api-calls', w: 3, role: 'usage', re: /\bgsap\.(?:to|from|fromTo|timeline|set|registerPlugin|quickTo|quickSetter|context|matchMedia|killTweensOf|getProperty)\s*\(|\bgsap\.(?:utils|ticker|core)\./ },
    ],
    dom: [
      { id: 'global-gsap', w: 3, kind: 'global', value: 'gsap', fires: true },
      { id: 'global-greensock', w: 5, kind: 'global', value: 'GreenSockGlobals', fires: true },
      { id: 'element-expando', w: 4, kind: 'expando', value: '_gsap', fires: true },
    ],
    version: [{ re: /\*\s+GSAP (\d+\.\d+\.\d+)/, from: 'banner' }, { re: /\.version\s*=\s*[`"'](3\.\d+\.\d+)[`"']/, from: 'version-literal', needs: 'gsapVersions' }],
    runtimeVersion: 'gsap.version',
  },
  {
    id: 'gsap-scrolltrigger', name: 'GSAP ScrollTrigger', category: 'scroll-linked', packages: ['gsap/ScrollTrigger'], files: [/scrolltrigger/i], requires: 'gsap',
    calibration: { state: 'calibrated', builds: ['ScrollTrigger 3.12.2 min', 'ScrollTrigger 3.x unminified'] },
    signatures: [
      { id: 'banner', w: 5, re: /\*\s+ScrollTrigger \d+\.\d+\.\d+/ },
      { id: 'pin-spacer', w: 2, s: 'pin-spacer', note: 'generic class name: sites write their own .pin-spacer, so it is weak on its own' },
      { id: 'scroller-proxy', w: 4, s: 'scrollerProxy' },
      { id: 'toggle-actions', w: 3, s: 'toggleActions' },
      { id: 'marker-classes', w: 2, s: 'gsap-marker-' },
      { id: 'registration', w: 2, re: /Requires GSAP \d+\.\d+\.\d+ or later/ },
      { id: 'api-calls', w: 3, role: 'usage', re: /(?<![.\w$])ScrollTrigger\.(?:create|refresh|batch|matchMedia|normalizeScroll|getAll|update|config)\s*\(|\bscrollTrigger\s*:\s*\{/ },
    ],
    dom: [
      { id: 'pin-spacer-class', w: 2, kind: 'class', value: 'pin-spacer' },
      { id: 'global-scrolltrigger', w: 3, kind: 'global', value: 'ScrollTrigger', fires: true },
    ],
    version: [{ re: /\*\s+ScrollTrigger (\d+\.\d+\.\d+)/, from: 'banner' }, { re: /\.version\s*=\s*"(\d+\.\d+\.\d+)"[^;]{0,200}\.saveStyles\s*=/, from: 'version-literal' }],
    runtimeVersion: 'ScrollTrigger.version',
  },
  {
    id: 'gsap-scrollsmoother', name: 'GSAP ScrollSmoother', category: 'smooth-scroll', packages: ['gsap/ScrollSmoother'], files: [/scrollsmoother/i], requires: 'gsap',
    calibration: { state: 'api-literals-only', builds: [] },
    signatures: [
      { id: 'banner', w: 5, re: /\*\s+ScrollSmoother \d+\.\d+\.\d+/ },
      { id: 'wrapper-ids', w: 4, all: ['smooth-wrapper', 'smooth-content'] },
      { id: 'api-calls', w: 4, role: 'usage', re: /\bScrollSmoother\.(?:create|get)\s*\(/ },
    ],
    dom: [
      { id: 'wrapper-id', w: 2, kind: 'attr', value: 'id=smooth-wrapper' },
      { id: 'global-scrollsmoother', w: 3, kind: 'global', value: 'ScrollSmoother', fires: true },
    ],
    version: [{ re: /\*\s+ScrollSmoother (\d+\.\d+\.\d+)/, from: 'banner' }],
  },
  {
    id: 'gsap-splittext', name: 'GSAP SplitText', category: 'text-split', packages: ['gsap/SplitText'], files: [/splittext/i], requires: 'gsap',
    calibration: { state: 'api-literals-only', builds: [] },
    signatures: [
      { id: 'banner', w: 5, re: /\*\s+SplitText \d+\.\d+\.\d+/ },
      { id: 'option-names', w: 4, all: ['charsClass', 'wordsClass', 'linesClass'] },
      { id: 'api-calls', w: 3, role: 'usage', re: /new SplitText\s*\(|SplitText\.create\s*\(/ },
    ],
    dom: [{ id: 'global-splittext', w: 3, kind: 'global', value: 'SplitText', fires: true }],
    version: [{ re: /\*\s+SplitText (\d+\.\d+\.\d+)/, from: 'banner' }],
  },
  {
    id: 'motion', name: 'Motion (framer-motion / motion / popmotion lineage)', category: 'tween-spring-engine', packages: ['framer-motion', 'motion', 'motion-dom', 'motion-utils', 'popmotion', '@motionone/dom'], files: [/(^|[\\/._-])(framer-motion|motion-dom|popmotion)([\\/._-]|$)/i],
    calibration: { state: 'calibrated', builds: ['framer-motion 12.38 UMD min', 'motion-dom 12.x min'] },
    signatures: [
      { id: 'appear-id', w: 5, s: 'data-framer-appear-id' },
      { id: 'motion-global-config', w: 4, s: 'MotionGlobalConfig' },
      { id: 'spring-options', w: 3, all: ['stiffness', 'damping', 'restDelta', 'restSpeed'], note: 'popmotion/Motion spring option set (react-spring uses tension/friction)' },
      { id: 'visual-duration', w: 3, s: 'visualDuration' },
      { id: 'gesture-props', w: 3, all: ['whileHover', 'whileInView', 'whileTap'] },
      { id: 'drag-props', w: 2, all: ['dragConstraints', 'dragElastic'] },
      { id: 'layout-projection', w: 3, all: ['layoutId', 'projection'] },
      { id: 'animate-presence', w: 3, re: /AnimatePresence|popLayout/ },
      { id: 'waapi-feature-test', w: 2, all: ['viewTimeline', 'linear(0, 1)'], note: 'Motion feature-detects ViewTimeline and linear() easing' },
      { id: 'generated-linear-easing', w: 2, re: /`linear\(\$\{|"linear\("\s*\+/ },
    ],
    dom: [
      { id: 'appear-attr', w: 4, kind: 'attrPrefix', value: 'data-framer-appear', fires: true },
      { id: 'projection-attr', w: 3, kind: 'attr', value: 'data-projection-id', fires: true },
      { id: 'framer-motion-attr', w: 2, kind: 'attrPrefix', value: 'data-framer-' },
    ],
    version: [],
    versionUnknownReason: 'framer-motion/motion builds do not embed their version as a literal',
  },
  {
    id: 'lenis', name: 'Lenis', category: 'smooth-scroll', packages: ['lenis', '@studio-freight/lenis'], files: [/(^|[\\/._-])lenis([\\/._-]|$)/i],
    calibration: { state: 'calibrated', builds: ['lenis 1.3.26 min', 'lenis 1.3.26 mjs'] },
    signatures: [
      { id: 'version-global', w: 5, s: 'lenisVersion' },
      { id: 'html-classes', w: 4, all: ['lenis-smooth', 'lenis-stopped'] },
      { id: 'class-smooth', w: 4, s: 'lenis-smooth' },
      { id: 'prevent-attr', w: 3, s: 'data-lenis-prevent' },
      { id: 'scrolling-class', w: 3, s: 'lenis-scrolling' },
      { id: 'option-names', w: 3, all: ['smoothWheel', 'wheelMultiplier', 'touchMultiplier'] },
      { id: 'sync-touch', w: 2, s: 'syncTouch' },
      { id: 'word', w: 1, re: /\blenis\b/i },
      { id: 'api-calls', w: 3, role: 'usage', re: /new Lenis\s*\(|\blenis\.(?:raf|scrollTo|on|start|stop|resize)\s*\(/ },
    ],
    dom: [
      { id: 'html-class', w: 4, kind: 'class', value: 'lenis', fires: true },
      { id: 'html-class-smooth', w: 4, kind: 'class', value: 'lenis-smooth', fires: true },
      { id: 'prevent-attr', w: 3, kind: 'attr', value: 'data-lenis-prevent' },
      { id: 'global-version', w: 5, kind: 'global', value: 'lenisVersion', fires: true },
      { id: 'global-lenis', w: 3, kind: 'global', value: 'lenis', fires: true },
    ],
    version: [{ re: /lenisVersion\s*=\s*(\w+)/, from: 'variable', resolve: 'semver-var' }],
    runtimeVersion: 'lenisVersion',
  },
  {
    id: 'locomotive-scroll', name: 'Locomotive Scroll', category: 'smooth-scroll', packages: ['locomotive-scroll'], files: [/locomotive/i],
    calibration: { state: 'api-literals-only', builds: [] },
    signatures: [
      { id: 'smooth-class', w: 5, s: 'has-scroll-smooth' },
      { id: 'init-class', w: 4, s: 'has-scroll-init' },
      { id: 'container-attr', w: 4, s: 'data-scroll-container' },
      { id: 'section-attr', w: 3, s: 'data-scroll-section' },
      { id: 'scrollbar-class', w: 3, re: /c-scrollbar(?:_thumb|_rail)?/ },
      { id: 'speed-attr', w: 2, re: /data-scroll-(?:speed|sticky|offset|direction|delay)/ },
      { id: 'api-calls', w: 3, role: 'usage', re: /new LocomotiveScroll\s*\(/ },
    ],
    dom: [
      { id: 'smooth-class', w: 5, kind: 'class', value: 'has-scroll-smooth', fires: true },
      { id: 'init-class', w: 4, kind: 'class', value: 'has-scroll-init', fires: true },
      { id: 'container-attr', w: 3, kind: 'attr', value: 'data-scroll-container' },
      { id: 'scrollbar-class', w: 3, kind: 'class', value: 'c-scrollbar', fires: true },
    ],
    version: [],
    versionUnknownReason: 'no version literal known for this library',
  },
  {
    id: 'animejs', name: 'anime.js', category: 'tween-engine', packages: ['animejs', 'anime'], files: [/(^|[\\/])anime(js)?(\.min)?\.(m?js|umd)/i],
    calibration: { state: 'api-literals-only', builds: [] },
    signatures: [
      { id: 'v3-suspend', w: 5, s: 'suspendWhenDocumentHidden' },
      { id: 'v3-helpers', w: 4, all: ['setDashoffset', 'convertPx'] },
      { id: 'v3-transform-list', w: 3, s: '"translateX","translateY","translateZ","rotate","rotateX"' },
      { id: 'v3-penner', w: 2, s: 'penner' },
      { id: 'v4-factories', w: 4, all: ['createTimer', 'createAnimatable', 'createTimeline'] },
      { id: 'v4-draggable', w: 3, all: ['createDraggable', 'createSpring'] },
      { id: 'api-calls', w: 3, role: 'usage', re: /\banime\s*\(\s*\{[^}]{0,200}targets\s*:|\banime\.timeline\s*\(|\banimate\s*\([^)]{0,80}\{[^}]{0,200}ease\s*:/ },
    ],
    dom: [{ id: 'global-anime', w: 3, kind: 'global', value: 'anime', fires: true }],
    version: [{ re: /\banime\.version\s*=\s*["'](\d+\.\d+\.\d+)["']/, from: 'version-literal' }],
    runtimeVersion: 'anime.version',
  },
  {
    id: 'lottie', name: 'Lottie (lottie-web / dotLottie)', category: 'vector-playback', packages: ['lottie-web', 'lottie-react', '@lottiefiles/dotlottie-web', '@lottiefiles/lottie-player', '@dotlottie/player-component'], files: [/lottie|bodymovin/i],
    calibration: { state: 'calibrated', builds: ['lottie-web 5.7.8 min'] },
    signatures: [
      { id: 'element-id', w: 5, s: '__lottie_element' },
      { id: 'bm-type-attr', w: 4, s: 'data-bm-type' },
      { id: 'bodymovin', w: 3, s: 'bodymovin' },
      { id: 'player-api', w: 3, all: ['loadAnimation', 'goToAndStop', 'registerAnimation'] },
      { id: 'web-component', w: 3, re: /dotlottie-player|lottie-player|dotlottie-wc/ },
      { id: 'animation-data', w: 4, in: ['json', 'js', 'text'], re: /"v"\s*:\s*"\d+\.\d+\.\d+"\s*,\s*"fr"\s*:\s*[\d.]+\s*,\s*"ip"\s*:\s*[\d.]+\s*,\s*"op"\s*:/, role: 'asset', note: 'Lottie animation JSON (the player may be external)' },
    ],
    dom: [
      { id: 'global-lottie', w: 3, kind: 'global', value: 'lottie', fires: true },
      { id: 'global-bodymovin', w: 3, kind: 'global', value: 'bodymovin', fires: true },
      { id: 'tag-lottie-player', w: 4, kind: 'tag', value: 'lottie-player', fires: true },
      { id: 'tag-dotlottie-player', w: 4, kind: 'tag', value: 'dotlottie-player', fires: true },
      { id: 'tag-dotlottie-wc', w: 4, kind: 'tag', value: 'dotlottie-wc', fires: true },
      { id: 'webflow-lottie', w: 3, kind: 'attr', value: 'data-animation-type=lottie' },
    ],
    version: [{ re: /lottie\.version\s*=\s*["'](\d+\.\d+\.\d+)["']/, from: 'version-literal' }],
    runtimeVersion: 'lottie.version',
  },
  {
    id: 'three', name: 'three.js', category: 'webgl-engine', packages: ['three'], files: [/(^|[\\/._-])three([\\/._-]|$)/i],
    calibration: { state: 'calibrated', builds: ['three r15x unminified module', 'three r158 vite min bundle'] },
    signatures: [
      { id: 'data-engine', w: 5, s: 'data-engine', note: 'WebGLRenderer sets canvas data-engine="three.js r<rev>"' },
      { id: 'engine-label', w: 5, re: /three\.js r\$\{|three\.js r\d{2,3}/ },
      { id: 'licence', w: 5, re: /Three\.js Authors/ },
      { id: 'global-flag', w: 4, s: '__THREE__' },
      { id: 'shader-prefix', w: 5, in: ['glsl', 'js', 'text'], all: ['uniform bool isOrthographic', 'uniform vec3 cameraPosition'], note: 'prefix three injects in every compiled shader' },
      { id: 'type-flags', w: 4, all: ['isMesh', 'isBufferGeometry', 'isPerspectiveCamera', 'isShaderMaterial'] },
      { id: 'renderer-flag', w: 2, s: 'isWebGLRenderer' },
      { id: 'object3d-flag', w: 2, s: 'isObject3D' },
      { id: 'shader-chunk', w: 2, s: 'ShaderChunk' },
      { id: 'revision', w: 2, re: /\bREVISION\s*=\s*["']\d{2,3}["']/ },
      { id: 'api-calls', w: 3, role: 'usage', re: /new THREE\.(?:WebGLRenderer|Scene|PerspectiveCamera|Mesh|ShaderMaterial)\s*\(/ },
    ],
    dom: [
      { id: 'canvas-engine', w: 5, kind: 'engine', value: 'three.js', fires: true },
      { id: 'global-three-flag', w: 5, kind: 'global', value: '__THREE__', fires: true },
      { id: 'global-three', w: 3, kind: 'global', value: 'THREE', fires: true },
    ],
    version: [{ re: /\bREVISION\s*=\s*["'](\d{2,3})["']/, from: 'revision-literal', format: (v) => `r${v}` }, { re: /three\.js r(\d{2,3})/, from: 'engine-label', format: (v) => `r${v}` }],
    runtimeVersion: '__THREE__',
    runtimeVersionFormat: (v) => `r${v}`,
    cdnVersionFormat: (v) => v.replace(/^0\.(\d+)\.\d+$/, 'r$1'), // npm 0.160.0 is revision r160
  },
  {
    id: 'react-three-fiber', name: 'React Three Fiber', category: 'webgl-engine', packages: ['@react-three/fiber', '@react-three/drei'], files: [/react-three/i], requires: 'three',
    calibration: { state: 'api-literals-only', builds: [] },
    signatures: [
      { id: 'r3f-expando', w: 5, s: '__r3f' },
      { id: 'canvas-props', w: 3, all: ['frameloop', 'dpr', 'gl', 'shadows'], in: ['js'] },
    ],
    dom: [],
    version: [],
    versionUnknownReason: 'no version literal known for this library',
  },
  {
    id: 'pixi', name: 'PixiJS', category: 'webgl-engine', packages: ['pixi.js', '@pixi/core', '@pixi/app'], files: [/(^|[\\/._-])pixi/i],
    calibration: { state: 'api-literals-only', builds: [] },
    signatures: [
      { id: 'banner', w: 5, re: /PixiJS - v\d+|pixi\.js - v\d+|@pixi\/core/ },
      { id: 'global-pixi', w: 3, re: /\bPIXI\.(?:Application|Sprite|Container|Texture|Graphics|Assets)\b/, role: 'usage' },
      { id: 'shader-attributes', w: 3, in: ['glsl', 'js', 'text'], all: ['aVertexPosition', 'projectionMatrix', 'translationMatrix'] },
    ],
    dom: [{ id: 'global-pixi', w: 4, kind: 'global', value: 'PIXI', fires: true }],
    version: [{ re: /pixi\.js - v(\d+\.\d+\.\d+)|PixiJS - v(\d+\.\d+\.\d+)/i, from: 'banner' }],
    runtimeVersion: 'PIXI.VERSION',
  },
  {
    id: 'react-spring', name: 'react-spring', category: 'spring-engine', packages: ['@react-spring/web', '@react-spring/core', 'react-spring'], files: [/react-spring/i],
    calibration: { state: 'api-literals-only', builds: [] },
    signatures: [
      { id: 'config-presets', w: 5, all: ['wobbly', 'molasses', 'gentle'], note: 'config.gentle/wobbly/stiff/slow/molasses presets' },
    ],
    dom: [],
    version: [],
    versionUnknownReason: 'no version literal known for this library',
  },
  {
    id: 'flickity', name: 'Flickity', category: 'drag-inertia', packages: ['flickity'], files: [/flickity/i],
    calibration: { state: 'api-literals-only', builds: [] },
    signatures: [
      { id: 'classes', w: 4, all: ['flickity-viewport', 'flickity-slider'] },
      { id: 'enabled', w: 3, s: 'flickity-enabled' },
      { id: 'physics-options', w: 3, all: ['selectedAttraction', 'friction', 'freeScrollFriction'] },
    ],
    dom: [
      { id: 'enabled-class', w: 4, kind: 'class', value: 'flickity-enabled', fires: true },
      { id: 'viewport-class', w: 3, kind: 'class', value: 'flickity-viewport', fires: true },
    ],
    version: [],
    versionUnknownReason: 'no version literal known for this library',
  },
  {
    id: 'swiper', name: 'Swiper', category: 'drag-inertia', packages: ['swiper'], files: [/(^|[\\/._-])swiper([\\/._-]|$)/i],
    calibration: { state: 'api-literals-only', builds: [] },
    signatures: [
      { id: 'classes', w: 4, all: ['swiper-wrapper', 'swiper-slide'] },
      { id: 'initialized', w: 3, s: 'swiper-initialized' },
      { id: 'option-names', w: 2, all: ['slidesPerView', 'spaceBetween'] },
    ],
    dom: [
      { id: 'initialized-class', w: 4, kind: 'class', value: 'swiper-initialized', fires: true },
      { id: 'wrapper-class', w: 3, kind: 'class', value: 'swiper-wrapper', fires: true },
    ],
    version: [],
    versionUnknownReason: 'no version literal known for this library',
  },
  {
    id: 'barba', name: 'Barba.js', category: 'page-transition', packages: ['@barba/core'], files: [/(^|[\\/._-])barba([\\/._-]|$)/i],
    calibration: { state: 'api-literals-only', builds: [] },
    signatures: [
      { id: 'attrs', w: 4, all: ['data-barba', 'data-barba-namespace'] },
      { id: 'attr', w: 3, s: 'data-barba' },
      { id: 'hooks', w: 3, all: ['beforeEnter', 'afterLeave', 'beforeLeave'] },
    ],
    dom: [{ id: 'container-attr', w: 4, kind: 'attr', value: 'data-barba=container', fires: false }, { id: 'global-barba', w: 3, kind: 'global', value: 'barba', fires: true }],
    version: [],
    versionUnknownReason: 'no version literal known for this library',
  },
  {
    id: 'aos', name: 'AOS (Animate On Scroll)', category: 'scroll-reveal', packages: ['aos'], files: [/(^|[\\/])aos(\.min)?\.js/i],
    calibration: { state: 'api-literals-only', builds: [] },
    signatures: [
      { id: 'attrs', w: 4, all: ['data-aos', 'aos-animate'] },
      { id: 'classes', w: 3, s: 'aos-init' },
      { id: 'attr', w: 2, s: 'data-aos' },
    ],
    dom: [
      { id: 'init-class', w: 4, kind: 'class', value: 'aos-init', fires: true },
      { id: 'animate-class', w: 4, kind: 'class', value: 'aos-animate', fires: true },
      { id: 'attr', w: 2, kind: 'attrPrefix', value: 'data-aos' },
    ],
    version: [],
    versionUnknownReason: 'no version literal known for this library',
  },
  {
    id: 'split-text-libs', name: 'Splitting.js / SplitType', category: 'text-split', packages: ['splitting', 'split-type'], files: [/(^|[\\/._-])(splitting|split-type)([\\/._-]|$)/i],
    calibration: { state: 'api-literals-only', builds: [] },
    signatures: [
      { id: 'splitting-vars', w: 4, all: ['--char-index', '--word-index'] },
      { id: 'splitting-attr', w: 3, s: 'data-splitting' },
      { id: 'splittype-classes', w: 3, all: ['split-type', 'lineClass', 'wordClass', 'charClass'] },
    ],
    dom: [
      { id: 'splitting-attr', w: 4, kind: 'attr', value: 'data-splitting', fires: true },
      { id: 'splitting-class', w: 3, kind: 'class', value: 'splitting', fires: true },
    ],
    version: [],
    versionUnknownReason: 'no version literal known for this library',
  },
];

/** Behaviour-only families: what recorded behaviour can and cannot tell apart (see behaviour.js). */
export const FAMILIES = {
  'smooth-scroll': { candidates: ['lenis', 'locomotive-scroll', 'gsap-scrollsmoother'], can_not_separate: 'a lerp or eased-duration scroll looks the same whichever library or hand-written code produces it' },
  'generated-easing': { candidates: ['motion'], can_not_separate: 'linear() easing strings are also produced by CSS spring generators and hand-written helpers' },
  'webgl-render-loop': { candidates: ['three', 'pixi', 'react-three-fiber'], can_not_separate: 'a continuous WebGL draw loop does not name the engine' },
  'js-spring': { candidates: ['motion', 'react-spring', 'gsap'], can_not_separate: 'a damped-spring step response is the same function in every spring library' },
  'js-tween': { candidates: ['gsap', 'motion', 'animejs'], can_not_separate: 'the same easing curve can come from any tween engine' },
};

export const SIGNATURE_SET = 'libdetect-sigs-1';
export const THRESHOLDS = { detected: 5, probable: 3, hint: 1 };
export const DEFAULT_KINDS = ['js', 'html', 'css', 'json', 'text'];
