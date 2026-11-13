/**
 * ScreenPaint.js — 屏幕空间流体笔刷（1:1 移植自 lusion.co 线上 bundle）
 *
 * ─────────────────────────────────────────────────────────────
 * 原理（从原站逆向出的完整链路）
 * ─────────────────────────────────────────────────────────────
 * 这不是真正的 Navier-Stokes 解算器，而是一张「四通道速度/权重图」：
 *
 *   RG 通道：速度场，为了存进 8 位纹理，编码成 velocity + 0.5
 *   B  通道：主权重 weight1（笔刷"墨量"，决定可见强度）
 *   A  通道：次权重 weight2（笔刷边缘/附加量）
 *
 * 每帧只做三件事：
 *   1) 平流（advection）：用当前速度场把上一帧的图"推着走"
 *      —— 半拉格朗日法：采样位置 = 当前 uv - 速度 * texelSize
 *   2) 衰减（dissipation）：速度 ×0.975、weight1 ×0.95、weight2 ×0.8
 *   3) 注入（injection）：把这一帧鼠标走过的线段（sdSegment）画进速度与权重
 *
 * 速度场不是直接用原始图，而是先拷贝到 1/8 分辨率并做 9-tap 双向模糊后再采样。
 * 原因：
 *   - 低分辨率让速度场更平滑，平流时不会出现高频锯齿
 *   - 模糊把"笔刷边缘"扩散开，形成向外推的连续流场而不是硬边圆
 *
 * 坐标与分辨率：
 *   paint  RT = viewport / 4   （模拟本体）
 *   low    RT = viewport / 8   （模糊后的速度场，供着色器回溯采样）
 *   ping-pong：prev ↔ curr 两张 RT 交替读写，避免读写的纹理是同一张
 *
 * 笔刷半径由鼠标速度决定：速度越快半径越大（原站 fit(speed, 0, 100, 0, maxRadius)），
 * 鼠标停下时半径归零 —— 此时不再注入新墨，但已有流速仍在平流，尾巴会继续流走。
 *
 * 最终这张纹理交给 ScreenPaintDistortion 做屏幕折射。
 */

import * as THREE from 'three';
import { fit } from './math.js';

/** 全屏三角形共享顶点 —— 3 个顶点覆盖整个 NDC，比四边形少一个三角形 */
function makeFullscreenGeometry() {
  // 空几何体
  const geo = new THREE.BufferGeometry();
  // position：三角形三个顶点分别放在 (-1,-1)、(3,-1)、(-1,3)，裁剪后正好铺满屏幕
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-1, -1, 0, 3, -1, 0, -1, 3, 0], 3
  ));
  // uv：与放大后的顶点对应，屏幕内区域恰好落在 [0,1]
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(
    [0, 0, 2, 0, 0, 2], 2
  ));
  // 返回几何体
  return geo;
}

/** 全屏 pass 通用顶点着色器 */
const FULLSCREEN_VERT = /* glsl */`
  attribute vec3 position;
  attribute vec2 uv;
  varying vec2 v_uv;

  void main() {
    // UV 直接透传给片元，不经过任何变换
    v_uv = uv;
    // 顶点坐标已是 NDC，z 取 0、w 取 1 不做透视除法
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** 模拟主 pass —— 平流 + 衰减 + 笔刷注入 */
const PAINT_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D u_lowPaintTexture;   // 1/8 分辨率 + 模糊后的速度场
  uniform sampler2D u_prevPaintTexture;  // 上一帧 paint（1/4 分辨率）
  uniform vec2  u_paintTexelSize;        // 1 / paint 分辨率
  uniform vec2  u_scrollOffset;          // 页面滚动偏移（本项目恒为 0）
  uniform vec4  u_drawFrom;              // xy = 起点像素坐标，z = 起点半径，w = 1
  uniform vec4  u_drawTo;                // xy = 终点像素坐标，z = 终点半径，w = 1
  uniform float u_pushStrength;          // 速度回推强度（原站默认 25）
  uniform vec3  u_dissipations;          // (速度, weight1, weight2) 每帧衰减系数
  uniform vec2  u_vel;                   // 本帧累积的鼠标速度（paint 像素/帧）
  uniform float u_idleDamping;           // 停手后对"残留速度"的额外衰减（1 = 不额外衰减）
  uniform float u_idleSpread;            // 停手后沿墨量梯度向外扩散的强度（0 = 关闭）
  uniform float u_active;                // 1 = 指针在动，0 = 已停手（平滑过渡）

  #ifdef USE_NOISE
    uniform float u_curlScale;           // 噪声采样缩放（原站默认 0.02）
    uniform float u_curlStrength;        // 涡流强度（原站默认 3）
    uniform vec2  u_noiseOffset;         // 噪声场随时间缓慢漂移，避免固定方向
  #endif

  varying vec2 v_uv;

  /**
   * 点到线段的有符号距离场
   * @return vec2(距离, 投影参数 h)，h ∈ [0,1] 表示落在线段上的位置
   *         半径就是靠这个 h 在起点/终点半径之间插值
   */
  vec2 sdSegment(in vec2 p, in vec2 a, in vec2 b) {
    // 点到起点的向量
    vec2 pa = p - a;
    // 线段方向向量
    vec2 ba = b - a;
    // 把 pa 投影到 ba 上并归一化到 [0,1]，得到落点参数（钳制避免超出线段）
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    // 返回 (点到线段的距离, 投影参数)
    return vec2(length(pa - ba * h), h);
  }

  #ifdef USE_NOISE
    /** 3D → 2D 的哈希，返回 [-1,1] 的梯度向量 */
    vec2 hash(vec2 p) {
      // 经典 sine-free 哈希：三个分量乘不同无理系数后取小数
      vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
      // 与自身错位分量点积，增强相邻格点的去相关性
      p3 += dot(p3, p3.yzx + 33.33);
      // 混合后映射到 [-1,1]，作为梯度方向
      return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
    }

    /**
     * 梯度噪声（Perlin 风格）+ 解析导数
     * 返回 (噪声值, 梯度 xy)
     * 用两层不同频率的噪声相减/叠加，得到卷曲的"涡流"位移
     */
    vec3 noised(in vec2 p) {
      // 所在格点索引
      vec2 i = floor(p);
      // 格点内的小数偏移
      vec2 f = fract(p);
      // 五次平滑插值权重（首尾一阶、二阶导连续，避免网格纹）
      vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      // 平滑权重的导数，用于解析求梯度
      vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

      // 四个角点的梯度向量
      vec2 ga = hash(i + vec2(0.0, 0.0));
      vec2 gb = hash(i + vec2(1.0, 0.0));
      vec2 gc = hash(i + vec2(0.0, 1.0));
      vec2 gd = hash(i + vec2(1.0, 1.0));

      // 每个角点梯度与"指向该角点"的向量点积，得到四个标量贡献
      float va = dot(ga, f - vec2(0.0, 0.0));
      float vb = dot(gb, f - vec2(1.0, 0.0));
      float vc = dot(gc, f - vec2(0.0, 1.0));
      float vd = dot(gd, f - vec2(1.0, 1.0));

      // 双线性插值的噪声值 + 同公式的解析梯度（xy）
      return vec3(
        // 噪声值：标准的分片双线性混合
        va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd),
        // 梯度：对权重求导后合并各角点贡献
        ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
           + du * (u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va)
      );
    }
  #endif

  void main() {
    // ① 当前像素到"本帧鼠标线段"的距离
    // res.x = 距离，res.y = 线段上的归一化位置
    vec2 res = sdSegment(gl_FragCoord.xy, u_drawFrom.xy, u_drawTo.xy);

    // ② 半径在线段两端插值：鼠标移动越快，笔刷越粗
    // zw 分别是起点/终点半径，res.y 作为插值权重
    vec2 radiusWeight = mix(u_drawFrom.zw, u_drawTo.zw, res.y);

    // ③ 覆盖率：距离 < 半径时接近 1；-0.01 让边缘再软一点
    // smoothstep 内外边界给出 0→1 的软过渡，1- 后成为笔刷覆盖率
    float d = 1.0 - smoothstep(-0.01, radiusWeight.x, res.x);

    // ④ 读取模糊后的速度场。0.5 是编码偏移，所以 (0.5 - xy) 得到真实速度
    // 用 v_uv - scrollOffset 把页面滚动量补偿掉
    vec4 lowData = texture2D(u_lowPaintTexture, v_uv - u_scrollOffset);
    // 速度取反并放大 pushStrength，得到"逆向回溯"的偏移量
    vec2 velInv = (0.5 - lowData.xy) * u_pushStrength;

    #ifdef USE_NOISE
      // ⑤ 用两层噪声做 curl 扰动：第一层决定第二层的采样位置，
      //    再乘上当前笔刷权重 —— 只有画过的地方才会卷动，形成"墨迹扩散"的湍流。
      //    噪声场本身随时间缓慢漂移，避免同一块区域被长期推向同一个方向。
      // 噪声采样起始偏移（随时间漂移）
      vec2 noiseCoord = u_noiseOffset;
      // 第一层噪声：用低分辨率速度反向调制频率（速度大处频率低 → 更平滑）
      vec3 noise3 = noised(gl_FragCoord.xy * u_curlScale * (1.0 - lowData.xy) + noiseCoord);
      // 第二层噪声：用第一层的值与梯度再扰动采样坐标，得到卷曲的梯度向量（yz 分量）
      vec2 noise = noised(
        // 第二层采样坐标
        gl_FragCoord.xy * u_curlScale *
        (2.0 - lowData.xy * (0.5 + noise3.x) + noise3.yz * 0.1)
        // 反向偏移，避免两层噪声同向
        - noiseCoord.yx * 1.7
      ).yz;
      // 噪声梯度按墨量加权，只有有墨的地方才卷动
      velInv += noise * (lowData.z + lowData.w) * u_curlStrength;
    #endif

    // ⑥ 停手后把"推动墨迹前进"的速度整体关掉（u_active 在约 0.14 秒内平滑降到 0）。
    //    原站的速度场要 1~2 秒才衰减完，这段时间墨迹会沿最后一次移动方向持续平移，
    //    观感就像"受重力往下滑"。关掉之后墨迹不再整体位移，只在原地化开。
    velInv *= u_active;

    // ⑦ 停手后的向外扩散：取四周墨量的梯度（指向墨更浓的一侧）。
    //    velInv 是回溯采样的偏移，取 +梯度 时画面内容朝 -梯度 方向移动，
    //    即从墨浓处流向墨稀处 —— 墨团像滴在纸上一样向四周摊开。
    // 一个 texel 的步长
    vec2 wStep = u_paintTexelSize;
    // 右 / 左 / 上 / 下四个邻居（用低分辨率速度场的权重通道）
    vec4 lowR = texture2D(u_lowPaintTexture, v_uv + vec2(wStep.x, 0.0));
    vec4 lowL = texture2D(u_lowPaintTexture, v_uv - vec2(wStep.x, 0.0));
    vec4 lowU = texture2D(u_lowPaintTexture, v_uv + vec2(0.0, wStep.y));
    vec4 lowD = texture2D(u_lowPaintTexture, v_uv - vec2(0.0, wStep.y));
    // 中心差分梯度：右-左、上-下（z+w 为总墨量）
    vec2 weightGrad = vec2(
      (lowR.z + lowR.w) - (lowL.z + lowL.w),
      (lowU.z + lowU.w) - (lowD.z + lowD.w)
    );
    // 梯度 × 扩散强度 × 停手程度（1-u_active：动的时候为 0）
    vec2 spread = weightGrad * (u_idleSpread * (1.0 - u_active));
    // 显式扩散的 CFL 限制：单帧回溯偏移不超过 0.75 个 texel，否则会数值发散
    // 偏移长度
    float spreadLen = length(spread);
    // 超限则等比缩放回 0.75
    if (spreadLen > 0.75) spread *= 0.75 / spreadLen;
    // 扩散偏移并入总的回溯偏移
    velInv += spread;

    // ⑧ 半拉格朗日平流：沿速度的反方向回溯，采样上一帧
    // 回溯位置 = 当前 uv + velInv × texelSize（velInv 已含负号方向）
    vec4 data = texture2D(
      u_prevPaintTexture,
      v_uv - u_scrollOffset + velInv * u_paintTexelSize
    );

    // ⑨ 衰减 + 注入
    data.xy -= 0.5;                                   // 速度解码

    // 停手后额外衰减残留速度（最多 0.75/帧），让它尽快归零，
    // 避免下次再动鼠标时"旧方向"的推力重新把墨迹整体带偏。
    data.xy *= u_idleDamping;
    // 逐通道衰减：以 8 位纹理为存储，按 (1-dissipation) 的比例扣除
    vec4 delta = (u_dissipations.xxyz - 1.0) * data;  // (v, v, w1, w2) 逐通道衰减
    // 本帧鼠标速度 × 覆盖率 = 注入到速度通道的量
    vec2 newVel = u_vel * d;                          // 本帧鼠标速度 × 覆盖率
    // 同时按覆盖率注入权重（zz 为 weight1、weight2）
    delta += vec4(newVel, radiusWeight.yy * d);       // 写回速度 + 权重

    // ⑧ 衰减下限：每帧至少衰减 0.004（≈1/255），
    //    否则 float→8bit 量化会让非常小的值永远卡在 1 上，尾巴散不掉
    delta.zw = sign(delta.zw) * max(vec2(0.004), abs(delta.zw));

    // 把本帧增量叠加到回溯采样值上
    data += delta;
    data.xy += 0.5;                                   // 速度重新编码
    // 钳制到 [0,1] 后写回 8 位 RT
    gl_FragColor = clamp(data, vec4(0.0), vec4(1.0));
  }
`;

/** 9-tap 高斯模糊（低分辨率速度场专用） */
const BLUR_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D u_texture;
  uniform vec2 u_delta;   // 单侧总偏移（水平或垂直）
  varying vec2 v_uv;

  void main() {
    // 中心权重（约 1/6，原站高斯近似系数）
    vec4 color = texture2D(u_texture, v_uv) * 0.1633;
    // 当前偏移量，初始为单侧一步
    vec2 delta = u_delta;
    // ±1 步（权重 0.1531）
    color += texture2D(u_texture, v_uv - delta) * 0.1531;
    color += texture2D(u_texture, v_uv + delta) * 0.1531;
    // 偏移加到 ±2 步
    delta += u_delta;
    // ±2 步（权重 0.12245）
    color += texture2D(u_texture, v_uv - delta) * 0.12245;
    color += texture2D(u_texture, v_uv + delta) * 0.12245;
    // 偏移加到 ±3 步
    delta += u_delta;
    // ±3 步（权重 0.0918）
    color += texture2D(u_texture, v_uv - delta) * 0.0918;
    color += texture2D(u_texture, v_uv + delta) * 0.0918;
    // 偏移加到 ±4 步
    delta += u_delta;
    // ±4 步（权重 0.0510）—— 共 9 个采样点
    color += texture2D(u_texture, v_uv - delta) * 0.0510;
    color += texture2D(u_texture, v_uv + delta) * 0.0510;
    // 输出模糊结果（权重和为 1，无需再归一化）
    gl_FragColor = color;
  }
`;

export class ScreenPaint {

  constructor(renderer, width = window.innerWidth, height = window.innerHeight) {
    // 渲染器引用，所有 fullscreen pass 都通过它执行
    this.renderer = renderer;
    // 当前画布宽（CSS 像素）
    this.width = width;
    // 当前画布高
    this.height = height;

    // —— 原站默认参数（properties.defaults 中逆向得到）——
    // 笔刷最小半径（鼠标静止时为 0）
    this.minRadius = 0;
    // 笔刷最大半径：与视口宽度挂钩，宽屏用大笔刷
    this.maxRadius = Math.max(40, width / 20);
    // 鼠标速度映射到半径的区间上限（像素/帧）
    this.radiusDistanceRange = 100;
    // 速度场回推强度（越大墨迹被带得越远）
    this.pushStrength = 25;
    // 鼠标速度自身的跨帧衰减（0.8 → 记忆约几帧）
    this.accelerationDissipation = 0.8;
    // 速度通道每帧衰减系数
    this.velocityDissipation = 0.975;
    // 主权重每帧衰减系数（决定墨迹可见时长）
    this.weight1Dissipation = 0.95;
    // 次权重每帧衰减系数（边缘/附加量，衰减更快）
    this.weight2Dissipation = 0.8;
    // 是否启用噪声湍流扰动
    this.useNoise = true;
    // 噪声采样缩放（越大花纹越碎）
    this.curlScale = 0.02;
    // 涡流强度
    this.curlStrength = 3;

    // —— 停手行为（本项目对原站的补充，可在 GUI 里调）——
    this.idleDelay = 0.06;            // 停手多久后开始收力（秒）
    this.idleRamp = 0.14;             // 收力过程持续多久（秒）
    this.idleDampingStrength = 0.25;  // 残留速度的额外衰减上限（0 = 不衰减，0.25 → 0.75/帧）
    this.idleSpread = 6;              // 停手后按墨量梯度向外扩散的强度

    // 本帧鼠标速度（paint 像素/帧），会跨帧累积、逐帧衰减
    // 供 shader 的 u_vel 使用（直接共享同一个 Vector2 实例）
    this._vel = new THREE.Vector2(0, 0);
    // 线段起点：xy 位置，z 半径，w 固定 1
    this._fromDrawData = new THREE.Vector4(0, 0, 0, 0);
    // 线段终点：同上
    this._toDrawData = new THREE.Vector4(0, 0, 0, 0);
    // 上一帧鼠标像素坐标，用于计算本帧速度
    this._prevMousePixel = new THREE.Vector2(0, 0);
    // 是否已有上一帧坐标（首帧速度应为 0）
    this._hasPrevMouse = false;
    // 噪声场的时间漂移偏移（每帧推进）
    this._noiseOffset = new THREE.Vector2(0, 0);
    // 累计时间（驱动噪声漂移）
    this._time = 0;
    this._idleTime = 0;   // 距离上一次指针移动的时间（秒）

    // 创建模拟/模糊/拷贝三套材质
    this._initMaterials();
    // 创建 ping-pong 与低分辨率 RT
    this._initTargets();
    // 应用初始尺寸并清空 RT
    this.resize(width, height);
  }

  // ———————————————— 初始化 ————————————————

  _initMaterials() {
    // 主模拟材质：平流 + 衰减 + 笔刷注入（RawShaderMaterial，attribute 由 shader 自行声明）
    this._paintMaterial = new THREE.RawShaderMaterial({
      uniforms: {
        // 1/8 分辨率模糊速度场（回溯偏移的来源）
        u_lowPaintTexture: { value: null },
        // 上一帧 paint（ping-pong 的另一张）
        u_prevPaintTexture: { value: null },
        // 1 / paint 分辨率
        u_paintTexelSize: { value: new THREE.Vector2() },
        // 页面滚动补偿（本项目恒 0）
        u_scrollOffset: { value: new THREE.Vector2(0, 0) },
        // 笔画起点/终点（共享实例，update 里原地修改）
        u_drawFrom: { value: this._fromDrawData },
        u_drawTo: { value: this._toDrawData },
        // 以下数值每帧由 update 写入
        u_pushStrength: { value: 0 },
        u_curlScale: { value: 0 },
        u_curlStrength: { value: 0 },
        // 噪声时间漂移（共享实例）
        u_noiseOffset: { value: this._noiseOffset },
        // 本帧鼠标速度（共享实例）
        u_vel: { value: this._vel },
        // 停手后的额外速度衰减（1 = 不衰减）
        u_idleDamping: { value: 1 },
        // 停手后的扩散强度
        u_idleSpread: { value: 6 },
        // 1 = 指针在动，0 = 已停手
        u_active: { value: 1 },
        // (速度, weight1, weight2) 三个衰减系数
        u_dissipations: { value: new THREE.Vector3() },
      },
      // 编译期开关：默认启用噪声扰动分支
      defines: { USE_NOISE: 1 },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: PAINT_FRAG,
      // 后处理不需要深度
      depthTest: false,
      depthWrite: false,
    });

    // 9-tap 模糊材质（低分辨率速度场专用）
    this._blurMaterial = new THREE.RawShaderMaterial({
      uniforms: {
        // 待模糊纹理
        u_texture: { value: null },
        // 单侧总偏移（水平或垂直）
        u_delta: { value: new THREE.Vector2() },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    // 纯拷贝材质（paint → low 时使用，不做任何滤波）
    this._copyMaterial = new THREE.RawShaderMaterial({
      uniforms: { u_texture: { value: null } },
      vertexShader: FULLSCREEN_VERT,
      // 内联极简片元：直接采样输出
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D u_texture;
        varying vec2 v_uv;
        void main() { gl_FragColor = texture2D(u_texture, v_uv); }
      `,
      depthTest: false,
      depthWrite: false,
    });

    // 共享一个全屏 quad，只换 material
    // 全屏三角形几何体
    this._quadGeo = makeFullscreenGeometry();
    // 先用主模拟材质建 mesh（渲染时会临时切换材质）
    this._quadMesh = new THREE.Mesh(this._quadGeo, this._paintMaterial);
    // 关闭视锥剔除
    this._quadMesh.frustumCulled = false;
    // 独立的 pass 场景
    this._quadScene = new THREE.Scene();
    // 把 mesh 加入场景
    this._quadScene.add(this._quadMesh);
    // 空相机：顶点着色器直接输出 NDC
    this._quadCamera = new THREE.Camera();
  }

  _initTargets() {
    // 所有 RT 共用配置：8 位 RGBA + 线性过滤（模糊时需要插值）
    const config = {
      // 缩小过滤线性（降采样时平滑）
      minFilter: THREE.LinearFilter,
      // 放大过滤线性
      magFilter: THREE.LinearFilter,
      // RGBA 四通道：RG 速度、B/A 两个权重
      format: THREE.RGBAFormat,
      // 8 位无符号：省显存，代价是需要 0.5 偏移编码速度 + 衰减下限
      type: THREE.UnsignedByteType,
      // 模拟不需要深度
      depthBuffer: false,
      // 也不需要模板
      stencilBuffer: false,
    };

    // 当前帧 paint（写入目标）
    this._currPaintRT = new THREE.WebGLRenderTarget(1, 1, config);
    // 上一帧 paint（读取源）——ping-pong 的另一半
    this._prevPaintRT = new THREE.WebGLRenderTarget(1, 1, config);
    // 1/8 分辨率速度场（模糊后供 shader 采样）
    this._lowRT = new THREE.WebGLRenderTarget(1, 1, config);
    // 1/8 分辨率模糊临时缓冲（水平模糊输出到这里，再做垂直模糊）
    this._lowBlurRT = new THREE.WebGLRenderTarget(1, 1, config);

    // 主模拟材质固定采样 lowRT（对象引用固定，resize 只改变其尺寸）
    this._paintMaterial.uniforms.u_lowPaintTexture.value = this._lowRT.texture;
  }

  // ———————————————— 尺寸 ————————————————

  resize(width, height) {
    // 宽高兜底最小值 1，避免 0 尺寸 RT
    this.width = Math.max(1, width);
    // 高度同样兜底
    this.height = Math.max(1, height);

    // 原站：paint = 1/4，low = 1/8
    // paint 宽 = viewport / 4（右移 2 位，向下取整）
    const paintW = Math.max(1, this.width >> 2);
    // paint 高
    const paintH = Math.max(1, this.height >> 2);
    // low 宽 = viewport / 8
    const lowW = Math.max(1, this.width >> 3);
    // low 高
    const lowH = Math.max(1, this.height >> 3);

    // 主模拟 RT（1/4）
    this._currPaintRT.setSize(paintW, paintH);
    // ping-pong 的另一半（1/4）
    this._prevPaintRT.setSize(paintW, paintH);
    // 低分辨率速度场（1/8）
    this._lowRT.setSize(lowW, lowH);
    // 模糊临时缓冲（1/8）
    this._lowBlurRT.setSize(lowW, lowH);

    // 写入 shader 的 texel 尺寸
    this._paintMaterial.uniforms.u_paintTexelSize.value.set(1 / paintW, 1 / paintH);
    // 对外暴露的 texelSize（ScreenPaintDistortion 每帧读取）
    this._texelSize = new THREE.Vector2(1 / paintW, 1 / paintH);

    // 半径上限与视口宽度相关（原站：max(40, viewportWidth / 20)）
    this.maxRadius = Math.max(40, this.width / 20);

    // 尺寸变化后鼠标基准失效，重置避免算出巨大笔画速度
    this._hasPrevMouse = false;
    // 清空所有 RT，防止旧尺寸内容残留
    this.clear();
  }

  /** 清空所有 RT —— 速度的"零点"是 0.5，所以清成 (0.5, 0.5, 0, 0) */
  clear() {
    // 清空当前帧 paint
    this._clearTarget(this._currPaintRT);
    // 清空上一帧 paint
    this._clearTarget(this._prevPaintRT);
    // 清空低分辨率速度场
    this._clearTarget(this._lowRT);
    // 清空模糊临时缓冲
    this._clearTarget(this._lowBlurRT);
    // 重置累积速度
    this._vel.set(0, 0);
  }

  _clearTarget(rt) {
    // 渲染器引用
    const renderer = this.renderer;
    // 保存当前 RT，清完恢复
    const prevRT = renderer.getRenderTarget();
    // 保存当前清屏色
    const prevColor = renderer.getClearColor(new THREE.Color());
    // 保存当前清屏 alpha
    const prevAlpha = renderer.getClearAlpha();

    // 绑定待清空的 RT
    renderer.setRenderTarget(rt);
    // 直接给线性 RGB 0.5，避免 hex 被当作 sRGB 做色彩空间转换
    // alpha 清零 → 两个权重通道的初始值都是 0（无墨）
    renderer.setClearColor(new THREE.Color(0.5, 0.5, 0), 0);
    // 执行清屏
    renderer.clear();

    // 恢复之前的 RT
    renderer.setRenderTarget(prevRT);
    // 恢复清屏色与 alpha，避免影响主场景渲染
    renderer.setClearColor(prevColor, prevAlpha);
  }

  // ———————————————— 每帧 ————————————————

  /**
   * @param {number} dt — 帧时间（秒）
   * @param {{x:number,y:number}} mousePixel — 当前鼠标像素坐标（左上原点）
   * @param {{x:number,y:number}} mouseNDC   — 当前鼠标 NDC 坐标（左下原点，y 向上）
   * @param {boolean} hadMoved               — 本帧指针是否移动
   */
  update(dt, mousePixel, mouseNDC, hadMoved) {
    // paint RT 宽度（已是 1/4 分辨率）
    const paintW = this._currPaintRT.width;
    // paint RT 高度
    const paintH = this._currPaintRT.height;

    // 噪声场缓慢漂移：方向持续变化，残留墨迹向四周散开而不是整体平移
    // 累计时间
    this._time += dt;
    // 两个分量用不同速率（0.35 / 0.27），避免噪声沿单一方向平移
    this._noiseOffset.set(this._time * 0.35, this._time * 0.27);

    // 停手判定：idleDelay 后开始收力，idleRamp 内把"推动墨迹"的外部速度完全关掉。
    // 这样残留的速度场不会继续把墨迹往某个固定方向推（观感像"往下滑"），
    // 墨迹只会在原地按墨量梯度向四周摊开，再随权重淡出。
    // 移动时清零，否则累加停手时长
    this._idleTime = hadMoved ? 0 : this._idleTime + dt;
    // 把停手时长映射到 [0,1]：delay 前为 0，delay+ramp 后为 1
    const idle = fit(
      this._idleTime,
      this.idleDelay,
      this.idleDelay + this.idleRamp,
      0,
      1
    );

    // —— 1. ping-pong 交换：上一帧的结果成为本帧的输入 ——
    // 暂存当前"上一帧"引用
    const prevRT = this._prevPaintRT;
    // 上一帧 = 原来的当前帧（上一帧刚渲染的结果）
    this._prevPaintRT = this._currPaintRT;
    // 当前帧改成另一张 RT，避免同时读写同一纹理
    this._currPaintRT = prevRT;

    // —— 2. 计算笔刷半径 ——
    // 鼠标速度 = 这一帧移动的像素距离；映射到 [minRadius, maxRadius]
    // 默认速度为 0（首帧或未初始化时）
    let speed = 0;
    if (this._hasPrevMouse) {
      // 本帧位移的欧氏长度（CSS 像素）
      speed = Math.hypot(
        mousePixel.x - this._prevMousePixel.x,
        mousePixel.y - this._prevMousePixel.y
      );
    }
    // 记录本帧鼠标位置供下一帧求速度
    this._prevMousePixel.set(mousePixel.x, mousePixel.y);
    // 标记已有基准
    this._hasPrevMouse = true;

    // 速度 → 半径的线性映射
    let radius = fit(speed, 0, this.radiusDistanceRange, this.minRadius, this.maxRadius);

    // 指针没动 → 半径归零：不注入新墨，但已有速度继续平流
    if (!hadMoved) radius = 0;

    // 从 CSS 像素换算到 paint RT 像素
    radius = (radius / this.height) * paintH;

    // —— 3. 更新 uniform ——
    // 主模拟材质 uniform 短引用
    const u = this._paintMaterial.uniforms;
    // 回推强度
    u.u_pushStrength.value = this.pushStrength;
    // 噪声缩放
    u.u_curlScale.value = this.curlScale;
    // 涡流强度
    u.u_curlStrength.value = this.curlStrength;
    // 停手后：u_active 归零（关掉推进速度），残留速度额外衰减，墨迹改为向外扩散
    // idle 从 0→1，所以 u_active 从 1→0
    u.u_active.value = 1 - idle;
    // 额外衰减系数从 1 线性降到 (1 - idleDampingStrength)
    u.u_idleDamping.value = 1 - this.idleDampingStrength * idle;
    // 扩散强度
    u.u_idleSpread.value = this.idleSpread;
    // 三个通道的衰减系数打包成 vec3
    u.u_dissipations.value.set(
      this.velocityDissipation,
      this.weight1Dissipation,
      this.weight2Dissipation
    );

    // from = 上一帧的 to；to = 本帧鼠标位置
    // 这样连续帧之间首尾相接，笔画不会断层
    this._fromDrawData.copy(this._toDrawData);

    // NDC [-1,1] → paint 像素坐标 x
    const toX = (mouseNDC.x + 1) * paintW / 2;
    // NDC [-1,1] → paint 像素坐标 y
    const toY = (mouseNDC.y + 1) * paintH / 2;
    // 写入终点：位置 + 半径 + w=1
    this._toDrawData.set(toX, toY, radius, 1);

    // 速度累积：新速度 = 旧速度 × 0.8 + 本帧位移 × dt × 0.8
    // 本帧笔画位移 x
    const dx = this._toDrawData.x - this._fromDrawData.x;
    // 本帧笔画位移 y
    const dy = this._toDrawData.y - this._fromDrawData.y;
    // 旧速度先按 accelerationDissipation 衰减（保留少量惯性）
    this._vel.multiplyScalar(this.accelerationDissipation);
    // 叠加本帧位移（乘 dt 使注入量与帧率无关）
    this._vel.x += dx * dt * 0.8;
    // 同理 y
    this._vel.y += dy * dt * 0.8;

    // useNoise 切换时重编译 shader
    if (this._useNoise !== this.useNoise) {
      // 改编译期宏
      this._paintMaterial.defines.USE_NOISE = this.useNoise ? 1 : 0;
      // 标记需要重新编译
      this._paintMaterial.needsUpdate = true;
      // 记录当前状态
      this._useNoise = this.useNoise;
    }

    // 绑定上一帧 paint 作为平流输入
    u.u_prevPaintTexture.value = this._prevPaintRT.texture;
    // 执行主模拟 pass，写入当前帧 RT
    this._render(this._paintMaterial, this._currPaintRT);

    // —— 4. 把结果降到 1/8 并模糊，供下一帧做平流回溯 ——
    // 先拷贝到低分辨率 RT（paint 与 low 尺寸不同，采样即降采样）
    this._copy(this._currPaintRT.texture, this._lowRT);
    // 再做双向 9-tap 模糊
    this._blurLow();
  }

  /** 低分辨率速度场的双向 9-tap 模糊（水平 → 临时 RT，垂直 → 回到 low） */
  _blurLow() {
    // 单侧总偏移 8 个 texel（9 个采样点覆盖 ±8）
    const delta = 8; // 原站 blur(8, ...)
    // 缩放系数 0.25：把 8 个 texel 缩到实际使用的 2 个 texel 步长
    const c = 0.25;
    // 模糊材质 uniform 短引用
    const blur = this._blurMaterial.uniforms;

    // 第一遍：水平模糊，输入 low
    blur.u_texture.value = this._lowRT.texture;
    // 水平方向偏移（除以宽度转成 UV；y 分量为 0）
    blur.u_delta.value.set((delta / this._lowRT.width) * c, 0);
    // 输出到临时 RT
    this._render(this._blurMaterial, this._lowBlurRT);

    // 第二遍：垂直模糊，输入临时 RT
    blur.u_texture.value = this._lowBlurRT.texture;
    // 垂直方向偏移（x 分量为 0）
    blur.u_delta.value.set(0, (delta / this._lowRT.height) * c);
    // 结果写回 low（两遍分离高斯 ≈ 9×9 模糊）
    this._render(this._blurMaterial, this._lowRT);
  }

  /** 全屏拷贝（用于 paint → low） */
  _copy(sourceTexture, targetRT) {
    // 绑定源纹理
    this._copyMaterial.uniforms.u_texture.value = sourceTexture;
    // 渲染到目标 RT
    this._render(this._copyMaterial, targetRT);
  }

  /** 执行一次 fullscreen pass，并恢复原来的 render target */
  _render(material, targetRT) {
    // 渲染器引用
    const renderer = this.renderer;
    // 保存当前 RT，pass 结束后恢复
    const prevRT = renderer.getRenderTarget();

    // 切换共享 quad 的材质
    this._quadMesh.material = material;
    // 绑定目标 RT
    renderer.setRenderTarget(targetRT);
    // 渲染全屏三角形
    renderer.render(this._quadScene, this._quadCamera);
    // 恢复原来的 RT
    renderer.setRenderTarget(prevRT);
  }

  /** 当前 paint 纹理 —— 交给 ScreenPaintDistortion 做屏幕折射 */
  get texture() {
    // 返回当前帧 RT 的纹理（ping-pong 每帧交换 RT 实例）
    return this._currPaintRT.texture;
  }

  /** paint 纹理尺寸（1 像素对应的 UV，失真 pass 需要） */
  get texelSize() {
    // 每帧由 ScreenPaintDistortion 读取，尺寸变化时无需重新绑定纹理
    return this._texelSize;
  }

  dispose() {
    // 释放四张 RT
    this._currPaintRT.dispose();
    this._prevPaintRT.dispose();
    this._lowRT.dispose();
    this._lowBlurRT.dispose();
    // 释放三套材质
    this._paintMaterial.dispose();
    this._blurMaterial.dispose();
    this._copyMaterial.dispose();
    // 释放共享全屏几何体
    this._quadGeo.dispose();
    // 断引用，便于 GC
    this._quadScene = null;
    // 断引用
    this._quadMesh = null;
    // 断引用
    this._quadCamera = null;
  }
}
