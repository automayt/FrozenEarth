import { useEffect, useRef } from 'react';
import { settings } from '../settings';

/**
 * Frost creeping in from the window's edges, on its own small WebGL canvas. The expensive part
 * (noise, ice plates) is baked once into a texture; each frame only compares that bake against how
 * far the frost has reached, so it costs almost nothing while the game runs underneath.
 */

const VERT = `attribute vec2 a; varying vec2 v; void main(){ v=a*.5+.5; gl_Position=vec4(a,0.,1.); }`;

/** Bake: R is how far from the edge each point freezes, G and B the seams between ice plates, A fine rime grain. */
const BAKE = `precision highp float;
varying vec2 v; uniform vec2 u_res;
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float a=.5,s=0.; for(int i=0;i<5;i++){ s+=a*noise(p); p=p*2.03+17.; a*=.5; } return s; }
float ridge(vec2 p){ float r=1.-abs(2.*noise(p)-1.); return r*r*r; }
float seams(vec2 p){ vec2 g=floor(p),f=fract(p); float d1=8.,d2=8.;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){ vec2 o=vec2(float(x),float(y));
    vec2 r=o+vec2(hash(g+o),hash(g+o+7.1))-f; float d=dot(r,r);
    if(d<d1){ d2=d1; d1=d; } else if(d<d2){ d2=d; } }
  return 1.-smoothstep(0.,.05,sqrt(d2)-sqrt(d1)); }
void main(){
  float asp=u_res.x/u_res.y;
  vec2 p=vec2(v.x*asp,v.y);
  vec2 e=min(v,1.-v)*vec2(asp,1.);
  // Distance to the nearest edge, rounded so the corners freeze deepest.
  float k=11.;
  float d=-log(exp(-k*e.x)+exp(-k*e.y))/k+.063;
  vec2 w=vec2(fbm(p*3.1+5.2),fbm(p*3.1+1.7))-.5;
  float lobes=fbm(p*2.2+w*1.4+9.);
  // Needles reaching for the middle of the screen: noise fine around the centre, long along the radius.
  vec2 c=p-vec2(asp*.5,.5);
  vec2 dir=c/max(length(c),.001);
  float reach=d*7.;
  float needles=ridge(dir*23.+reach*.5+w*2.)*.62+ridge(dir*59.+reach+w*4.+3.)*.34+ridge(dir*131.+reach*2.+w*6.+7.)*.2;
  needles*=.45+lobes;
  float field=d+(lobes-.5)*.26-needles*.1;
  gl_FragColor=vec4(clamp(field/.8,0.,1.),seams(p*17.+w*9.),seams(p*51.+w*17.),hash(floor(gl_FragCoord.xy/1.5)));
}`;

const SHOW = `precision mediump float;
varying vec2 v; uniform sampler2D u_tex; uniform float u_reach; uniform float u_time;
void main(){
  vec4 t=texture2D(u_tex,v);
  float field=t.r*.8;
  float r=u_reach;
  float m=smoothstep(r+.003,r-.012,field);
  float depth=clamp((r-field)/max(r,.02),0.,1.);
  vec3 col=mix(vec3(.66,.83,.93),vec3(.9,.97,1.),depth);
  float alpha=m*(.2+.62*depth*depth);
  // Rime: a fine grain, heaviest where the ice is thin.
  alpha+=m*(t.a-.5)*.2*(1.-depth*.6);
  // The seams between ice plates catch the light a little.
  float seam=max(t.g*.8,t.b);
  alpha+=m*seam*.16;
  col=mix(col,vec3(1.),seam*.35*m);
  // A thin bright rim where the ice is still growing.
  float rim=smoothstep(.012,.0,abs(field-r));
  alpha+=rim*.24;
  col=mix(col,vec3(.95,1.,1.),rim*.6);
  // Cold air ahead of the front: the picture dims and blues before it freezes.
  float chill=smoothstep(r+.16,r,field)*(1.-m)*.3;
  vec3 air=vec3(.05,.1,.18);
  // Single crystals glint in turn.
  float glint=step(.992,t.a)*m*(.5+.5*sin(u_time*1.3+t.a*900.));
  col+=glint*.6; alpha+=glint*.35;
  alpha=clamp(alpha,0.,1.);
  vec3 pm=col*alpha+air*chill*(1.-alpha);
  gl_FragColor=vec4(pm,alpha+chill*(1.-alpha));
}`;

function program(gl: WebGLRenderingContext, frag: string): WebGLProgram | null {
  const p = gl.createProgram();
  if (!p) return null;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, VERT],
    [gl.FRAGMENT_SHADER, frag],
  ] as const) {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    gl.attachShader(p, sh);
  }
  gl.bindAttribLocation(p, 0, 'a');
  gl.linkProgram(p);
  return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
}

/** Sharp enough for ice at any window size, cheap at all of them. */
function bakeSize(w: number, h: number): [number, number] {
  const k = Math.min(1, 1100 / Math.max(w, h, 1));
  return [Math.max(2, Math.round(w * k)), Math.max(2, Math.round(h * k))];
}

interface Props {
  /** How far in the frost settles, in screen heights. */
  reach: number;
  /** Seconds to cover most of that. */
  creep?: number;
  /** Keeps creeping slowly after that, up to this share more. */
  linger?: number;
}

export function Frost({ reach, creep = 5, linger = 0 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) {
      // The stylesheet's frame of frost shows instead.
      canvas.classList.add('no-gl');
      return;
    }
    const bake = program(gl, BAKE);
    const show = program(gl, SHOW);
    if (!bake || !show) {
      canvas.classList.add('no-gl');
      return;
    }
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    const uReach = gl.getUniformLocation(show, 'u_reach');
    const uTime = gl.getUniformLocation(show, 'u_time');

    let baked = false;
    const layout = () => {
      const r = canvas.getBoundingClientRect();
      const [w, h] = bakeSize(r.width, r.height);
      if (baked && canvas.width === w && canvas.height === h) return;
      baked = true;
      canvas.width = w;
      canvas.height = h;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
      gl.useProgram(bake);
      gl.uniform2f(gl.getUniformLocation(bake, 'u_res'), w, h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(show);
      gl.uniform1i(gl.getUniformLocation(show, 'u_tex'), 0);
    };

    const start = performance.now();
    const now = () => (performance.now() - start) / 1000;
    const reachAt = (t: number) => (settings.reducedMotion ? reach * (1 + linger) : reach * (1 - Math.exp(-t / creep)) + reach * linger * (1 - Math.exp(-t / 50)));
    const draw = (t: number) => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(uReach, reachAt(t));
      gl.uniform1f(uTime, t);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    let raf = 0;
    let last = -1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = now();
      // Smooth while it advances, then a slow glitter.
      if (t - last < (t < creep * 4 ? 1 / 40 : 1 / 12)) return;
      last = t;
      draw(t);
    };
    const begin = () => {
      layout();
      cancelAnimationFrame(raf);
      if (settings.reducedMotion) draw(0);
      else loop();
    };
    begin();
    const resize = new ResizeObserver(begin);
    resize.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      // Browsers keep few WebGL contexts; give this one back at once, the game wants its own.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [reach, creep, linger]);
  return <canvas className="frost-canvas" ref={ref} aria-hidden="true" />;
}
