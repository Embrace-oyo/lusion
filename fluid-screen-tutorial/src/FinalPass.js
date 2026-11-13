/**
 * FinalPass.js — 原站 PostEffect 队列里的 `Final` 收尾通道（逐字移植）
 *
 * 原站 class Final（renderOrder = 30）在 Bloom 之后、Smaa 之前执行，负责整屏调色：
 *   1. 饱和度（saturation，1 = 不变）
 *   2. 对比度（contrast，围绕 0.5 伸缩）
 *   3. 亮度（brightness，1 = 不变）
 *   4. Tint（colorDodge + screen 双混合，tintOpacity 控制强度）
 *   5. 暗角（vignette，按到屏幕中心的距离做 smoothstep）
 *   6. 抖动（dither，1/255 的 hash 噪声，消除渐变色带）
 *
 * 原站默认 `useFinal = false`（settings 里只有一个 `useFinal:!1`），
 * 所以这里默认 `enabled = false`；需要时由页面 / 调试面板打开。
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/** 全屏 pass 通用顶点：直接输出裁剪坐标，uv 原样传给片元 */
const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 v_uv;

  void main() {
    v_uv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * 原站 `fragmentShader`（Final）的等价格式版。
 * 所有 uniform 名字与公式保持与原 bundle 一致，未做任何"优化"。
 */
const FINAL_FRAG = /* glsl */ `
  varying vec2 v_uv;

  // 当前画面
  uniform sampler2D u_texture;
  // 画面外的填充色（opacity < 1 时露出）
  uniform vec3 u_bgColor;
  // 整体不透明度（1 = 完全用调色后的画面）
  uniform float u_opacity;
  // 暗角起止距离（0 = 中心，1 ≈ 屏幕角）
  uniform float u_vignetteFrom;
  uniform float u_vignetteTo;
  // 宽高比校正后的距离系数（由 setSize 计算）
  uniform vec2 u_vignetteAspect;
  // 暗角颜色
  uniform vec3 u_vignetteColor;
  // 饱和度偏移（0 = 不变，-1 = 灰度）
  uniform float u_saturation;
  // 对比度偏移（0 = 不变）
  uniform float u_contrast;
  // 亮度偏移（0 = 不变）
  uniform float u_brightness;
  // Tint 颜色
  uniform vec3 u_tintColor;
  // Tint 强度（0 = 关闭）
  uniform float u_tintOpacity;
  // 抖动随机种子（每帧随机）
  uniform float u_ditherSeed;

  /** 3D hash → [0,1)，用来给每个像素一个稳定的伪随机抖动值 */
  float hash13(vec3 p3) {
    p3 = fract(p3 * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  /** 滤色混合：cb + cs - cb * cs */
  vec3 screen(vec3 cb, vec3 cs) {
    return cb + cs - (cb * cs);
  }

  /** 颜色减淡：cb / (1 - cs)，cs >= 1 时饱和到白色 */
  vec3 colorDodge(vec3 cb, vec3 cs) {
    return mix(min(vec3(1.0), cb / (1.0 - cs)), vec3(1.0), step(vec3(1.0), cs));
  }

  void main() {
    // 1) 取当前画面
    vec3 color = texture2D(u_texture, v_uv).rgb;

    // 2) 饱和度：以亮度为中心做 mix（1 + u_saturation，-1 时变灰度）
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(luma), color, 1.0 + u_saturation);

    // 3) 对比度：围绕 0.5 伸缩
    color = 0.5 + (1.0 + u_contrast) * (color - 0.5);

    // 4) 亮度：直接加偏移
    color += u_brightness;

    // 5) Tint：先 colorDodge 再 screen，最后按 tintOpacity 混合
    color = mix(color, screen(colorDodge(color, u_tintColor), u_tintColor), u_tintOpacity);

    // 6) 暗角：把 uv 从 [0,1] 映射到以中心为 0 的距离，乘宽高比系数
    float d = length((v_uv - 0.5) * u_vignetteAspect) * 2.0;
    color = mix(color, u_vignetteColor, smoothstep(u_vignetteFrom, u_vignetteTo, d));

    // 7) 与背景色混合 + 每像素 dither（+0.5/255 量级的噪声，消除色带）
    color = mix(u_bgColor, color, u_opacity) + hash13(vec3(gl_FragCoord.xy, u_ditherSeed)) / 255.0;
    gl_FragColor = vec4(color, 1.0);
  }
`;

export class FinalPass extends Pass {

  /**
   * @param {object} [options]
   * @param {number} [options.vignetteFrom=1.0] — 暗角起始距离（0..1）
   * @param {number} [options.vignetteTo=2.0]   — 暗角完全变色的距离
   * @param {string} [options.vignetteColor='#000000'] — 暗角颜色
   * @param {number} [options.saturation=1]     — 饱和度倍率（1 = 不变）
   * @param {number} [options.contrast=0]       — 对比度偏移（0 = 不变）
   * @param {number} [options.brightness=1]     — 亮度倍率（1 = 不变）
   * @param {string} [options.tintColor='#000000'] — Tint 颜色
   * @param {number} [options.tintOpacity=0]    — Tint 强度
   * @param {string} [options.bgColor='#000000'] — 画面外填充色
   * @param {number} [options.opacity=1]        — 整体不透明度
   */
  constructor(options = {}) {
    super();

    // 原站 Final 默认在队列里但 isActive=false，这里用 Pass.enabled 控制
    this.enabled = false;

    // 可调参数（GUI / 页面可以直接改这些字段）
    this.vignetteFrom = options.vignetteFrom ?? 1.0;
    this.vignetteTo = options.vignetteTo ?? 2.0;
    this.vignetteColor = new THREE.Color(options.vignetteColor ?? '#000000');
    this.saturation = options.saturation ?? 1;
    this.contrast = options.contrast ?? 0;
    this.brightness = options.brightness ?? 1;
    this.tintColor = new THREE.Color(options.tintColor ?? '#000000');
    this.tintOpacity = options.tintOpacity ?? 0;
    this.bgColor = new THREE.Color(options.bgColor ?? '#000000');
    this.opacity = options.opacity ?? 1;

    // 宽高比校正系数：让「到中心的距离」在横竖方向都归一化到 0..1
    this.vignetteAspect = new THREE.Vector2(1, 1);

    // 全屏材质
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        // 由 render() 每帧写入 readBuffer
        u_texture: { value: null },
        // 调色参数（setSize / render 时同步）
        u_bgColor: { value: this.bgColor },
        u_opacity: { value: this.opacity },
        u_vignetteFrom: { value: this.vignetteFrom },
        u_vignetteTo: { value: this.vignetteTo },
        u_vignetteAspect: { value: this.vignetteAspect },
        u_vignetteColor: { value: this.vignetteColor },
        u_saturation: { value: this.saturation - 1 },
        u_contrast: { value: this.contrast },
        u_brightness: { value: this.brightness - 1 },
        u_tintColor: { value: this.tintColor },
        u_tintOpacity: { value: this.tintOpacity },
        u_ditherSeed: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FINAL_FRAG,
      // 后处理不需要深度
      depthTest: false,
      depthWrite: false,
    });

    // Pass 内部复用的全屏四边形
    this.fsQuad = new FullScreenQuad(this.material);
  }

  /** 屏幕尺寸变化：重算暗角的宽高比系数（与原站 Final.render 里的算法一致） */
  setSize(width, height) {
    // l = h / 对角线长度
    const l = height / Math.sqrt(width * width + height * height);
    // x 分量乘宽高比，y 分量直接用 l
    this.vignetteAspect.set((width / height) * l, l);
  }

  render(renderer, writeBuffer, readBuffer /* , deltaTime */) {
    // 同步可调参数到 uniform（和原站一样每次 render 都写）
    const u = this.material.uniforms;
    u.u_texture.value = readBuffer.texture;
    u.u_vignetteFrom.value = this.vignetteFrom;
    u.u_vignetteTo.value = this.vignetteTo;
    u.u_saturation.value = this.saturation - 1;
    u.u_contrast.value = this.contrast;
    u.u_brightness.value = this.brightness - 1;
    u.u_tintOpacity.value = this.tintOpacity;
    u.u_opacity.value = this.opacity;
    // 每帧换一个抖动种子（原站 Math.random()*1000）
    u.u_ditherSeed.value = Math.random() * 1000;

    // 最后一个 pass 直接写屏幕，否则写交换缓冲
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
