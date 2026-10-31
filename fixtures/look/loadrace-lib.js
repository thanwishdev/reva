// Own fixture library for loadrace.html (no site content): the two animations the page starts once it has loaded.
export function intro(el) {
  el.animate([{ transform: 'translateY(40px)' }, { transform: 'translateY(0px)' }], { duration: 900, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'backwards' });
}
export function late(el) {
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, easing: 'linear', fill: 'forwards' });
}
