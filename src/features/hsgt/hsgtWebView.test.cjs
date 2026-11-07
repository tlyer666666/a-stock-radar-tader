"use strict";
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
const restore = registerTypeScript();
after(() => restore?.());
const view = require("./HsgtWebView.tsx");

test("the embedded page never covers the header: bounds are clipped to the visible scroll area", () => {
  const window = { x: 0, y: 0, width: 1400, height: 900 };
  const main = { x: 220, y: 60, width: 1180, height: 840 };
  assert.deepEqual(view.visibleBounds({ x: 240, y: 150, width: 1100, height: 900 }, [window, main]), { x: 240, y: 150, width: 1100, height: 750 });
  assert.deepEqual(view.visibleBounds({ x: 240, y: 20, width: 1100, height: 600 }, [window, main]), { x: 240, y: 60, width: 1100, height: 560 }, "scrolled up past the header");
  assert.equal(view.visibleBounds({ x: 240, y: 880, width: 1100, height: 600 }, [window, main]), null, "almost fully scrolled away");
});

test("without the desktop bridge the section explains it only works in the desktop app", () => {
  const html = renderToStaticMarkup(React.createElement(view.default));
  assert.match(html, /沪深港通/);
  assert.match(html, /只在桌面版/);
});

test("native view yields to overlays, restores once, and slow status reads never overlap", async t => {
  const {createHookHarness, walk} = require("../../../qa/research-hook-harness.cjs");
  const saved = {};
  for (const key of ["window","document","MutationObserver","ResizeObserver","requestAnimationFrame","cancelAnimationFrame"]) saved[key] = global[key];
  const layout = React.useLayoutEffect;
  React.useLayoutEffect = (...args) => React.useEffect(...args);
  t.after(() => {
    React.useLayoutEffect = layout;
    for (const [key,value] of Object.entries(saved)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  });
  let overlay = false, notify, poll, frame, finishRead;
  const calls = {show:0,hide:0,state:0,bounds:0};
  const status = open => ({open});
  const api = {
    show: async () => { calls.show++; return status(true); },
    hide: async () => { calls.hide++; return status(false); },
    setBounds: async () => { calls.bounds++; return status(true); },
    state: () => { calls.state++; return new Promise(resolve => { finishRead = resolve; }); }
  };
  global.window = {innerWidth:1024,innerHeight:720,stockApi:{thsWeb:api},
    setInterval:(fn,ms) => {assert.equal(ms,5000);poll=fn;return 1;},clearInterval(){},addEventListener(){},removeEventListener(){}};
  global.document = {body:{},hidden:false,querySelector:() => overlay ? {} : null,addEventListener(){},removeEventListener(){}};
  global.MutationObserver = class {constructor(fn){notify=fn;} observe(){} disconnect(){}};
  global.ResizeObserver = class {observe(){} disconnect(){}};
  global.requestAnimationFrame = fn => {frame=fn;return 1;}; global.cancelAnimationFrame=()=>{};
  const h=createHookHarness(view.default,{bindRefs:tree=>{
    const node=walk(tree).find(n=>n.props?.className==="hsgt-web-frame");
    node.props.ref.current={parentElement:null,getBoundingClientRect:()=>({left:100,top:100,width:500,height:400})};
  }});
  h.render(); await h.flush(); assert.equal(calls.show,1);
  const first=poll(); await poll(); assert.equal(calls.state,1);
  overlay=true; notify(); frame(); await h.flush(); assert.equal(calls.hide,1);
  finishRead(status(true)); await first; await h.flush();
  await poll(); assert.equal(calls.state,1);
  overlay=false; notify(); frame(); await h.flush(); assert.equal(calls.show,2);
  notify(); frame(); assert.equal(calls.bounds,0,'layout changes with equal bounds avoid IPC');
  h.dispose(); assert.equal(calls.hide,2);
});
