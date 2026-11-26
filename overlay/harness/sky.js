// A script the motion tests add to the page: a canvas drawn every frame and an animate() call,
// with a source map that says each line is ten lines further down in src/sky.ts.
window.startSky = function () {
  const c = document.createElement("canvas"); c.width = 200; c.height = 100; c.className = "sky"; c.style.cssText = "display:block;margin:0 auto;width:100px;height:50px"; document.querySelector(".hero").append(c);
  const g = c.getContext("2d");
  (function paint(t) { g.clearRect(0, 0, 200, 100); g.fillRect(90 + 80 * Math.sin(t / 300), 40, 20, 20); requestAnimationFrame(paint); })(0);
  document.querySelector("nav").animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 900, iterations: Infinity, direction: "alternate", id: "glow" });
};
//# sourceMappingURL=data:application/json;charset=utf-8,%7B%22version%22%3A%203%2C%20%22sources%22%3A%20%5B%22../src/sky.ts%22%5D%2C%20%22names%22%3A%20%5B%5D%2C%20%22mappings%22%3A%20%22AAUA%3BAACA%3BAACA%3BAACA%3BAACA%3BAACA%3BAACA%3BAACA%22%7D
