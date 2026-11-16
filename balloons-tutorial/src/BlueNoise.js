/**
 * BlueNoise.js — 程序化蓝噪声系统
 *
 * 为了让项目开箱即跑，这里不依赖外部 PNG，而是在运行时生成一张 128×128 的
 * 伪随机蓝噪声纹理（Float32Array → DataTexture）。对气球 Shader 来说够用 —
 * 它主要用来做圆角裁剪时的 banding 抖动（dithering）。
 *
 * 也提供了从外部 PNG 加载真实蓝噪声的接口 loadFromURL。
 *
 * 同时导出 getBlueNoiseShader GLSL chunk，在 shader 里 include 即可采样。
 */

import * as THREE from 'three';
import { getSeedRandomFn } from './math.js';

/** Shader 里采样蓝噪声的标准 GLSL 片段 */
export const getBlueNoiseShader = /* glsl */`
  // u_blueNoise       : sampler2D  — 128x128 的蓝噪声纹理
  // u_blueNoiseScale  : float      — 缩放因子 (屏幕越大值越大)
  // v_uv              : vec2       — 屏幕 UV
  // offset            : vec2       — 每帧随机偏移，让抖动 pattern 动起来
  vec3 getBlueNoise(vec2 v_uv, vec2 offset) {
    vec2 scaled = v_uv * u_blueNoiseScale + offset;
    vec2 wrapped = fract(scaled);
    return texture2D(u_blueNoise, wrapped).rgb;
  }
`;

export class BlueNoise {

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} [options]
   * @param {number} [options.size=128]
   * @param {string} [options.url=null] — 外部蓝噪声 PNG URL
   */
  constructor(renderer, options = {}) {
    // 保存渲染器引用（当前不直接使用，留给未来做 GPU 侧生成/上传）
    this.renderer = renderer;
    // 解构选项：size = 纹理边长（2 的幂，Shader 里 fract 平铺），url = 可选外部 PNG
    const { size = 128, url = null } = options;
    // 记录尺寸，供采样缩放与 texelSize 计算使用
    this.size = size;
    // 抖动采样偏移：每帧随机化，避免静态噪点图案在画面上被眼睛捕捉到
    this.offset = new THREE.Vector2(0, 0);
    // 纹理先占位为空，由下面两条分支之一真正填充
    this.texture = null;

    // 指定了外部 URL 时优先使用真实的蓝噪声贴图
    if (url) {
      this._loadFromURL(url);
    } else {
      // 否则在本地程序化生成（保证项目开箱即跑，不依赖外部资源）
      this._generateProcedural();
    }
  }

  /** 程序化生成 — 128×128 Float32Array 随机值（fallback） */
  _generateProcedural() {
    // 取实例上的目标边长
    const { size } = this;
    // 固定种子的伪随机函数：保证每次刷新页面得到同一张噪声图（画面可复现）
    const rand = getSeedRandomFn(12345);
    // RGBA 四通道 Float32 数据，长度为 size*size 个像素 × 4
    const data = new Float32Array(size * size * 4);
    // 逐像素填充随机值
    for (let i = 0; i < size * size; i++) {
      // 每个像素取一个 [0,1) 随机数
      const v = rand();
      // R 通道
      data[i * 4 + 0] = v;
      // G 通道（与 R 相同 → 灰度噪声）
      data[i * 4 + 1] = v;
      // B 通道（与 R 相同 → 灰度噪声）
      data[i * 4 + 2] = v;
      // A 通道固定 1，避免 alpha 参与抖动
      data[i * 4 + 3] = 1;
    }

    // 用原始字节数组构造 DataTexture：RGBA 格式 + Float 类型
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
    // 缩小过滤用最近邻：噪声图必须保持锐利，线性过滤会把高频抖糊掉
    tex.minFilter = THREE.NearestFilter;
    // 放大过滤同样用最近邻
    tex.magFilter = THREE.NearestFilter;
    // 横向重复包裹：shader 里 fract() 平铺采样时不会出现边缘断裂
    tex.wrapS = THREE.RepeatWrapping;
    // 纵向重复包裹
    tex.wrapT = THREE.RepeatWrapping;
    // 标记需要上传到 GPU
    tex.needsUpdate = true;
    // 线性色彩空间：噪声是纯数值数据，不应做 sRGB 解码
    tex.colorSpace = THREE.LinearSRGBColorSpace;

    // 保存为当前纹理
    this.texture = tex;
  }

  /** 异步从 URL 加载真实蓝噪声 PNG */
  _loadFromURL(url) {
    // three 内置纹理加载器（内部走 Image / ImageBitmap 解码）
    const loader = new THREE.TextureLoader();
    // 异步加载：成功回调里配置采样参数
    loader.load(url, (tex) => {
      // 最近邻缩小：保持蓝噪声的高频分布
      tex.minFilter = THREE.NearestFilter;
      // 最近邻放大
      tex.magFilter = THREE.NearestFilter;
      // 横向平铺，配合 shader 的 fract() 循环采样
      tex.wrapS = THREE.RepeatWrapping;
      // 纵向平铺
      tex.wrapT = THREE.RepeatWrapping;
      // 噪声是数据而非颜色，使用线性色彩空间
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      // 加载成功后替换当前纹理
      this.texture = tex;
    }, undefined, () => {
      // 加载失败：打印警告并退回程序化生成，保证渲染不中断
      console.warn('[BlueNoise] 外部资源加载失败，回退到程序化生成');
      this._generateProcedural();
    });
  }

  /** 每帧更新随机偏移，让抖动 pattern 轻微漂移避免 banding 显现 */
  update() {
    // 每次落在 [0,1) 的随机二维偏移，shader 里作为采样起点平移
    this.offset.set(Math.random(), Math.random());
  }

  /** 释放纹理资源 */
  dispose() {
    // 有纹理时释放显存
    if (this.texture) this.texture.dispose();
    // 置空引用，便于 GC 回收
    this.texture = null;
  }
}
