/**
 * ScreenPaintDistortion.js — 屏幕流体折射后处理（1:1 移植自 lusion.co）
 *
 * ─────────────────────────────────────────────────────────────
 * 原理
 * ─────────────────────────────────────────────────────────────
 * ScreenPaint 算出的四通道纹理本身不直接显示，而是当作「屏幕空间速度场」用：
 *
 *   weight = (B + A) / 2                    → 笔刷墨量（哪里被动过）
 *   vel    = (0.5 - RG - 0.001) * 2 * weight → 解码出的速度（方向 + 强度）
 *
 * 然后用这个速度对**已经渲染好的画面**做偏移采样：
 *
 *   1) 沿速度方向连续采样 9 次再平均 —— 等价于一次方向性运动模糊，
 *      视觉上就是"画面被拖拽、折射"。
 *   2) 采样起点加一点蓝噪声抖动，打散 9 个固定采样点的条带感。
 *   3) 额外叠加一层 sin(RGB 相位错开) 的彩色条纹 —— 即色散/色差，
 *      让流体边缘出现蓝紫/橙红的虹彩，这是原站最标志性的观感。
 *
 * 注意：这个 pass 只做视觉，不反馈回物理；所以它永远作用在"当前屏幕"上，
 * 鼠标停下后速度场继续平流、衰减，画面会像水面一样慢慢恢复平静。
 */

import * as THREE from 'three';

const VERT = /* glsl */`
  attribute vec3 position;
  attribute vec2 uv;
  varying vec2 v_uv;

  void main() {
    v_uv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D u_texture;                // 已渲染好的画面
  uniform sampler2D u_screenPaintTexture;     // ScreenPaint 的 paint 纹理
  uniform vec2  u_screenPaintTexelSize;       // 1 / paint 分辨率
  uniform float u_amount;                     // 采样步长倍率（原站默认 3）
  uniform float u_rgbShift;                   // 色散强度（原站默认 0.5）
  uniform float u_multiplier;                 // 位移倍率（原站默认 5）
  uniform float u_colorMultiplier;            // 彩色条纹强度（原站默认 10）
  uniform float u_shade;                      // 彩色条纹亮度（原站默认 1.25）

  varying vec2 v_uv;

  /** 2D → 1D 哈希，用作廉价的抖动噪声（原站用 128×128 蓝噪声纹理） */
  float hash12(vec2 p) {
    // 把二维坐标打散成三维（xyx），乘大系数后取小数部分，破坏坐标的规律性
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    // 与自身错位分量做点积再累加，让相邻像素之间产生强去相关
    p3 += dot(p3, p3.yzx + 33.33);
    // 再混合一次并取小数，得到 [0,1) 的伪随机值
    return fract((p3.x + p3.y) * p3.z);
  }

  vec2 dither(vec2 p) {
    // 用两个不同偏移的哈希凑成二维抖动量（偏移 19.19 保证两分量不相关）
    return vec2(hash12(p), hash12(p + 19.19));
  }

  void main() {
    // ① 抖动：每个像素的采样起点略有不同，避免 9 个采样点形成可见条纹
    vec2 bnoise = dither(gl_FragCoord.xy + vec2(17.0, 29.0));

    // ② 读取流体速度场
    vec4 data = texture2D(u_screenPaintTexture, v_uv);
    float weight = (data.z + data.w) * 0.5;              // 墨量
    vec2 vel = (0.5 - data.xy - 0.001) * 2.0 * weight;   // 解码速度

    vec4 color = vec4(0.0);

    // ③ 把速度换算成 UV 空间的一步位移
    //    /4 是因为 paint 只有屏幕的 1/4 分辨率
    vec2 velocity = vel * u_amount / 4.0 * u_screenPaintTexelSize * u_multiplier;

    // ④ 沿速度方向连续采样 9 次并平均 → 方向性模糊 / 折射
    // 起点先偏移一个噪动量，让 9 个固定采样序列在像素间错开
    vec2 uv = v_uv + bnoise * velocity;
    for (int i = 0; i < 9; i++) {
      // 累加当前采样点的画面颜色
      color += texture2D(u_texture, uv);
      // 沿速度方向前进一个步长，形成拖尾
      uv += velocity;
    }
    // 取平均，避免叠加导致整体过曝
    color /= 9.0;

    // ⑤ 色散条纹：RGB 三个通道相位错开，叠在速度最强的位置上
    //    smoothstep(0.4, -0.9, weight) 让彩边集中在笔刷边缘（weight 0→1 的过渡区）
    // sin 的相位由速度与通道偏移 0/2/4 决定 → 三通道错开形成虹彩
    vec3 rainbow =
      sin(vec3(vel.x + vel.y) * 40.0 + vec3(0.0, 2.0, 4.0) * u_rgbShift)
      * smoothstep(0.4, -0.9, weight)
      * u_shade
      * max(abs(vel.x), abs(vel.y))
      * u_colorMultiplier;

    // 把彩色条纹叠加到折射后的画面上
    color.rgb += rainbow;

    // 输出最终颜色（alpha 沿用采样值）
    gl_FragColor = color;
  }
`;

export class ScreenPaintDistortion {

  constructor(renderer, screenPaint, options = {}) {
    // 渲染器引用，用于执行 fullscreen pass
    this.renderer = renderer;
    // 流体系统引用，每帧从这里取 paint 纹理与 texelSize
    this.screenPaint = screenPaint;

    // 原站 properties.defaults 中的默认值
    // 采样步长倍率：越大拖尾越长
    this.amount = options.amount ?? 3;
    // 色散强度：越大 RGB 相位差越明显
    this.rgbShift = options.rgbShift ?? 0.5;
    // 位移倍率：整体折射幅度
    this.multiplier = options.multiplier ?? 5;
    // 彩色条纹强度
    this.colorMultiplier = options.colorMultiplier ?? 10;
    // 彩色条纹亮度
    this.shade = options.shade ?? 1.25;

    // 折射材质：RawShaderMaterial 自带 attribute 声明，不注入 three 的默认 chunk
    this.material = new THREE.RawShaderMaterial({
      uniforms: {
        // 待折射的屏幕画面
        u_texture: { value: null },
        // 流体纹理（对象引用在 ScreenPaint 里固定，尺寸变化只改 texelSize）
        u_screenPaintTexture: { value: screenPaint.texture },
        // paint 纹理的 texel 尺寸，直接复用 ScreenPaint 内部的 Vector2
        u_screenPaintTexelSize: { value: screenPaint.texelSize },
        // 以下数值 uniform 由 render 每帧从实例属性同步
        u_amount: { value: 0 },
        u_rgbShift: { value: 0 },
        u_multiplier: { value: 0 },
        u_colorMultiplier: { value: 0 },
        u_shade: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      // 后处理不需要深度
      depthTest: false,
      depthWrite: false,
    });

    // 全屏三角形几何体
    const geo = new THREE.BufferGeometry();
    // position：三个顶点超出 NDC，裁剪后刚好铺满屏幕
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-1, -1, 0, 3, -1, 0, -1, 3, 0], 3
    ));
    // uv：配合放大后的三角形，范围 0~2（屏幕内部分仍是 0~1）
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(
      [0, 0, 2, 0, 0, 2], 2
    ));

    // 保存几何体以便 dispose
    this._geo = geo;
    // 全屏网格
    this._mesh = new THREE.Mesh(geo, this.material);
    // 关闭视锥剔除，全屏三角形永远要画
    this._mesh.frustumCulled = false;
    // 独立场景，避免影响主场景
    this._scene = new THREE.Scene();
    // 把网格加入场景
    this._scene.add(this._mesh);
    // 空相机：顶点着色器直接输出 NDC，相机矩阵不参与
    this._camera = new THREE.Camera();
  }

  /**
   * 把 sourceTexture 应用流体折射后渲染到目标（默认屏幕）
   * @param {THREE.Texture} sourceTexture — 场景渲染结果
   * @param {THREE.WebGLRenderTarget|null} target — null 表示默认帧缓冲
   */
  render(sourceTexture, target = null) {
    // 取材质 uniform 表的短引用
    const uniforms = this.material.uniforms;

    // 绑定本帧要折射的屏幕画面
    uniforms.u_texture.value = sourceTexture;
    // paint 纹理对象在 resize 时不会更换，但尺寸会变，所以每帧同步 texelSize
    uniforms.u_screenPaintTexelSize.value.copy(this.screenPaint.texelSize);
    // 同步各可调参数
    uniforms.u_amount.value = this.amount;
    uniforms.u_rgbShift.value = this.rgbShift;
    uniforms.u_multiplier.value = this.multiplier;
    uniforms.u_colorMultiplier.value = this.colorMultiplier;
    uniforms.u_shade.value = this.shade;

    // 渲染器引用
    const renderer = this.renderer;
    // 记录当前 RT，pass 结束后恢复，避免破坏外部渲染管线状态
    const prevRT = renderer.getRenderTarget();

    // 切到目标 RT（null = 默认帧缓冲，即直接上屏）
    renderer.setRenderTarget(target);
    // 执行一次全屏折射 pass
    renderer.render(this._scene, this._camera);
    // 恢复原来的 RT
    renderer.setRenderTarget(prevRT);
  }

  dispose() {
    // 释放材质
    this.material.dispose();
    // 释放几何体
    this._geo.dispose();
    // 断引用，便于 GC
    this._scene = null;
    // 断引用
    this._mesh = null;
    // 断引用
    this._camera = null;
  }
}
