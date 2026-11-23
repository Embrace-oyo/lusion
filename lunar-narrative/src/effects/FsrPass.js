/**
 * FsrPass.js — 原站 `Fsr` 后处理（renderOrder = 2000）的移植
 *
 * 原站只在 `settings.UP_SCALE > 1`（低分辨率渲染后放大到画布）时才把 Fsr 加入队列；
 * 桌面端默认 UP_SCALE = 1，所以这里也默认 `enabled = false`，
 * 需要时可以打开（缩放比为 1 时等价于只做 RCAS 锐化）。
 *
 * 算法来自 AMD FidelityFX Super Resolution 1.0，两段：
 *   1) EASU（Edge Adaptive Spatial Upsampling）：12 抽头、沿边缘方向做方向性插值放大
 *   2) RCAS（Robust Contrast Adaptive Sharpening）：5 抽头、按局部对比度限幅锐化
 *
 * 输入 / 输出都是显示空间颜色（和其它后处理 pass 一致）。
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/** 全屏顶点着色器（position / uv 由 three 的 ShaderMaterial 前缀自动声明） */
const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 v_uv;

  void main() {
    v_uv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * EASU 放大：对每个输出像素在输入图上取 12 个邻域样本，
 * 先估计局部边缘方向，再沿该方向做拉伸的核函数加权。
 */
const EASU_FRAG = /* glsl */ `
  uniform sampler2D u_texture;
  // 输入（渲染缓冲）分辨率
  uniform vec2 u_inResolution;
  // 输出（画布）分辨率
  uniform vec2 u_outResolution;

  /** 读取输入颜色（uv 为 0..1） */
  vec3 FsrEasuCF(vec2 p) {
    return texture2D(u_texture, p).rgb;
  }

  /** 计算 EASU 的 4 组常量：输入/输出尺寸比与邻域步长 */
  void FsrEasuCon(out vec4 con0, out vec4 con1, out vec4 con2, out vec4 con3,
                  vec2 inputViewportInPixels, vec2 inputSizeInPixels, vec2 outputSizeInPixels) {
    con0 = vec4(
      inputViewportInPixels.x / outputSizeInPixels.x,
      inputViewportInPixels.y / outputSizeInPixels.y,
      0.5 * inputViewportInPixels.x / outputSizeInPixels.x - 0.5,
      0.5 * inputViewportInPixels.y / outputSizeInPixels.y - 0.5
    );
    con1 = vec4(1, 1, 1, -1) / inputSizeInPixels.xyxy;
    con2 = vec4(-1, 2, 1, 2) / inputSizeInPixels.xyxy;
    con3 = vec4(0, 4, 0, 0) / inputSizeInPixels.xyxy;
  }

  /**
   * 单个方向的采样核：
   *   off  —— 相对当前像素的偏移
   *   dir  —— 估计出的边缘方向
   *   len  —— 两个方向上的拉伸长度
   *   lob  —— 核的锐度
   *   clp  —— 距离上限（避免远端权重过大）
   */
  void FsrEasuTapF(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len,
                   float lob, float clp, vec3 c) {
    // 把偏移投影到「沿边缘」和「跨边缘」两个方向
    vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x)));
    v *= len;
    // 距离平方（限幅）
    float d2 = min(dot(v, v), clp);
    // 两个二次核相乘，得到一个紧凑的钟形权重
    float wB = 0.4 * d2 - 1.;
    float wA = lob * d2 - 1.;
    wB *= wB;
    wA *= wA;
    wB = 1.5625 * wB - 0.5625;
    float w = wB * wA;
    aC += c * w;
    aW += w;
  }

  /** 根据 5 个亮度样本估计局部边缘方向与长度（4 个象限各调用一次） */
  void FsrEasuSetF(inout vec2 dir, inout float len, float w,
                   float lA, float lB, float lC, float lD, float lE) {
    // 水平方向
    float lenX = max(abs(lD - lC), abs(lC - lB));
    float dirX = lD - lB;
    dir.x += dirX * w;
    lenX = clamp(abs(dirX) / lenX, 0., 1.);
    lenX *= lenX;
    len += lenX * w;

    // 垂直方向
    float lenY = max(abs(lE - lC), abs(lC - lA));
    float dirY = lE - lA;
    dir.y += dirY * w;
    lenY = clamp(abs(dirY) / lenY, 0., 1.);
    lenY *= lenY;
    len += lenY * w;
  }

  /** EASU 主体：12 抽头取样 + 方向估计 + 加权合成 */
  void FsrEasuF(out vec3 pix, vec2 ip, vec4 con0, vec4 con1, vec4 con2, vec4 con3) {
    // 输出像素 → 输入像素坐标
    vec2 pp = ip * con0.xy + con0.zw;
    vec2 fp = floor(pp);
    pp -= fp;

    // 4 个角点的基坐标
    vec2 p0 = fp * con1.xy + con1.zw;
    vec2 p1 = p0 + con2.xy;
    vec2 p2 = p0 + con2.zw;
    vec2 p3 = p0 + con3.xy;

    // 每个角点周围的 4 个子样本偏移
    vec4 off = vec4(-.5, .5, -.5, .5) * con1.xxyy;

    // 12 个采样（b/c/i/j/f/e/k/l/h/g/o/n），同时算亮度 L
    vec3 bC = FsrEasuCF(p0 + off.xw); float bL = bC.g + 0.5 * (bC.r + bC.b);
    vec3 cC = FsrEasuCF(p0 + off.yw); float cL = cC.g + 0.5 * (cC.r + cC.b);
    vec3 iC = FsrEasuCF(p1 + off.xw); float iL = iC.g + 0.5 * (iC.r + iC.b);
    vec3 jC = FsrEasuCF(p1 + off.yw); float jL = jC.g + 0.5 * (jC.r + jC.b);
    vec3 fC = FsrEasuCF(p1 + off.yz); float fL = fC.g + 0.5 * (fC.r + fC.b);
    vec3 eC = FsrEasuCF(p1 + off.xz); float eL = eC.g + 0.5 * (eC.r + eC.b);
    vec3 kC = FsrEasuCF(p2 + off.xw); float kL = kC.g + 0.5 * (kC.r + kC.b);
    vec3 lC = FsrEasuCF(p2 + off.yw); float lL = lC.g + 0.5 * (lC.r + lC.b);
    vec3 hC = FsrEasuCF(p2 + off.yz); float hL = hC.g + 0.5 * (hC.r + hC.b);
    vec3 gC = FsrEasuCF(p2 + off.xz); float gL = gC.g + 0.5 * (gC.r + gC.b);
    vec3 oC = FsrEasuCF(p3 + off.yz); float oL = oC.g + 0.5 * (oC.r + oC.b);
    vec3 nC = FsrEasuCF(p3 + off.xz); float nL = nC.g + 0.5 * (nC.r + nC.b);

    // 用 4 个象限的亮度差估计边缘方向与长度
    vec2 dir = vec2(0.);
    float len = 0.;
    FsrEasuSetF(dir, len, (1. - pp.x) * (1. - pp.y), bL, eL, fL, gL, jL);
    FsrEasuSetF(dir, len, pp.x * (1. - pp.y), cL, fL, gL, hL, kL);
    FsrEasuSetF(dir, len, (1. - pp.x) * pp.y, fL, iL, jL, kL, nL);
    FsrEasuSetF(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);

    // 归一化方向；长度为 0 时退化为水平方向
    vec2 dir2 = dir * dir;
    float dirR = dir2.x + dir2.y;
    bool zro = dirR < (1. / 32768.);
    dirR = inversesqrt(dirR);
    dirR = zro ? 1. : dirR;
    dir.x = zro ? 1. : dir.x;
    dir *= vec2(dirR);

    // 把「强度」转成核的拉伸参数
    len = len * .5;
    len *= len;
    float stretch = dot(dir, dir) / (max(abs(dir.x), abs(dir.y)));
    vec2 len2 = vec2(1. + (stretch - 1.0) * len, 1. - .5 * len);
    float lob = .5 - .29 * len;
    float clp = 1. / lob;

    // 中心 2x2 的亮度范围（最终结果要 clamp 在其中，抑制振铃）
    vec3 min4 = min(min(fC, gC), min(jC, kC));
    vec3 max4 = max(max(fC, gC), max(jC, kC));

    // 12 抽头加权
    vec3 aC = vec3(0);
    float aW = 0.;
    FsrEasuTapF(aC, aW, vec2(0., -1.) - pp, dir, len2, lob, clp, bC);
    FsrEasuTapF(aC, aW, vec2(1., -1.) - pp, dir, len2, lob, clp, cC);
    FsrEasuTapF(aC, aW, vec2(-1., 1.) - pp, dir, len2, lob, clp, iC);
    FsrEasuTapF(aC, aW, vec2(0., 1.) - pp, dir, len2, lob, clp, jC);
    FsrEasuTapF(aC, aW, vec2(0., 0.) - pp, dir, len2, lob, clp, fC);
    FsrEasuTapF(aC, aW, vec2(-1., 0.) - pp, dir, len2, lob, clp, eC);
    FsrEasuTapF(aC, aW, vec2(1., 1.) - pp, dir, len2, lob, clp, kC);
    FsrEasuTapF(aC, aW, vec2(2., 1.) - pp, dir, len2, lob, clp, lC);
    FsrEasuTapF(aC, aW, vec2(2., 0.) - pp, dir, len2, lob, clp, hC);
    FsrEasuTapF(aC, aW, vec2(1., 0.) - pp, dir, len2, lob, clp, gC);
    FsrEasuTapF(aC, aW, vec2(1., 2.) - pp, dir, len2, lob, clp, oC);
    FsrEasuTapF(aC, aW, vec2(0., 2.) - pp, dir, len2, lob, clp, nC);

    // 归一化并 clamp 到邻域范围内
    pix = min(max4, max(min4, aC / aW));
  }

  void main() {
    vec3 c;
    vec4 con0, con1, con2, con3;
    // 输入视口 / 输入尺寸 / 输出尺寸（缩放比 1 时三者一致）
    FsrEasuCon(con0, con1, con2, con3, u_inResolution, u_inResolution, u_outResolution);
    FsrEasuF(c, gl_FragCoord.xy, con0, con1, con2, con3);
    gl_FragColor = vec4(c.xyz, 1);
  }
`;

/**
 * RCAS 锐化：5 抽头（上下左右 + 中心），
 * 先按局部对比度算出允许的锐化量，再叠加到中心像素。
 */
const RCAS_FRAG = /* glsl */ `
  uniform sampler2D u_texture;
  uniform vec2 u_outResolution;
  uniform float u_sharpness;

  // 锐化上限（0.25 - 1/16）
  #define FSR_RCAS_LIMIT (0.25 - (1.0 / 16.0))

  vec4 FsrRcasLoadF(vec2 p);

  /** sharpness → 实际强度（指数映射） */
  void FsrRcasCon(out float con, float sharpness) {
    con = exp2(-sharpness);
  }

  vec3 FsrRcasF(vec2 ip, float con) {
    vec2 sp = vec2(ip);
    // 5 抽头
    vec3 b = FsrRcasLoadF(sp + vec2(0, -1)).rgb;
    vec3 d = FsrRcasLoadF(sp + vec2(-1, 0)).rgb;
    vec3 e = FsrRcasLoadF(sp).rgb;
    vec3 f = FsrRcasLoadF(sp + vec2(1, 0)).rgb;
    vec3 h = FsrRcasLoadF(sp + vec2(0, 1)).rgb;

    // 亮度
    float bL = b.g + .5 * (b.b + b.r);
    float dL = d.g + .5 * (d.b + d.r);
    float eL = e.g + .5 * (e.b + e.r);
    float fL = f.g + .5 * (f.b + f.r);
    float hL = h.g + .5 * (h.b + h.r);

    // 局部对比度 → 归一化，对比度越高锐化越弱（抑制噪点）
    float nz = .25 * (bL + dL + fL + hL) - eL;
    nz = clamp(abs(nz) / (max(max(bL, dL), max(eL, max(fL, hL))) - min(min(bL, dL), min(eL, min(fL, hL)))), 0., 1.);
    nz = 1. - .5 * nz;

    // 计算每个通道的锐化 lobe
    vec3 mn4 = min(b, min(f, h));
    vec3 mx4 = max(b, max(f, h));
    vec2 peakC = vec2(1., -4.);
    vec3 hitMin = mn4 / (4. * mx4);
    vec3 hitMax = (peakC.x - mx4) / (4. * mn4 + peakC.y);
    vec3 lobeRGB = max(-hitMin, hitMax);
    float lobe = max(-FSR_RCAS_LIMIT, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.)) * con;

    // 把锐化量叠加回中心像素
    return (lobe * (b + d + h + f) + e) / (4. * lobe + 1.);
  }

  vec4 FsrRcasLoadF(vec2 p) {
    return texture2D(u_texture, p / u_outResolution.xy);
  }

  void main() {
    float con;
    FsrRcasCon(con, u_sharpness);
    vec3 col = FsrRcasF(gl_FragCoord.xy, con);
    gl_FragColor = vec4(col, 1.);
  }
`;

export class FsrPass extends Pass {

  /**
   * @param {object} [options]
   * @param {number} [options.sharpness=1] — RCAS 锐度（0..2，越大越锐）
   */
  constructor(options = {}) {
    super();

    // 原站只在 UP_SCALE > 1 时启用
    this.enabled = false;

    // RCAS 锐度
    this.sharpness = options.sharpness ?? 1;

    // 输入 / 输出分辨率（uniform 里直接引用这两个 Vector2）
    this.inResolution = new THREE.Vector2(1, 1);
    this.outResolution = new THREE.Vector2(1, 1);

    // EASU 放大材质
    this.easuMaterial = new THREE.ShaderMaterial({
      uniforms: {
        u_texture: { value: null },
        u_inResolution: { value: this.inResolution },
        u_outResolution: { value: this.outResolution },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: EASU_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    // RCAS 锐化材质
    this.rcasMaterial = new THREE.ShaderMaterial({
      uniforms: {
        u_texture: { value: null },
        u_outResolution: { value: this.outResolution },
        u_sharpness: { value: this.sharpness },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: RCAS_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    // EASU 的输出中转 RT（半浮点，避免放大过程被 8-bit 截断）
    this.cacheRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    // 两个材质共用同一个全屏四边形（render 时切 material）
    this.fsQuad = new FullScreenQuad(this.easuMaterial);
  }

  /** 输出尺寸变化（输入尺寸在 render 时从 readBuffer 读取） */
  setSize(width, height) {
    this.outResolution.set(width, height);
    this.cacheRT.setSize(width, height);
  }

  render(renderer, writeBuffer, readBuffer /* , deltaTime */) {
    // 输入尺寸 = 当前读缓冲的物理像素尺寸
    const inW = readBuffer.width;
    const inH = readBuffer.height;
    this.inResolution.set(inW, inH);

    // ① EASU：readBuffer → cacheRT
    this.easuMaterial.uniforms.u_texture.value = readBuffer.texture;
    this.fsQuad.material = this.easuMaterial;
    renderer.setRenderTarget(this.cacheRT);
    this.fsQuad.render(renderer);

    // ② RCAS：cacheRT → 输出（屏幕或写缓冲）
    this.rcasMaterial.uniforms.u_texture.value = this.cacheRT.texture;
    this.rcasMaterial.uniforms.u_sharpness.value = this.sharpness;
    this.fsQuad.material = this.rcasMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }

  dispose() {
    this.easuMaterial.dispose();
    this.rcasMaterial.dispose();
    this.cacheRT.dispose();
    this.fsQuad.dispose();
  }
}
