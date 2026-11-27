/**
 * GoalBloom.js — 逐字移植原站 Bloom（桌面端 FFT 卷积分支）
 *
 * 原站 PostEffect 管线里的 `class Bloom`（USE_CONVOLUTION=true）：
 *   1. highPass：以顶点 alpha 作为泛光遮罩，rgb = texel.rgb * texel.a * highPassMultiplier
 *      并在同一步里叠加 halo（镜像 ghost + 径向 RGB 偏移）——就是隧道里的彩虹光晕
 *      卷积模式下采样前先把 uv 外扩 (1+buffer) 倍，给光晕留出屏幕外边距
 *   2. 镜头卷积核（指数衰减 + 变形条纹）预生成并做一次 FFT 存起来
 *   3. 每帧：highPass → 前向 FFT → 频域复乘 → 逆向 FFT → 归一化/饱和度 → 叠加
 *
 * 这里用 Pass 实现，直接接到 EffectComposer 上替代 UnrealBloomPass。
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const powerTwoCeiling = (v) => {
  // 向上取整后再取 log2，得到"至少能容纳 v 的最小 2 的幂指数"
  const e = Math.ceil(Math.log2(Math.max(1, Math.ceil(v))));
  // 位移得到 2 的幂
  const p = 1 << e;
  // 若 v 本身就是 2 的幂（或已经等于 p），直接返回 v，避免多扩一倍
  return p === Math.ceil(v) ? Math.ceil(v) : p;
};

const quadVertex = /* glsl */ `
// 传递给片元的 UV（three 的 FullScreenQuad 自带 uv attribute）
varying vec2 v_uv;
void main() {
  // 直接透传 UV
  v_uv = uv;
  // 顶点位置已经是 NDC，w=1 不做透视除法
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/* ── highPass + halo（USE_CONVOLUTION 版）── */
const highPassFragment = /* glsl */ `
uniform sampler2D u_texture;
uniform float u_amount;
uniform vec2 u_texelSize;
uniform vec2 u_aspect;
uniform float u_haloWidth;
uniform float u_haloRGBShift;
uniform float u_haloStrength;
uniform float u_haloMaskInner;
uniform float u_haloMaskOuter;
uniform float u_convolutionBuffer;
varying vec2 v_uv;

void main() {
  // 卷积模式下把 UV 向外扩 (1+buffer) 倍：给 FFT 循环卷积留出"屏幕外"的缓冲边距
  vec2 uv = (v_uv - 0.5) * (1.0 + u_convolutionBuffer) + 0.5;
  // 采样源画面
  vec4 texel = texture2D(u_texture, uv);
  // 用顶点 alpha 作为泛光遮罩：alpha 越大越亮（原站的做法）
  float alpha = texel.a * u_amount;
  // 输出 HDR 亮部（rgb 乘遮罩），alpha 固定 1 供后续 FFT 使用
  gl_FragColor = vec4(texel.rgb * alpha, 1.0);

  // 以画面中心为原点的等比坐标（乘 aspect 保证圆形不被拉伸）
  vec2 toCenter = (uv - 0.5) * u_aspect;
  // 镜像 UV：把画面翻转，形成中心对称的 ghost
  vec2 ghostUv = 1.0 - (toCenter + 0.5);
  // 从画面中心指向 ghost 采样点的向量
  vec2 ghostVec = vec2(0.5) - ghostUv;
  // 该向量长度
  float ghostLen = length(ghostVec);
  // 方向单位化（长度为 0 时给零向量，避免除零）
  vec2 direction = ghostLen > 1e-5 ? ghostVec / ghostLen : vec2(0.0);
  // 沿方向再偏移 haloWidth，并用 fract 做平铺，测量到中心的距离
  float weight = length(vec2(0.5) - fract(ghostUv + direction * u_haloWidth));
  // 三次方压暗：让光晕集中在远端（形成明显的拖影/彩虹环）
  weight = pow(1.0 - weight, 3.0);
  // 实际的 halo 采样偏移
  vec2 haloVec = direction * u_haloWidth;
  // RGB 三通道沿方向错开一个 texel 的倍数 → 色散
  vec3 distortion = vec3(-u_texelSize.x, 0.0, u_texelSize.x) * u_haloRGBShift;
  // 径向缩放：按角度取 40 个周期做锯齿扰动，模拟 zoom blur 的放射条纹
  float zoomBlurRatio = fract(atan(toCenter.y, toCenter.x) * 40.0) * 0.05 + 0.95;
  // 先缩放 ghost UV，再叠加 halo 偏移
  ghostUv *= zoomBlurRatio;
  // 最终采样位置
  vec2 haloUv = ghostUv + haloVec;
  // 分通道采样，得到带色散的光晕
  vec3 halo = vec3(
    texture2D(u_texture, haloUv + direction * distortion.r).r,
    texture2D(u_texture, haloUv + direction * distortion.g).g,
    texture2D(u_texture, haloUv + direction * distortion.b).b
  );
  // 强度 × 半径遮罩（内圈不发光，外圈才出现光晕）
  halo *= u_haloStrength * smoothstep(u_haloMaskInner, u_haloMaskOuter, length(toCenter));
  // 叠加到亮部结果上
  gl_FragColor.rgb += halo;
  // 原站用「外扩后的 uv」做边缘遮罩：只保留中央 1/(1+buffer) 区域，给 FFT 留出缓冲边距
  gl_FragColor.rgb *= max(abs(uv.x - 0.5), abs(uv.y - 0.5)) > 0.5 ? 0.0 : 1.0;
}
`;

/* ── 卷积核生成（原站 convolutionSrcFrag 逐字移植）── */
const kernelFragment = /* glsl */ `
varying vec2 v_uv;
uniform vec2 u_aspect;

void main() {
  // fract(v_uv+0.5) 把 UV 平移到以中心为 0 的坐标系，再乘 aspect 保持圆形
  vec2 toCenter = (fract(v_uv + 0.5) - 0.5) * u_aspect;
  // 旋转 45°：第二个方向上的条纹（与第一组十字条纹组成八向星芒）
  vec2 rotToCenter = mat2(0.7071067811865476, -0.7071067811865476, 0.7071067811865476, 0.7071067811865476) * toCenter;
  // 多组指数衰减核叠加：每一项 = exp(-距离×频率)×权重
  // 低频项形成大范围柔光，高频项形成细亮的核心与星芒
  float res =
    // 最外层柔光
    exp(-length(toCenter) * 1.0) * 0.05 +
    // 中层光晕
    exp(-length(toCenter) * 7.5) * 0.5 +
    // 核心亮斑
    exp(-length(toCenter) * 25.0) * 1.0 +
    // 垂直方向压缩（vec2(1,10)）→ 水平细长条纹
    exp(-length(toCenter * vec2(1.0, 10.0)) * 30.0) * 20.0 +
    // 更强的水平细条纹
    exp(-length(toCenter * vec2(1.0, 20.0)) * 60.0) * 300.0 +
    // 水平方向压缩 → 垂直细长条纹
    exp(-length(toCenter * vec2(10.0, 1.0)) * 30.0) * 20.0 +
    // 更强的垂直细条纹
    exp(-length(toCenter * vec2(20.0, 1.0)) * 60.0) * 300.0 +
    // 45° 方向条纹
    exp(-length(rotToCenter * vec2(1.0, 8.0)) * 37.5) * 12.0 +
    // 45° 强条纹
    exp(-length(rotToCenter * vec2(1.0, 20.0)) * 75.0) * 300.0 +
    // -45° 强条纹
    exp(-length(rotToCenter * vec2(20.0, 1.0)) * 75.0) * 300.0;
  // 卷积核只用到 R 通道（灰度核），zw 留 0（预留给复数虚部）
  gl_FragColor = vec4(res, res, 0.0, 0.0);
}
`;

/* ── Stockham radix-2 FFT butterfly ── */
const fftFragment = /* glsl */ `
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_texelSize;
uniform float u_subtransformSize;
uniform bool u_isHorizontal;
uniform float u_normalization;
uniform bool u_isForward;

// 非有限值（NaN/Inf）归零：NaN 参与任何比较都为 false，所以用开区间判断把它兜住。
// 必要性：输入里偶尔会有 1~2 个 NaN 像素（场景 HDR 除零等），蝶形运算会在 ~19 级内
// 把单个 NaN 扩散到整幅频谱 → 泛光整张 NaN → EFX 把整帧压黑（滚动时偶发单帧黑屏）。
// 在每个 stage 出口清洗一次，NaN 最多只影响它自己那个像素。
float nonFiniteToZero(float v) {
  return (v > -1.0e30 && v < 1.0e30) ? v : 0.0;
}

void main() {
  // 当前输出像素在本次子变换中的索引
  float index, evenIndex;
  // 偶数位 / 奇数位输入纹理的采样坐标
  vec2 evenPos, oddPos;
  // 水平方向 FFT：索引取 x 坐标
  if (u_isHorizontal) {
    // gl_FragCoord 以像素中心为 0.5，减 0.5 得到整数索引
    index = gl_FragCoord.x - 0.5;
    // Stockham 自排序：先按子变换块分组，再块内取偶/奇半边 → 得到偶数位索引
    evenIndex = floor(index / u_subtransformSize) * (u_subtransformSize * 0.5) + mod(index, u_subtransformSize * 0.5);
    // 转成 UV（乘以 texelSize）
    evenPos = vec2(evenIndex, gl_FragCoord.y) * u_texelSize;
    // 奇数位紧邻偶数位（相差 0.5 像素 = 子变换半长）
    oddPos = evenPos + vec2(0.5, 0.0);
  } else {
    // 垂直方向 FFT：索引取 y 坐标
    index = gl_FragCoord.y - 0.5;
    // 同样的偶数位映射，只是作用在 y 上
    evenIndex = floor(index / u_subtransformSize) * (u_subtransformSize * 0.5) + mod(index, u_subtransformSize * 0.5);
    // 偶数位 UV
    evenPos = vec2(gl_FragCoord.x, evenIndex) * u_texelSize;
    // 奇数位 UV（y 方向偏移 0.5 像素）
    oddPos = evenPos + vec2(0.0, 0.5);
  }

  // 偶数位输入：xy = 两路复数序列的实部，zw = 两路复数序列的虚部
  vec4 even = texture2D(u_texture, evenPos);
  // 奇数位输入，同样打包着两路复数的实部/虚部
  vec4 odd = texture2D(u_texture, oddPos);

  // 旋转因子（twiddle）角度：正向 FFT 用 +2π，逆向用 -2π
  float twiddleArgument = (u_isForward ? 6.283185307179586 : -6.283185307179586) * (index / u_subtransformSize);
  // 旋转因子 e^{iθ} = cosθ + i·sinθ
  vec2 twiddle = vec2(cos(twiddleArgument), sin(twiddleArgument));
  // 蝶形运算：even + twiddle × odd（复数乘法展开，实部/虚部分别计算）
  // 复数乘法：(a+bi)(c+di) = (ac-bd) + (ad+bc)i
  // 最后乘归一化系数（仅第一步做 1/sqrt(N) 防止数值溢出）
  vec4 result = (even + vec4(
    // 第一路复数的新实部 = tw.x*odd.re - tw.y*odd.im
    twiddle.x * odd.xy - twiddle.y * odd.zw,
    // 第二路复数的新虚部 = tw.y*odd.re + tw.x*odd.im
    twiddle.y * odd.xy + twiddle.x * odd.zw
  )) * u_normalization;
  // 逐分量清洗 NaN/Inf，阻断扩散
  gl_FragColor = vec4(
    nonFiniteToZero(result.x), nonFiniteToZero(result.y),
    nonFiniteToZero(result.z), nonFiniteToZero(result.w)
  );
}
`;

/* ── 频域复乘 ── */
const mixFragment = /* glsl */ `
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_kernelTexture;

void main() {
  // 输入图像的频谱（ab 为一路复数，zw 为另一路）
  vec4 a = texture2D(u_texture, v_uv);
  // 卷积核的频谱
  vec4 b = texture2D(u_kernelTexture, v_uv);
  // 频域相乘 = 空域卷积：复数乘法展开成实部/虚部
  gl_FragColor = vec4(
    // 实部：ac - bd
    a.xy * b.xy - a.zw * b.zw,
    // 虚部：ad + bc
    a.xy * b.zw + a.zw * b.xy
  );
}
`;

/* ── 归一化 + 饱和度（原站 convolutionCacheFrag 逐字移植）── */
const cacheFragment = /* glsl */ `
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_amount;
uniform float u_saturation;

void main() {
  // 逆向 FFT 结果乘归一化系数（补偿 FFT 的缩放）
  gl_FragColor = texture2D(u_texture, v_uv) * u_amount;
  // 饱和度：在灰度（Rec.601 亮度）与彩色之间插值
  gl_FragColor.rgb = mix(vec3(dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114))), gl_FragColor.rgb, u_saturation);
}
`;

/* ── 最终合成（含抖动）──
   注意：原站的颜色（隧道 vec3(0.102,0.184,0.984) 等）本身就是显示空间取值，
   管线里不能再做 linearToSRGB，否则白隧道会整体发白、丢饱和度。 */
const compositeFragment = /* glsl */ `
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_bloomTexture;
uniform float u_convolutionBuffer;

float rand(vec2 co) {
  // 经典 sine 哈希：把二维坐标映射成 [0,1) 伪随机数（廉价、够用）
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 dithering(vec3 color) {
  // 每个像素取一个随机值，决定抖动方向
  float gridPosition = rand(gl_FragCoord.xy);
  // 基础抖动幅度：±0.25/255（约半个 8bit 量化步长）
  vec3 shift = vec3(0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0);
  // 按随机值在 +2×shift 与 -2×shift 之间插值，RGB 三通道方向不同 → 彩色抖动
  shift = mix(2.0 * shift, -2.0 * shift, gridPosition);
  // 叠加抖动，掩盖 8bit 输出时的色带
  return color + shift;
}

vec3 linearToSRGB(vec3 c) {
  // 分段线性近似：暗部用线性段（12.92c），亮部用 gamma 2.4 幂函数；step 做区间选择
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  // 原始场景颜色
  vec4 c = texture2D(u_texture, v_uv);
  // 把 bloom 纹理的 UV 从"外扩坐标系"映射回屏幕坐标（除以 1+buffer）
  vec2 bloomUv = (v_uv - 0.5) / (1.0 + u_convolutionBuffer) + 0.5;
  // 叠加泛光（相加，模拟光的能量累积）
  c.rgb += texture2D(u_bloomTexture, bloomUv).rgb;
  // 抖动后输出（alpha 固定 1）
  gl_FragColor = vec4(dithering(c.rgb), 1.0);
}
`;

export class GoalBloomPass extends Pass {
  constructor() {
    // Pass 基类构造函数
    super();
    // 该 pass 需要读写两张 buffer 交换（ping-pong）
    this.needsSwap = true;
    // 不需要清空目标 buffer（全屏覆盖写入）
    this.clear = false;
    // 默认直接输出到屏幕（由 EffectComposer 决定）
    this.renderToScreen = true;

    // 与原站 Bloom 同名的可调参数
    // 泛光强度（0 = 关闭，走 else 分支清空 bloom 图）
    this.amount = 0;
    // 半径（当前版本未直接使用，保留与原站参数对齐）
    this.radius = 0;
    // 阈值（卷积版由 highPassMultiplier/alpha 控制，这里保留占位）
    this.threshold = 0;
    // 阈值平滑宽度（保留占位）
    this.smoothWidth = 0.01;
    // 亮部提取倍率
    this.highPassMultiplier = 1;
    // 饱和度
    this.saturation = 1;
    // halo 拖影宽度
    this.haloWidth = 0.6;
    // halo 色散强度
    this.haloRGBShift = 0.02;
    // halo 亮度（0 = 关闭）
    this.haloStrength = 0;
    // halo 遮罩内半径：小于该半径不发光
    this.haloMaskInner = 0.3;
    // halo 遮罩外半径：大于该半径完全发光
    this.haloMaskOuter = 0.5;
    // 频谱缓冲区外扩比例：防止 FFT 循环卷积在边缘产生回卷
    this.convolutionBuffer = 0.1;
    // FFT 分辨率降采样位移（1 = 每边减半）
    this.convolutionMixDownScale = 1;
    // 调试：1=highPass输出 2=前向FFT 3=卷积核FFT 4=逆向FFT 5=归一化输出 0=正常
    this.debugStep = 0;

    // FFT 用 RT 配置：半浮点 + 最近邻（频域不允许插值，否则会破坏相位）
    const fftOpts = {
      // HalfFloat 提供 HDR 动态范围，同时省带宽
      type: THREE.HalfFloatType,
      // 缩小过滤必须最近邻
      minFilter: THREE.NearestFilter,
      // 放大过滤同样最近邻
      magFilter: THREE.NearestFilter,
      // FFT 不需要深度
      depthBuffer: false,
      // 也不需要模板
      stencilBuffer: false,
    };
    // 线性过滤 RT 配置：用于 highPass / 最终 bloom 图（需要平滑采样）
    const linOpts = {
      // 半浮点
      type: THREE.HalfFloatType,
      // 线性缩小
      minFilter: THREE.LinearFilter,
      // 线性放大
      magFilter: THREE.LinearFilter,
      // 无深度
      depthBuffer: false,
      // 无模板
      stencilBuffer: false,
    };
    // 亮部提取渲染目标（线性采样）
    this.highPassRT = new THREE.WebGLRenderTarget(1, 1, linOpts);
    // 卷积核的频谱（固定内容，resize 时重算一次）
    this.fftSrcRT = new THREE.WebGLRenderTarget(1, 1, fftOpts);
    // FFT 中间缓存 A（乒乓交替）
    this.fftCacheRT1 = new THREE.WebGLRenderTarget(1, 1, fftOpts);
    // FFT 中间缓存 B（乒乓交替）
    this.fftCacheRT2 = new THREE.WebGLRenderTarget(1, 1, fftOpts);
    // 最终 bloom 图（线性采样，供合成时放大回屏幕）
    this.fftBloomOutCacheRT = new THREE.WebGLRenderTarget(1, 1, linOpts);

    // highPass 材质：亮部提取 + halo
    this.highPassMaterial = new THREE.ShaderMaterial({
      uniforms: {
        // 输入画面
        u_texture: { value: null },
        // 亮部倍率
        u_amount: { value: 1 },
        // 1 / 屏幕分辨率
        u_texelSize: { value: new THREE.Vector2(1, 1) },
        // 宽高比（等比坐标）
        u_aspect: { value: new THREE.Vector2(1, 1) },
        // halo 宽度
        u_haloWidth: { value: 0.6 },
        // halo 色散
        u_haloRGBShift: { value: 0.02 },
        // halo 强度
        u_haloStrength: { value: 0 },
        // halo 遮罩内/外半径
        u_haloMaskInner: { value: 0.3 },
        u_haloMaskOuter: { value: 0.5 },
        // 频谱缓冲外扩比例
        u_convolutionBuffer: { value: 0.1 },
      },
      vertexShader: quadVertex,
      fragmentShader: highPassFragment,
      // 后处理全屏 pass 的标准配置
      depthTest: false,
      depthWrite: false,
      // 直接覆盖写入，不做混合
      blending: THREE.NoBlending,
    });

    // 卷积核生成材质（只在 resize 时用一次）
    this.kernelMaterial = new THREE.ShaderMaterial({
      uniforms: { u_aspect: { value: new THREE.Vector2(1, 1) } },
      vertexShader: quadVertex,
      fragmentShader: kernelFragment,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

    // 水平 FFT 材质（Stockham radix-2 蝶形）
    this.fftHMaterial = new THREE.ShaderMaterial({
      uniforms: {
        // 输入频谱/图像
        u_texture: { value: null },
        // 1 / FFT 分辨率
        u_texelSize: { value: new THREE.Vector2(1, 1) },
        // 当前子变换长度（2 的幂，逐级翻倍）
        u_subtransformSize: { value: 1 },
        // 归一化系数（仅第一步非 1）
        u_normalization: { value: 1 },
        // 正向 / 逆向 FFT 标记
        u_isForward: { value: true },
        // 水平 / 垂直标记
        u_isHorizontal: { value: true },
      },
      vertexShader: quadVertex,
      fragmentShader: fftFragment,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    // 垂直 FFT 材质：克隆水平版本，只改 isHorizontal 标志
    this.fftVMaterial = this.fftHMaterial.clone();
    this.fftVMaterial.uniforms.u_isHorizontal.value = false;

    // 频域复乘材质（图像频谱 × 卷积核频谱）
    this.mixMaterial = new THREE.ShaderMaterial({
      uniforms: {
        // 图像频谱
        u_texture: { value: null },
        // 卷积核频谱（直接引用 fftSrcRT，避免每次重绑）
        u_kernelTexture: { value: this.fftSrcRT.texture },
      },
      vertexShader: quadVertex,
      fragmentShader: mixFragment,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

    // 归一化 + 饱和度材质
    this.cacheMaterial = new THREE.ShaderMaterial({
      uniforms: {
        // 逆向 FFT 结果
        u_texture: { value: null },
        // 归一化倍率
        u_amount: { value: 1 },
        // 饱和度
        u_saturation: { value: 1 },
      },
      vertexShader: quadVertex,
      fragmentShader: cacheFragment,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

    // 最终合成材质（原画面 + bloom + 抖动）
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        // 原画面
        u_texture: { value: null },
        // bloom 图
        u_bloomTexture: { value: null },
        // 外扩比例，用于把 bloom UV 映射回屏幕
        u_convolutionBuffer: { value: 0.1 },
      },
      vertexShader: quadVertex,
      fragmentShader: compositeFragment,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

    // 共享的全屏 quad，渲染时只切换 material
    this.quad = new FullScreenQuad(this.highPassMaterial);
    // 记录屏幕尺寸
    this._size = new THREE.Vector2(1, 1);
    // 记录 FFT 尺寸（0 表示尚未初始化）
    this._fftSize = new THREE.Vector2(0, 0);
  }

  setSize(width, height) {
    // 记录屏幕尺寸
    this._size.set(width, height);
    // FFT 宽度：屏幕一半再向上取 2 的幂，并可按 downScale 再右移减半
    const n = powerTwoCeiling(width / 2) >> this.convolutionMixDownScale;
    // FFT 高度同理
    const a = powerTwoCeiling(height / 2) >> this.convolutionMixDownScale;
    // 亮部 RT 使用同样尺寸
    this.highPassRT.setSize(n, a);
    // 仅当 FFT 尺寸真的变化时才重建所有 RT（避免每帧 setSize 导致纹理重建）
    if (this.fftCacheRT1.width !== n || this.fftCacheRT1.height !== a) {
      // 卷积核频谱 RT
      this.fftSrcRT.setSize(n, a);
      // 缓存 A
      this.fftCacheRT1.setSize(n, a);
      // 缓存 B
      this.fftCacheRT2.setSize(n, a);
      // 最终 bloom RT
      this.fftBloomOutCacheRT.setSize(n, a);
      // 更新记录的 FFT 尺寸
      this._fftSize.set(n, a);
      // 尺寸变化后卷积核需要重新生成并做一次 FFT
      this._kernelDirty = true;
    }
  }

  _renderQuad(renderer, material, target) {
    // 切换 quad 的材质
    this.quad.material = material;
    // 绑定目标 RT（null = 屏幕）
    renderer.setRenderTarget(target);
    // 渲染全屏 quad
    this.quad.render(renderer);
  }

  /** 原站 renderFFT：e=输入 RT，t=输出 RT；结果保证落在 t */
  _renderFFT(renderer, e, t, isForward) {
    // 输入纹理宽度（2 的幂）
    const n = e.width;
    // 输入纹理高度（2 的幂）
    const a = e.height;
    // 水平方向需要的 pass 数 = log2(width)
    const l = Math.log2(n);
    // 垂直方向需要的 pass 数 = log2(height)
    const c = Math.log2(a);
    // 总 pass 数
    const u = l + c;
    // 总 pass 数为偶数时，乒乓交换后结果会落在临时变量 src 而非 t，需要额外拷贝
    const f = u % 2 === 0;
    // 源 RT 从输入开始
    let src = e;
    // 目标 RT 从输出开始
    let dst = t;
    // 逐级执行蝶形 pass：前 l 个是水平方向，后 c 个是垂直方向
    for (let g = 0; g < u; g++) {
      // 当前 pass 是否属于水平阶段
      const v = g < l;
      // 水平阶段用 H 材质，垂直阶段用 V 材质
      const mat = v ? this.fftHMaterial : this.fftVMaterial;
      // uniform 短引用
      const uni = mat.uniforms;
      // 输入纹理 = 上一级结果
      uni.u_texture.value = src.texture;
      // 只在第一级做 1/sqrt(N) 归一化，避免逐级累积导致数值下溢/溢出
      uni.u_normalization.value = g === 0 ? 1 / Math.sqrt(n * a) : 1;
      // 传入正向/逆向标志（决定 twiddle 的符号）
      uni.u_isForward.value = isForward;
      // 1 / 分辨率
      uni.u_texelSize.value.set(1 / n, 1 / a);
      // 子变换长度：每级翻倍（2,4,8,...）；垂直阶段重新从 2 开始计数
      uni.u_subtransformSize.value = Math.pow(2, (v ? g : g - l) + 1);
      // 执行一级蝶形运算
      this._renderQuad(renderer, mat, dst);
      // 乒乓交换：本级输出成为下一级输入
      const tmp = src;
      src = dst;
      dst = tmp;
    }
    if (f) {
      // 偶数 pass：结果在 src，拷回 t
      // 绑定临时结果
      this.copyMaterial.uniforms.u_texture.value = src.texture;
      // 拷贝到调用方期望的输出 RT
      this._renderQuad(renderer, this.copyMaterial, t);
    }
  }

  get copyMaterial() {
    // 懒创建：只有需要拷贝时才建材质
    if (!this._copyMaterial) {
      // 极简全屏拷贝着色器
      this._copyMaterial = new THREE.ShaderMaterial({
        uniforms: { u_texture: { value: null } },
        vertexShader: quadVertex,
        // 直接采样并输出，不做任何处理
        fragmentShader: `varying vec2 v_uv; uniform sampler2D u_texture; void main(){ gl_FragColor = texture2D(u_texture, v_uv); }`,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
      });
    }
    // 返回缓存的材质
    return this._copyMaterial;
  }

  render(renderer, writeBuffer, readBuffer) {
    // 屏幕宽
    const width = this._size.x;
    // 屏幕高
    const height = this._size.y;
    // FFT 宽度
    const fftW = this._fftSize.x;
    // FFT 高度
    const fftH = this._fftSize.y;

    // 卷积核（resize 时重算一次）
    if (this._kernelDirty) {
      // 清除脏标记，避免每帧重复计算
      this._kernelDirty = false;
      // 用短边归一化，保证核在任意宽高比下都是圆形而不是椭圆
      const l = height / Math.max(width, height);
      // aspect = (宽/高 × l, l)
      this.kernelMaterial.uniforms.u_aspect.value.set((width / height) * l, l);
      // 先生成空域卷积核图
      this._renderQuad(renderer, this.kernelMaterial, this.fftCacheRT1);
      // 再做一次正向 FFT，缓存成频域卷积核
      this._renderFFT(renderer, this.fftCacheRT1, this.fftSrcRT, true);
    }

    // 1) high pass + halo（直接渲进 fftCacheRT1，省一次拷贝）
    // highPass uniform 短引用
    const hp = this.highPassMaterial.uniforms;
    // 输入 = 上一 pass 的输出画面
    hp.u_texture.value = readBuffer.texture;
    // 亮部倍率
    hp.u_amount.value = this.highPassMultiplier;
    // 屏幕级 texel 尺寸，供 halo 色散使用
    hp.u_texelSize.value.set(1 / width, 1 / height);
    // 用对角线长度归一化，得到"屏幕半径"尺度
    const hl = (height / Math.sqrt(width * width + height * height)) * 2;
    // aspect 用同样的尺度校准
    hp.u_aspect.value.set((width / height) * hl, hl);
    // halo 宽度
    hp.u_haloWidth.value = this.haloWidth;
    // 原站 setPostprocessing：u_haloRGBShift = haloRGBShift * 画布宽度（配合 u_texelSize.x 得到 UV 级色散）
    hp.u_haloRGBShift.value = this.haloRGBShift * width;
    // halo 强度
    hp.u_haloStrength.value = this.haloStrength;
    // halo 遮罩半径
    hp.u_haloMaskInner.value = this.haloMaskInner;
    hp.u_haloMaskOuter.value = this.haloMaskOuter;
    // 频谱外扩比例
    hp.u_convolutionBuffer.value = this.convolutionBuffer;
    // 渲染亮部到缓存 A（同时作为下一步 FFT 的输入）
    this._renderQuad(renderer, this.highPassMaterial, this.fftCacheRT1);

    // amount = 0 时跳过整个 FFT 链路，直接把 bloom 图清成黑色（等价于关闭泛光）
    if (this.amount > 0) {
      // 2) 前向 FFT
      // 亮部图 → 频谱（输出到缓存 B）
      this._renderFFT(renderer, this.fftCacheRT1, this.fftCacheRT2, true);
      // 3) 频域复乘卷积核
      // 图像频谱
      this.mixMaterial.uniforms.u_texture.value = this.fftCacheRT2.texture;
      // 已缓存的卷积核频谱
      this.mixMaterial.uniforms.u_kernelTexture.value = this.fftSrcRT.texture;
      // 复乘结果写回缓存 A
      this._renderQuad(renderer, this.mixMaterial, this.fftCacheRT1);
      // 4) 逆向 FFT
      // 频域乘积 → 空域模糊结果（写回缓存 B）
      this._renderFFT(renderer, this.fftCacheRT1, this.fftCacheRT2, false);
      // 5) 归一化 + 饱和度
      // 基础倍率：amount → 1024 量级（补偿 FFT 能量缩放）
      let c = this.amount * 1024;
      // 再按 FFT 总像素数的四次方根缩放，并乘经验系数 0.85（与原站一致）
      c = (c / Math.pow(Math.ceil(Math.log2(fftW * fftH)), 4)) * 0.85;
      // 输入逆向 FFT 结果
      this.cacheMaterial.uniforms.u_texture.value = this.fftCacheRT2.texture;
      // 归一化倍率
      this.cacheMaterial.uniforms.u_amount.value = c;
      // 饱和度
      this.cacheMaterial.uniforms.u_saturation.value = this.saturation;
      // 输出最终 bloom 图
      this._renderQuad(renderer, this.cacheMaterial, this.fftBloomOutCacheRT);
    } else {
      // 关闭泛光：保存当前清屏色与 alpha，临时改成透明黑来清空 bloom RT
      const prevColor = new THREE.Color();
      // 读取当前清屏色
      renderer.getClearColor(prevColor);
      // 读取当前清屏 alpha
      const prevAlpha = renderer.getClearAlpha();
      // 临时清屏色设为黑色
      renderer.setClearColor(0x000000, 0);
      // 绑定 bloom RT
      renderer.setRenderTarget(this.fftBloomOutCacheRT);
      // 只清颜色，不动深度/模板
      renderer.clear(true, false, false);
      // 恢复清屏状态，避免影响其它 pass
      renderer.setClearColor(prevColor, prevAlpha);
    }

    // 6) 合成
    // 合成材质 uniform 短引用
    const cm = this.compositeMaterial.uniforms;
    // 原画面
    cm.u_texture.value = readBuffer.texture;
    // bloom 图
    cm.u_bloomTexture.value = this.fftBloomOutCacheRT.texture;
    // 外扩比例
    cm.u_convolutionBuffer.value = this.convolutionBuffer;
    // 输出目标：直接上屏或写回 writeBuffer
    const target = this.renderToScreen ? null : writeBuffer;
    // 执行最终合成
    this._renderQuad(renderer, this.compositeMaterial, target);

    // 调试：把中间 RT 直接上屏
    if (this.debugStep > 0) {
      // 调试步骤 → 对应 RT 的映射表
      const dbgMap = {
        1: this.fftCacheRT1, // highPass 输出
        2: this.fftCacheRT2, // 前向 FFT 结果
        3: this.fftSrcRT, // 卷积核 FFT
        4: this.fftCacheRT2, // 逆向 FFT 结果
        5: this.fftBloomOutCacheRT, // 归一化输出
      };
      // 绑定被调试的纹理
      this.copyMaterial.uniforms.u_texture.value = dbgMap[this.debugStep].texture;
      // 直接拷贝到屏幕
      this._renderQuad(renderer, this.copyMaterial, null);
    }
  }

  dispose() {
    // 释放所有渲染目标
    this.highPassRT.dispose();
    this.fftSrcRT.dispose();
    this.fftCacheRT1.dispose();
    this.fftCacheRT2.dispose();
    this.fftBloomOutCacheRT.dispose();
    // 释放所有材质
    this.highPassMaterial.dispose();
    this.kernelMaterial.dispose();
    this.fftHMaterial.dispose();
    this.fftVMaterial.dispose();
    this.mixMaterial.dispose();
    this.cacheMaterial.dispose();
    this.compositeMaterial.dispose();
    // 拷贝材质可能未被创建过，用可选链防护
    this._copyMaterial?.dispose();
    // 释放全屏 quad 的几何体与内部资源
    this.quad.dispose();
  }
}
